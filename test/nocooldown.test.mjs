// 冷却已取消：失败只记录原因、不封锁账号。
// 这里钉住两件事：
//   1. 失败后账号状态仍是「可用」，不会被冷却挡住；
//   2. 但选号时刚失败的号排在健康号后面，避免反复撞同一堵墙。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-nocooldown-'));

const { normalizeConfig } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');

function makePool(accounts) {
  const config = normalizeConfig({ port: 0 });
  const pool = new Pool(config);
  pool.store.accounts = accounts.map((id, index) => ({
    id, uid: id, nickname: `号${index + 1}`, domain: 'copilot.tencent.com',
    accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86_400_000,
    accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 },
    disabled: false, createdAt: Date.now(), updatedAt: Date.now(),
  }));
  pool.reindex();
  return pool;
}

test('失败不产生冷却：状态仍是可用', () => {
  const pool = makePool(['a1']);
  const account = pool.get('a1');
  pool.markFailure(account, { kind: 'quota', retryable: true }, '额度用完了', Date.now() + 3_600_000);

  const snapshot = pool.snapshot().find((item) => item.id === 'a1');
  assert.equal(snapshot.state, 'available', '失败不该把账号标成冷却');
  assert.equal(snapshot.cooldownRemainingMs, 0, '不应残留冷却时间');
  assert.equal(snapshot.lastError, '额度用完了', '失败原因要留着');
  assert.ok(snapshot.recoverAtMs > Date.now(), '上游给的恢复时间要保留（仅展示）');
  // 仍然是可选的
  assert.equal(pool.pick()?.id, 'a1');
});

test('汇总里不再有冷却计数，但有失败计数', () => {
  const pool = makePool(['a1', 'a2']);
  pool.markFailure(pool.get('a1'), { kind: 'server', retryable: true }, 'boom');
  const summary = pool.summary();
  assert.equal(summary.cooling, 0, '冷却恒为 0');
  assert.equal(summary.available, 2, '两个号都算可用');
  assert.equal(summary.failing, 1, '失败数单独统计');
});

test('选号：刚失败的号排在健康号后面', () => {
  const pool = makePool(['a1', 'a2']);
  // 让 a1 先被用过（lastUsedAt 更大），正常情况下 a2 优先；
  // 再让 a1 失败一次，它更应该排后面。
  pool.runtimeOf('a1').lastUsedAt = Date.now();
  pool.runtimeOf('a2').lastUsedAt = 0;
  assert.equal(pool.pick()?.id, 'a2');

  // 反过来：让 a2 失败，即使它是"更久没用过"的那个，也不该被优先选
  pool.markFailure(pool.get('a2'), { kind: 'server', retryable: true }, 'boom');
  pool.runtimeOf('a2').lastUsedAt = 0;
  pool.runtimeOf('a1').lastUsedAt = Date.now();
  assert.equal(pool.pick()?.id, 'a1', '健康号必须优先于失败的号');
});

test('复位会清掉失败记录，让它重新排到前面', () => {
  const pool = makePool(['a1', 'a2']);
  pool.markFailure(pool.get('a1'), { kind: 'server', retryable: true }, 'boom');
  assert.equal(pool.pick()?.id, 'a2');

  pool.clearError(pool.get('a1'));
  pool.runtimeOf('a1').lastUsedAt = 0;   // 更久没用过
  pool.runtimeOf('a2').lastUsedAt = Date.now();
  assert.equal(pool.pick()?.id, 'a1');
  const snapshot = pool.snapshot().find((item) => item.id === 'a1');
  assert.equal(snapshot.lastError, '', '复位后不该再有错误');
});

test('停用的账号仍然不被选中（这不是冷却，是显式停用）', () => {
  const pool = makePool(['a1', 'a2']);
  pool.updateAccount('a1', { disabled: true });
  assert.equal(pool.pick()?.id, 'a2');
  assert.equal(pool.snapshot().find((item) => item.id === 'a1').state, 'disabled');
});

test('配置里已经没有冷却项', () => {
  const config = normalizeConfig({ port: 0 });
  assert.equal('failureCooldownMs' in config, false);
  assert.equal('quotaCooldownMs' in config, false);
});
