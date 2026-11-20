// 回归：客户端取消不能被当成账号故障。
//
// 这是真实踩到的坑：WorkBuddy AI 里点停止/关页面，网关记录「流中断，aborted」，
// 然后把账号冷却 1 分钟；下一次请求就 503「没有可用账号（可用 0/1，冷却 1）」。
// 用户看到的是「服务暂时不可用，请稍后重试」，而账号其实一直是好的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-abort-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');

/**
 * 假上游：先吐一块，然后**一直挂着**。
 *
 * 刻意不监听 signal：真实上游在客户端断开时不会立刻结束响应体，
 * 网关必须自己处理挂起的 read()。让假上游听 signal 就 close 会掩盖泄漏
 * （最早那版诊断脚本就是这样自己骗自己的）。
 */
function fakeUpstream({ hang = true } = {}) {
  return {
    async chat(account, body) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ id: 'x', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '第一个字' }, finish_reason: null }] })}\n\n`,
          ));
          if (!hang) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          try { controller.close(); } catch { /* ignore */ }
        },
      });
      return { ok: true, response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }) };
    },
    async probe() { return { ok: true, response: { text: async () => '' } }; },
    async fetchCatalog() { return [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }]; },
  };
}

test('对照组：正常读完的流式请求，额度也要归还', async (t) => {
  const config = normalizeConfig({ port: 0 });
  ensureApiKey(config);
  const pool = new Pool(config);
  pool.store.accounts = [{
    id: 'acc-ok-0003', uid: 'u3', nickname: '正常号', domain: 'copilot.tencent.com',
    accessToken: 'token', refreshToken: '', expiresAtMs: Date.now() + 86_400_000,
    accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, disabled: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  }];
  pool.reindex();
  pool.catalog = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }];
  pool.upstream = fakeUpstream({ hang: false });

  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const key = config.apiKeys[0].key;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('第一个字'), `应收到正文，实际(${text.length}B)：${text.slice(0, 300)}`);
  assert.ok(text.includes('[DONE]'));
  assert.equal(pool.runtimeOf('acc-ok-0003').inflight, 0, '正常结束后额度必须归还');
  assert.equal(pool.get('acc-ok-0003').stats.requests, 1, '正常完成应记一次成功');
});

test('客户端中途断开：账号不应被冷却', async (t) => {
  const config = normalizeConfig({ port: 0, failureCooldownMs: 60_000 });
  ensureApiKey(config);
  const pool = new Pool(config);
  pool.store.accounts = [{
    id: 'acc-test-0001', uid: 'u1', nickname: '测试号', domain: 'copilot.tencent.com',
    accessToken: 'token', refreshToken: '', expiresAtMs: Date.now() + 86_400_000,
    accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, disabled: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  }];
  pool.reindex();
  pool.catalog = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }];
  pool.upstream = fakeUpstream();

  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const key = config.apiKeys[0].key;
  // 用裸 socket 发请求，这样才能真的把连接掐断。
  // 用 fetch + AbortController 模拟不了：那只是停止消费，TCP 连接还在，
  // 服务端根本感知不到客户端已经走了（这一点实测踩过，会得出「没泄漏」的假结论）。
  const net = await import('node:net');
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));

  const payload = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  socket.write(
    `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${key}\r\n`
    + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
  );

  let received = '';
  // 等到真的收到 SSE 正文再断开。只等第一个 'data' 事件是不够的：
  // 那可能只拿到 HTTP 响应头，此时服务端还没进流式循环，
  // 断开就测不到真正的"流到一半客户端跑了"（会假通过）。
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等不到 SSE 正文，已收到 ${received.length} 字节：${received.slice(0, 200)}`)), 5000);
    const onData = (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('"choices"')) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve();
      }
    };
    socket.on('data', onData);
  });
  assert.ok(received.length > 0, `应该已经收到服务端的流式数据，实际：${received.slice(0, 300)}`);
  // 真实断开
  socket.destroy();
  // 等释放完成：服务端要先收到 close、再跑 finally 还额度。
  // 用轮询而不是固定 sleep —— 固定值要么慢要么在慢机器上假通过。
  const deadline = Date.now() + 5000;
  while (pool.runtimeOf('acc-test-0001').inflight !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const waitedMs = Date.now() - (deadline - 5000);
  assert.ok(waitedMs < 5000, `额度必须在 5 秒内释放，实际等了 ${waitedMs}ms`);

  const account = pool.get('acc-test-0001');
  const runtime = pool.runtimeOf('acc-test-0001');
  assert.equal(runtime.cooldownUntil, 0, '客户端取消不该设置冷却时间');
  assert.equal(account.stats.failures, 0, '客户端取消不该记成账号失败');
  assert.equal(runtime.inflight, 0, '并发计数必须释放，否则账号会被慢慢堵死');
  assert.equal(pool.stateOf(account), 'available', '账号状态应保持可用');

  // 冷却没被设置，下一次请求必须能选到它
  const next = pool.pick();
  assert.equal(next?.id, 'acc-test-0001', '下一次请求应能正常选到这个账号');
});

test('上游真中断（非客户端取消）仍然要记失败，但不再冷却', async (t) => {
  const config = normalizeConfig({ port: 0, failureCooldownMs: 60_000 });
  ensureApiKey(config);
  const pool = new Pool(config);
  pool.store.accounts = [{
    id: 'acc-test-0002', uid: 'u2', nickname: '测试号2', domain: 'copilot.tencent.com',
    accessToken: 'token', refreshToken: '', expiresAtMs: Date.now() + 86_400_000,
    accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, disabled: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  }];
  pool.reindex();
  pool.catalog = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }];
  // 上游直接抛网络错误
  pool.upstream = {
    async chat() { throw new Error('socket hang up'); },
    async probe() { return { ok: true, response: { text: async () => '' } }; },
    async fetchCatalog() { return []; },
  };

  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const key = config.apiKeys[0].key;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  // 唯一的号挂了 → 用尽重试后仍然失败
  assert.equal(res.status, 503);
  const account = pool.get('acc-test-0002');
  const runtime = pool.runtimeOf('acc-test-0002');
  // 冷却已按要求去掉：失败只记录，不封锁。
  // 但失败必须被记下来——否则面板上看不出这个号刚刚坏过。
  assert.equal(runtime.cooldownUntil, 0, '不该再有冷却时间');
  assert.ok(runtime.lastError.includes('socket hang up'), `应记录真实原因，实际：${runtime.lastError}`);
  assert.equal(account.stats.failures, 1);
  assert.equal(pool.stateOf(account), 'available', '冷却去掉后账号状态仍是可用');
});
