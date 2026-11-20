// 探针：上游是否真的接受 reasoning_effort，以及不同档位有没有实际差异。
// 这是"思考强度"能不能做成真实功能的判定依据，不能只显示不动。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTH = join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const doc = JSON.parse(readFileSync(AUTH, 'utf8'));
const token = doc.auth.accessToken;
const uid = doc.account.uid;
const domain = doc.auth.domain || '';

async function send(label, extra) {
  const body = {
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 200,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '9.11 和 9.9 哪个大？只说答案。' },
    ],
    ...extra,
  };
  const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
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
      'X-Conversation-ID': randomUUID(),
      'X-Conversation-Request-ID': randomUUID(),
      'X-Conversation-Message-ID': randomUUID(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let code;
    try { code = JSON.parse(text).code; } catch { /* ignore */ }
    console.log(`${label.padEnd(34)} -> ${res.status}${code ? '/' + code : ''}`);
    return;
  }

  const text = await res.text();
  let reasoningTokens = 0;
  let content = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    try {
      const ev = JSON.parse(raw);
      const d = ev.choices?.[0]?.delta;
      if (d?.content) content += d.content;
      if (ev.usage?.completion_tokens_details?.reasoning_tokens) {
        reasoningTokens = ev.usage.completion_tokens_details.reasoning_tokens;
      }
      if (ev.usage?.completion_thinking_tokens) reasoningTokens = ev.usage.completion_thinking_tokens;
    } catch { /* ignore */ }
  }
  console.log(`${label.padEnd(34)} -> 200  思考token=${String(reasoningTokens).padStart(3)}  回答=${JSON.stringify(content.slice(0, 24))}`);
}

console.log('=== reasoning_effort 是否被接受、是否有差异 ===');
await send('不传 reasoning_effort（默认）', {});
await send('reasoning_effort: low', { reasoning_effort: 'low' });
await send('reasoning_effort: high', { reasoning_effort: 'high' });
await send('reasoning_effort: max', { reasoning_effort: 'max' });
await send('reasoning_effort: medium（不支持）', { reasoning_effort: 'medium' });
await send('reasoning_effort: 乱填', { reasoning_effort: 'bogus' });

console.log('\n=== 关闭思考 ===');
await send('thinking: {type: disabled}', { thinking: { type: 'disabled' } });
await send('enable_thinking: false', { enable_thinking: false });
await send('reasoning_effort: none', { reasoning_effort: 'none' });

console.log('\n=== 上下文档位是否可指定 ===');
await send('max_input_tokens: 200000', { max_input_tokens: 200000 });
await send('不传（默认 300K）', {});
