// 验证：去掉冷却后，额度耗尽的账号不会拖慢每次请求。
// 关键点在于 pick() 的排序——失败的号排后面，健康号优先。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-order-'));

const { normalizeConfig } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');

const config = normalizeConfig({ port: 0 });
const pool = new Pool(config);
pool.store.accounts = [
  { id: 'exhausted', uid: 'u1', nickname: '额度用尽', domain: 'copilot.tencent.com', accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86400000, accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, createdAt: 1, updatedAt: 1 },
  { id: 'healthy', uid: 'u2', nickname: '健康', domain: 'copilot.tencent.com', accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86400000, accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, createdAt: 1, updatedAt: 1 },
];
pool.reindex();

console.log('=== 初始：两个都健康，按 lastUsedAt 轮换 ===');
console.log('第一次选中:', pool.pick()?.id);

console.log('\n=== 让「额度用尽」记一次失败（模拟 429/6004）===');
pool.markFailure(pool.get('exhausted'), { kind: 'quota', retryable: true }, '额度超出频率限制，18:32 重置', Date.now() + 270 * 60_000);

console.log('失败后状态:', pool.stateOf(pool.get('exhausted')), '(应为 available，不封锁)');

// 连续选 10 次，健康的应该总是优先
let healthyFirst = 0;
for (let i = 0; i < 10; i++) {
  const picked = pool.pick();
  if (picked.id === 'healthy') healthyFirst += 1;
  pool.runtimeOf(picked.id).lastUsedAt = Date.now(); // 模拟用过
}
console.log(`连选 10 次，健康号被选中 ${healthyFirst}/10 次`);

console.log('\n=== 健康号也失败后，两者都可用（都能被选中）===');
pool.markFailure(pool.get('healthy'), { kind: 'server', retryable: true }, 'boom');
const picks = new Set();
for (let i = 0; i < 6; i++) {
  const p = pool.pick();
  picks.add(p?.id);
  pool.runtimeOf(p.id).lastUsedAt = i; // 制造时间差
}
console.log('两个号都失败后仍能被选中:', [...picks].join(', '), '(说明没有封锁)');

console.log('\n=== 复位后立刻恢复优先 ===');
pool.clearError(pool.get('exhausted'));
pool.runtimeOf('exhausted').lastUsedAt = 0;
pool.runtimeOf('healthy').lastUsedAt = Date.now();
console.log('复位「额度用尽」后，下一次选中:', pool.pick()?.id);
