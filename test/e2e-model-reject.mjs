// 实测：填不存在的模型名现在应该被明确拒绝，不再偷偷换模型
const base = 'http://127.0.0.1:57282';
// /api/keys 返回的是脱敏串（含 •••• 这种非 ASCII 字符），不能当请求头用；
// 测试要走 reveal 拿明文。
const revealed = await fetch(`${base}/api/keys/reveal`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
const key = revealed.key;
if (!/^[\x20-\x7e]+$/.test(key || '')) {
  console.error('reveal 出来的密钥仍含非 ASCII:', JSON.stringify(key));
  process.exit(1);
}

async function ask(model) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  return { status: res.status, error: body.error?.message, type: body.error?.type };
}

console.log('=== model="deepseek"（目录里不存在）===');
const r1 = await ask('deepseek');
console.log('HTTP', r1.status, '| type:', r1.type);
console.log('message:', r1.error);
console.log(r1.status === 400 ? '\n✔ 已明确拒绝，不再偷偷换模型执行' : '\n✘ 仍然被执行了');

console.log('\n=== 确认没有产生新的计费记录 ===');
await new Promise((r) => setTimeout(r, 800));
const s = await fetch(`${base}/api/state`).then((r) => r.json());
const last = s.logs[s.logs.length - 1];
console.log('最后一条日志:', JSON.stringify({
  model: last?.model, status: last?.status, credit: last?.credit, err: String(last?.error || '').slice(0, 50),
}));
