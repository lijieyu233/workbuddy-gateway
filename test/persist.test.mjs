// 额度持久化回归：重启进程后，已知的额度/余额不应该丢。
// 踩过的坑：quotaByModel 只放在 runtime 内存里，重启后面板显示「尚无额度数据」，
// 看着像功能坏了，其实上游早就告诉过我们。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-persist-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');

const ACCOUNT = {
  id: 'acc-persist-01', uid: 'u1', nickname: '持久号', domain: 'copilot.tencent.com',
  accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86_400_000,
  accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, disabled: false,
  createdAt: Date.now(), updatedAt: Date.now(),
};

test('额度写入账号库并可被新进程恢复', () => {
  const config = normalizeConfig({ port: 0 });
  ensureApiKey(config);
  const pool = new Pool(config);
  pool.store.accounts = [{ ...ACCOUNT }];
  pool.reindex();

  // 模拟一次成功请求带回 quota
  pool.markSuccess(pool.get(ACCOUNT.id), {
    credit: 0.11,
    quota: { model: 'deepseek-v4.1-flash', percent: 57, reset_at: '1794997951' },
  });

  const after = pool.get(ACCOUNT.id);
  assert.equal(after.quotaByModel['deepseek-v4.1-flash'].usedPercent, 57);
  assert.equal(after.quotaByModel['deepseek-v4.1-flash'].resetAt, 1794997951);
  assert.equal(after.stats.credits, 0.11);

  // 新进程：重新从磁盘读
  const fresh = new Pool(config);
  const restored = fresh.get(ACCOUNT.id);
  assert.ok(restored, '账号应还在库里');
  const snapshot = fresh.snapshot().find((item) => item.id === ACCOUNT.id);
  assert.equal(snapshot.quotaByModel['deepseek-v4.1-flash']?.usedPercent, 57,
    '重启后额度必须还在，不能变成"尚无额度数据"');
});

test('余额与签到也持久化', async () => {
  const config = normalizeConfig({ port: 0 });
  ensureApiKey(config);
  const pool = new Pool(config);
  pool.store.accounts = [{ ...ACCOUNT, id: 'acc-persist-02' }];
  pool.reindex();
  pool.upstream = {
    async fetchCredits() { return { remaining: 83, size: 100, packs: 2 }; },
    async fetchCheckin() { return { signed: true }; },
  };
  await pool.syncAccountUsage('acc-persist-02');

  const fresh = new Pool(config);
  const snapshot = fresh.snapshot().find((item) => item.id === 'acc-persist-02');
  assert.deepEqual(snapshot.credits, { remaining: 83, size: 100, packs: 2 });
  assert.deepEqual(snapshot.checkin, { signed: true });
  assert.ok(snapshot.lastSyncedAt > 0);
});
