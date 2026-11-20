// 真实客户端场景自测：用「带长系统提示 + 身份短语 + 多轮历史」的请求打网关，
// 这才是真实客户端（Cline / DSH / Cherry Studio）的形状。
// 只发短提示的测试会全部通过，那样等于没测。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-real-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
if (scanned.length === 0) { console.log('本机没有 WorkBuddy 登录态，跳过'); process.exit(0); }
pool.store = mergeScanned(pool.store, scanned).store;
pool.persist();

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

// 真实客户端的系统提示形状：含实测会被 11128 拒的身份短语 + 跨句组合
const SYSTEM_PROMPT = [
  'You are an AI agent powered by DeepSeek Harness. You are a coding agent powered by the deepseek-v4.1-flash model.',
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;',
  'absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter.',
  'Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading.',
].join(' ');

const HISTORY = [
  { role: 'user', content: '帮我看看这个项目是做什么的' },
  { role: 'assistant', content: '这是一个价格监控项目。' },
];

async function chatStream(messages, maxTokens = 40) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
  const raw = await res.text();
  let content = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    try { content += JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch {}
  }
  return { ok: true, status: res.status, content, chunks: raw.split('\n').filter((l) => l.startsWith('data:')).length };
}

let failed = 0;
function report(label, result, expectOk = true) {
  const good = result.ok === expectOk;
  if (!good) failed += 1;
  const info = result.ok ? JSON.stringify(result.content?.slice(0, 40)) : `${result.status} ${result.body}`;
  console.log(`${good ? '✔' : '✘'} ${label.padEnd(34)} ${info}`);
}

console.log('=== 真实客户端形状 ===');

// 1. 只有 system + user（最常见）
let r = await chatStream([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '用一句话说明你的角色' }]);
report('长系统提示（含身份短语）', r);

// 2. 长系统提示 + 多轮历史
r = await chatStream([{ role: 'system', content: SYSTEM_PROMPT }, ...HISTORY, { role: 'user', content: '继续，再说一句' }]);
report('长系统提示 + 多轮历史', r);

// 3. assistant 历史里也带身份短语（插件 issue #98 的坑）
const poisoned = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'assistant', content: 'You are an AI agent powered by DeepSeek Harness.' },
  { role: 'user', content: '说一个字' },
];
r = await chatStream(poisoned);
report('assistant 历史含身份短语', r);

// 4. 工具调用 + 长系统提示
r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash', stream: false, max_tokens: 150,
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '深圳天气怎么样？用工具查。' }],
  }),
}).then(async (res) => ({ ok: res.ok, status: res.status, content: JSON.stringify((await res.json()).choices?.[0]?.message?.tool_calls) }));
report('长系统提示 + 工具调用', r);

// 5. developer 角色
r = await chatStream([{ role: 'developer', content: 'You are an AI agent powered by DeepSeek Harness.' }, { role: 'user', content: '说一个字' }]);
report('developer 角色 + 身份短语', r);

// 6. 正常短对话（对照组，必须一直可用）
r = await chatStream([{ role: 'user', content: '说一个字：好' }]);
report('短对话（对照组）', r);

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);

const state = await fetch(`${base}/api/state`).then((x) => x.json());
console.log('账号状态:', state.accounts.map((a) => `${a.nickname}:${a.state}`).join(', '));
console.log('日志:', state.logs.slice(0, 6).map((l) => `${l.status}${l.error ? '/ERR' : ''} ${l.model}`).join(' | '));

server.close();
process.exit(failed === 0 ? 0 : 1);
