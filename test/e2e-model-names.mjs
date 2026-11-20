// 模型名兼容性实测：重名显示名应报歧义并列出候选，唯一名仍能正确映射。
const base = 'http://127.0.0.1:57282';
const key = (await fetch(`${base}/api/keys/reveal`, { method: 'POST', body: '{}' })).ok
  ? (await (await fetch(`${base}/api/keys/reveal`, { method: 'POST', body: '{}' })).json()).key
  : undefined;

async function ask(label, model) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  const msg = body.error?.message || body.choices?.[0]?.message?.content || '';
  console.log(`${label.padEnd(28)} -> ${res.status}  ${String(msg).slice(0, 90)}`);
  return res.status;
}

console.log('=== 重名显示名（目录里 5 个模型都叫 Hy4 preview）===');
const s1 = await ask('Hy4 preview', 'Hy4 preview');
const s2 = await ask('Hy3（重名）', 'Hy3');

console.log('\n=== 唯一显示名仍可用 ===');
const s3 = await ask('DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash');

console.log('\n=== 直接给 id 永远可用 ===');
const s4 = await ask('hy4-preview-x（id）', 'hy4-preview-x');

console.log('\n期望：前两个 400 并带候选 id；后两个正常（或上游限额，但不是 400 ambiguous）');
console.log(s1 === 400 && s2 === 400 ? '✔ 重名已明确报歧义' : '✘ 重名处理不符合预期');
