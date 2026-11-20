// 验证零宽字符「夹在两个单词内部」的变体：净化后词会粘连，它其实能过网关。
// 这条单独留着，因为它是唯一需要「删掉零宽而不是补空格」的分支。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeText } from '../src/sanitize.js';

const AUTH = join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const doc = JSON.parse(readFileSync(AUTH, 'utf8'));

async function probe(systemText) {
  const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.codebuddy.cn',
      Referer: 'https://www.codebuddy.cn/',
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
      'Content-Type': 'application/json',
      'X-User-Id': doc.account.uid,
      'X-No-Enterprise-Id': '1',
      'X-Domain': doc.auth.domain,
      'X-Product': 'SaaS',
      'X-Conversation-ID': randomUUID(),
      'X-Conversation-Request-ID': randomUUID(),
      'X-Conversation-Message-ID': randomUUID(),
      Authorization: `Bearer ${doc.auth.accessToken}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash', stream: true, max_tokens: 8,
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: '说一个字：好' }],
    }),
  });
  if (res.ok) { await res.text(); return 'OK'; }
  const text = await res.text();
  try { const j = JSON.parse(text); return `${res.status}/${j.code}`; } catch { return `${res.status}`; }
}

const cases = [
  'You are an AI agent powered by DeepSeek\u200b Harness.',
  'You are an AI agent powered by Deep\u200bSeek Harness.',
  'You are an AI agent powered by DeepSeek\u200bHarness.',
];

for (const raw of cases) {
  const fixed = sanitizeText(raw);
  const before = await probe(raw);
  const after = await probe(fixed);
  console.log(`${JSON.stringify(raw.replace(/\u200b/g, '<ZW>')).padEnd(46)} 原文=${before.padEnd(9)} 净化后=${after.padEnd(5)} ${JSON.stringify(fixed.slice(30, 60))}`);
}
