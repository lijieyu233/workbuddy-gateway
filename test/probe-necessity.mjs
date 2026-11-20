// 反向验证：证明「净化」是功能可用的必要条件，而不是巧合。
// 同一份请求，不净化 → 应被 11128 拒；净化后 → 应 200。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Upstream, shapeChatBody } from '../src/upstream.js';

const AUTH = join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const doc = JSON.parse(readFileSync(AUTH, 'utf8'));
const account = {
  accessToken: doc.auth.accessToken,
  refreshToken: doc.auth.refreshToken,
  domain: doc.auth.domain,
  uid: doc.account.uid,
};

const SYSTEM = 'You are an AI agent powered by DeepSeek Harness. Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;';

const raw = {
  model: 'deepseek-v4.1-flash',
  stream: true,
  max_tokens: 8,
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '说一个字：好' },
  ],
};

const client = new Upstream();

const plain = await client.chat(account, raw);
console.log('不净化 ->', plain.ok ? 'OK' : `${plain.status}/${plain.payload?.code}`);
if (plain.ok) await plain.response.text();

const shaped = await client.chat(account, shapeChatBody(raw));
console.log('净化后 ->', shaped.ok ? 'OK' : `${shaped.status}/${shaped.payload?.code}`);
if (shaped.ok) await shaped.response.text();

const verdict = !plain.ok && plain.payload?.code === 11128 && shaped.ok;
console.log(verdict ? '\n✔ 已证明：净化是必需的（不净化被拒，净化后通过）' : '\n✘ 结论不成立，需要复查');
process.exit(verdict ? 0 : 1);
