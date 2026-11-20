// 验证：空 messages 现在会被本地挡住，返回明确的中文错误，不发上游、不烧额度。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-valid-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
pool.store = mergeScanned(pool.store, scanned).store;
pool.reindex();
pool.persist();

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function ask(label, body) {
  const before = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const elapsed = Date.now() - before;
  const payload = await res.json();
  const msg = payload.error?.message || JSON.stringify(payload.choices?.[0]?.message?.content || '').slice(0, 40);
  console.log(`${label.padEnd(24)} -> ${res.status} ${elapsed}ms  ${msg}`);
  return res.status;
}

console.log('=== 空 messages：应本地秒拒（不发上游）===');
const status1 = await ask('空 messages', { model: 'deepseek-v4.1-flash', messages: [] });
const status2 = await ask('messages 非数组', { model: 'deepseek-v4.1-flash', messages: { a: 1 } });

console.log('\n=== 日志里应看到这两条被记为本地拒绝 ===');
const logs = await fetch(`${base}/api/logs?limit=5`).then((r) => r.json());
for (const entry of logs.logs.slice(0, 3)) {
  console.log(`  ${entry.status} accountId=${entry.accountId} ${entry.error?.slice(0, 50)}`);
}

const ok = status1 === 400 && status2 === 400;
console.log(ok ? '\n✔ 空/非法 messages 被本地挡住，不再浪费额度' : '\n✘ 未生效');

// 先关服务再退出：直接 process.exit 会留下未关闭的句柄，在 Windows 上会触发
// libuv 的 Assertion failed 崩溃（哪怕测试其实已经通过）。
await new Promise((resolve) => server.close(resolve));
process.exitCode = ok ? 0 : 1;
