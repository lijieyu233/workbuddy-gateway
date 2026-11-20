// 模型名不存在时，绝不偷偷换模型执行。
//
// 实测事故：客户端填 "deepseek"（目录里不存在），旧代码自动改成
// deepseek-v4.1-flash 重试并成功了，扣了 2.13 credit，日志只记原始名字。
// 用户以为在用自己指定的模型，实际用了另一个——倍率和能力都不同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-modelnotfound-'));

const { normalizeConfig } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { ChatBridge } = await import('../src/bridge.js');

function makeBridge() {
  const config = normalizeConfig({ port: 0 });
  const pool = new Pool(config);
  pool.store.accounts = [{
    id: 'a1', uid: 'u1', nickname: '测试号', domain: 'www.workbuddy.cn',
    accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86400000,
    accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 },
    createdAt: 1, updatedAt: 1, lastError: '',
  }];
  pool.reindex();
  // catalog 是上游原始目录数组；启用状态在 modelSnapshot() 里，
  // 而它返回的是 Map（id → setting），和真实实现保持一致
  pool.catalog = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  ];
  pool.modelSnapshot = () => new Map(
    pool.catalog.map((m) => [m.id, { enabled: true, effectiveEffort: null }]),
  );
  // 上游一律回「模型不存在」，用来确认网关不会自己换名重试
  const calls = [];
  pool.upstream = {
    chat: async (account, body) => {
      calls.push(body.model);
      const payload = { code: 11102, msg: `model [${body.model}] service info not found` };
      return {
        ok: false,
        status: 400,
        payload,
        text: JSON.stringify(payload),
        // bridge 依赖上游给出的分类；这里模拟"请求级失败"（换号也没用）
        classification: { kind: 'request', accountScoped: false, reason: '模型不存在' },
        response: { text: async () => JSON.stringify(payload) },
      };
    },
  };
  const log = { push() {}, items: [] };
  return { bridge: new ChatBridge({ pool, log, config }), calls };
}

test('模型名不存在：直接 400，不偷偷换成别的模型执行', async () => {
  const { bridge, calls } = makeBridge();
  const result = await bridge.chat({
    body: { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(result.status, 400, '应该是 400，而不是 200');
  assert.equal(result.body?.error?.type, 'model_not_found');
  assert.match(result.body?.error?.message || '', /不存在/);

  // 关键断言：只尝试了用户填的那一个名字，没有拿别的模型去试
  assert.deepEqual(calls, ['deepseek'], `不该改用其它模型，实际调用了：${JSON.stringify(calls)}`);
});

test('模型名不存在：错误信息里列出可用 id，用户知道该填什么', async () => {
  const { bridge } = makeBridge();
  const result = await bridge.chat({
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  });
  const message = result.body?.error?.message || '';
  assert.match(message, /deepseek-v4\.1-flash/, '要提示可用模型');
  assert.match(message, /glm-5\.3-flash/);
});

test('显示名（大小写不同）仍能正确映射，属于正常功能不是替换', async () => {
  const { bridge, calls } = makeBridge();
  // 上游替身只回"模型不存在"，所以这里看的是：传给上游的是不是映射后的 id
  await bridge.chat({ body: { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] } });
  assert.deepEqual(calls, ['glm-5.3-flash'], '显示名应映射成 id，这不是"换模型"');
});
