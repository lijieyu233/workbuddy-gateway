// 探针：读取本机 WorkBuddy 登录态，抓一次最小 chat SSE，确认上游真实线格式与 usage/quota 字段。
// 只用于开发期联调，不进发布包。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTH = join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const doc = JSON.parse(readFileSync(AUTH, 'utf8'));
const token = doc.auth.accessToken;
const uid = doc.account.uid;
const domain = doc.auth.domain || '';
const chatBase = 'https://copilot.tencent.com';

const conv = () => ({
  'X-Conversation-ID': randomUUID(),
  'X-Conversation-Request-ID': randomUUID(),
  'X-Conversation-Message-ID': randomUUID(),
});

const res = await fetch(`${chatBase}/v2/chat/completions`, {
  method: 'POST',
  headers: {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'Content-Type': 'application/json',
    'X-User-Id': uid,
    'X-No-Enterprise-Id': '1',
    'X-Domain': domain,
    'X-Product': 'SaaS',
    ...conv(),
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    model: process.env.PROBE_MODEL || 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 32,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'reply with the single word: pong' },
    ],
  }),
});

console.log('status', res.status);
const text = await res.text();
for (const line of text.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const data = line.slice(5).trim();
  if (data === '[DONE]') { console.log('=== [DONE]'); continue; }
  let ev;
  try { ev = JSON.parse(data); } catch { console.log('non-json:', data.slice(0, 120)); continue; }
  if (ev.usage) { console.log('=== usage event ==='); console.log(JSON.stringify(ev.usage, null, 2)); }
  if (ev.choices?.[0]?.delta?.tool_calls?.length) console.log('TOOL_DELTA', JSON.stringify(ev.choices[0].delta.tool_calls));
}
