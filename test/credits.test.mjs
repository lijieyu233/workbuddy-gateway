// 积分展示：面板顶部那张卡必须是「剩余/总量」，而不是某个模型的"已用百分比"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-credits-'));

const { normalizeConfig } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { parsePoolCredits } = await import('../src/accounts.js');

function makePool() {
  const pool = new Pool(normalizeConfig({ port: 0 }));
  pool.store.accounts = [
    { id: 'a1', uid: 'u1', nickname: '甲', domain: 'www.workbuddy.cn', accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86400000, accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, createdAt: 1, updatedAt: 1 },
    { id: 'a2', uid: 'u2', nickname: '乙', domain: 'www.workbuddy.cn', accessToken: 't', refreshToken: '', expiresAtMs: Date.now() + 86400000, accountType: 'personal', stats: { requests: 0, failures: 0, credits: 0 }, createdAt: 1, updatedAt: 1 },
  ];
  pool.reindex();
  return pool;
}

test('积分汇总：两个号都查到时相加', () => {
  const pool = makePool();
  pool.runtimeOf('a1').credits = { remaining: 4281, size: 4644, packs: 33 };
  pool.runtimeOf('a2').credits = { remaining: 4489, size: 4490, packs: 32 };
  const summary = pool.creditSummary();
  assert.equal(summary.remaining, 8770);
  assert.equal(summary.size, 9134);
  assert.equal(summary.known, 2);
  assert.equal(summary.total, 2);
});

test('积分汇总：只有部分账号查过时，known/total 如实反映', () => {
  const pool = makePool();
  pool.runtimeOf('a1').credits = { remaining: 100, size: 200, packs: 3 };
  const summary = pool.creditSummary();
  assert.equal(summary.remaining, 100);
  assert.equal(summary.known, 1, '只认查过的那个号');
  assert.equal(summary.total, 2);
});

test('积分汇总：一个都没查过时 remaining 是 null，不是 0', () => {
  // 0 的意思是"用光了"，null 是"不知道"。把不知道显示成 0 会误导用户。
  const summary = makePool().creditSummary();
  assert.equal(summary.remaining, null);
  assert.equal(summary.size, null);
  assert.equal(summary.known, 0);
});

test('从导入文件的 quota_raw 汇总积分', () => {
  const raw = {
    userResource: {
      data: {
        resourceSummary: {
          CreditGroups: [
            { CycleRemainCapacity: '500', CycleTotalCapacity: '500' },
            { CycleRemainCapacity: '3135.01000281', CycleTotalCapacity: '7821' },
          ],
        },
      },
    },
  };
  assert.deepEqual(parsePoolCredits(raw), { remaining: 3635.01, size: 8321, packs: 2 });
  // 字符串数值也要能算（上游这两种写法都有）
  assert.deepEqual(
    parsePoolCredits({ data: { resourceSummary: { CreditGroups: [{ CycleRemainCapacity: '12.5', CycleTotalCapacity: '20' }] } } }),
    { remaining: 12.5, size: 20, packs: 1 },
  );
  // 没有数据结构时返回 undefined，不返回 0
  assert.equal(parsePoolCredits({}), undefined);
  assert.equal(parsePoolCredits(undefined), undefined);
});
