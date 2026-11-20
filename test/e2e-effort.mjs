// 端到端验证：面板上的「思考强度」设置是否真的改变了上游返回的思考量。
// 这是本次功能的验收标准——如果只是界面高亮而请求体没变，那就等于假开关。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-effort-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
if (scanned.length === 0) { console.log('本机没有登录态，跳过'); process.exit(0); }
pool.store = mergeScanned(pool.store, scanned).store;
pool.reindex();
pool.persist();

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

await fetch(`${base}/api/catalog/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const MODEL = 'deepseek-v4.1-flash';

async function run(label) {
  const res = await fetch(`${base}/api/models/test`, {
    method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.log(`${label.padEnd(22)} -> 失败 ${err?.error?.message || res.status}`);
    return undefined;
  }
  const r = await res.json();
  console.log(`${label.padEnd(22)} -> 首字 ${String(r.firstTokenMs).padStart(5)}ms · 总 ${String(r.totalMs).padStart(5)}ms · 思考 ${String(r.reasoningTokens).padStart(3)} token · 答案 ${JSON.stringify(r.answer)} · 应用=${JSON.stringify(r.applied)}`);
  return r;
}

console.log('=== 同一模型，改思考强度，看上游思考量是否变化 ===');
await run('默认（上游 high）');

await fetch(`${base}/api/models/settings`, {
  method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL, reasoningEffort: 'low' }),
});
await run('设置为 low');

await fetch(`${base}/api/models/settings`, {
  method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL, reasoningEffort: 'max' }),
});
await run('设置为 max');

await fetch(`${base}/api/models/settings`, {
  method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL, disableThinking: true }),
});
await run('关闭思考');

// 恢复默认，避免留下测试状态
await fetch(`${base}/api/models/settings`, {
  method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL, disableThinking: false, reasoningEffort: null }),
});

console.log('\n=== 非法档位应被拒绝（不能只是界面挡住）===');
const bad = await fetch(`${base}/api/models/settings`, {
  method: 'POST', headers: auth, body: JSON.stringify({ modelId: MODEL, reasoningEffort: 'bogus' }),
});
const badBody = await bad.json();
console.log(`reasoningEffort=bogus -> 保存为 ${JSON.stringify(badBody.setting?.reasoningEffort)}（应为 null）`);

server.close();
process.exit(0);
