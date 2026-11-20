// 端到端：客户端带一堆非标准字段时，网关能否靠「瘦身重试」救回来。
// 这是 13:06 那两条 400 的复现与修复验证。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-slim-'));
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

// 模拟一个"加了料的"客户端：这些字段在真实 SDK 里很常见
const naughty = {
  model: 'deepseek-v4.1-flash',
  stream: false,
  max_tokens: 40,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: '说两个字：你好' },
  ],
  // 以下是各家 SDK 的私货，上游不认
  metadata: { trace: 'abc' },
  store: false,
  service_tier: 'auto',
  parallel_tool_calls: true,
  prompt_cache_key: 'k1',
  safety_identifier: 'u1',
};

const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: auth, body: JSON.stringify(naughty),
});
const body = await res.json();
console.log('状态:', res.status);
if (res.status === 200) {
  console.log('回复:', JSON.stringify(body.choices?.[0]?.message?.content));
} else {
  console.log('错误:', body.error?.message);
}

const logs = await fetch(`${base}/api/logs?limit=5`).then((r) => r.json());
console.log('最近日志:');
for (const entry of logs.logs.slice(0, 3)) {
  console.log(`  ${entry.status} ${entry.model} ${entry.error ? '[' + entry.error.slice(0, 100) + ']' : ''}`);
}

// 期望：能救回来（200），或者至少错误信息带 code 而不是光一句英文
console.log(res.status === 200 ? '\n✔ 瘦身后成功' : '\n✘ 仍然失败');

server.close();
process.exit(0);
