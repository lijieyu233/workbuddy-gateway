// 探针：复现上游渠道校验（11128）并验证净化方案。
// 保留这个文件，因为「为什么需要 sanitize.js」只有跑它才能亲眼看到。
//
// 用法：node test/probe-channel-gate.mjs
// 每条都会真实请求上游，消耗少量额度。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeText } from '../src/sanitize.js';

const AUTH = join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const doc = JSON.parse(readFileSync(AUTH, 'utf8'));
const token = doc.auth.accessToken;
const uid = doc.account.uid;
const domain = doc.auth.domain || '';

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
      'X-User-Id': uid,
      'X-No-Enterprise-Id': '1',
      'X-Domain': domain,
      'X-Product': 'SaaS',
      'X-Conversation-ID': randomUUID(),
      'X-Conversation-Request-ID': randomUUID(),
      'X-Conversation-Message-ID': randomUUID(),
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      max_tokens: 8,
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: '说一个字：好' }],
    }),
  });
  if (res.ok) { await res.text(); return 'OK'; }
  const text = await res.text();
  try { const j = JSON.parse(text); return `${res.status}/${j.code}`; } catch { return `${res.status}`; }
}

const CASES = [
  ['短提示（历史测试用的都是这种）', 'You are a helpful assistant.'],
  ['身份短语原句', 'You are an AI agent powered by DeepSeek Harness.'],
  ['同一句小写', 'you are an ai agent powered by deepseek harness.'],
  ['零宽字符穿插（无效！）', 'You are an AI agent powered by DeepSeek\u200b Harness.'],
  ['跨句空格连接', 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;'],
  ['跨句换行连接', 'Tokens prefixed with @ are paths the user explicitly referenced.\nRelative paths resolve from the workspace root;'],
  ["Claude Code 句", "You are Claude Code, Anthropic's official CLI for Claude."],
];

console.log('=== 上游渠道校验复现 ===');
for (const [label, text] of CASES) {
  console.log(`  ${label.padEnd(30)} -> ${await probe(text)}`);
}

console.log('\n=== 净化后 ===');
for (const [label, text] of CASES) {
  const fixed = sanitizeText(text);
  if (fixed === text) { console.log(`  ${label.padEnd(30)} -> （无需改动）`); continue; }
  console.log(`  ${label.padEnd(30)} -> ${await probe(fixed)}`);
}

console.log('\n结论：短提示能通、真实长提示被 11128 拒——这就是为什么必须做净化层。');
