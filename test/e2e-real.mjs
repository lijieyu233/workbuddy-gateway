// 真实链路自测：隔离 HOME 启动网关 → 导入本机 WorkBuddy 登录态 → 通过 /v1 打一次真请求。
// 会真实消耗一次额度（约 20 token），只在开发机手动跑。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-e2e-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
const merged = mergeScanned(pool.store, scanned);
pool.store = merged.store;
pool.persist();
console.log(`扫描 ${scanned.length} 个登录态，新增 ${merged.added}`);

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

console.log('pool =', pool.summary());

// 1) 模型目录
let r = await fetch(`${base}/api/catalog/refresh`, { method: 'POST', body: '{}' });
const catalog = await r.json();
console.log('模型数量 =', catalog.count, '前三个 =', (catalog.models || []).slice(0, 3).map((m) => m.id).join(','));

// 2) 流式 chat
r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 32,
    messages: [{ role: 'user', content: '用两个字回答：你好吗' }],
  }),
});
console.log('stream status =', r.status, r.headers.get('content-type'));
const text = await r.text();
const chunks = text.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'));
console.log('chunk 数 =', chunks.length);
console.log('首块 =', chunks[0]?.slice(0, 200));
console.log('末块 =', chunks.at(-1)?.slice(0, 320));

// 3) 非流式 chat（网关侧聚合）
r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: false,
    max_tokens: 32,
    messages: [{ role: 'user', content: '用两个字回答：再见' }],
  }),
});
const completion = await r.json();
console.log('非流式 status =', r.status, '| content =', JSON.stringify(completion.choices?.[0]?.message?.content), '| usage =', JSON.stringify(completion.usage));

// 4) 工具调用（非流式聚合看 tool_calls 是否成形）
r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: false,
    max_tokens: 200,
    tools: [{
      type: 'function',
      function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    }],
    messages: [{ role: 'user', content: '深圳天气如何？调用工具。' }],
  }),
});
const toolCompletion = await r.json();
console.log('工具调用 =', JSON.stringify(toolCompletion.choices?.[0]?.message?.tool_calls), '| finish =', toolCompletion.choices?.[0]?.finish_reason);

// 5) /v1/responses
r = await fetch(`${base}/v1/responses`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: '回答一个字：好' }),
});
const resp = await r.json();
console.log('responses =', JSON.stringify(resp.output?.[0]?.content?.[0]?.text), '| usage =', JSON.stringify(resp.usage));

// 6) 面板状态与日志
const state = await fetch(`${base}/api/state`).then((x) => x.json());
console.log('面板 pool =', state.pool);
console.log('日志条数 =', state.logs.length, '最近一条 =', JSON.stringify(state.logs[0]));
console.log('账号状态 =', state.accounts.map((a) => `${a.nickname || a.id}:${a.state}:${JSON.stringify(a.quotaByModel)}`).join(' | '));

server.close();
process.exit(0);
