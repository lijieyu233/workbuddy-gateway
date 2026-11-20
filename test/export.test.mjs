// 导出接口：必须真的能返回 200 和合法 JSON。
//
// 踩过的坑：content-disposition 文件名里拼了中文（"-全部"/"-1个"），
// Node 直接抛 "Invalid character in header content"，整个导出 500，
// 前端点了按钮毫无反应。这个测试把响应头也一起钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-export-'));

const { createGateway } = await import('../src/server.js');
const { normalizeConfig } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');

async function withServer(fn) {
  const config = normalizeConfig({ port: 0, listen: 'local' });
  const pool = new Pool(config);
  // 目录是空的，避免测试去打真实上游
  pool.catalog = { models: [], at: Date.now() };
  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, { pool, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const { accountIdOf } = await import('../src/accounts.js');

/** 造一条最小可用的账号记录（不连真实上游）。
 *  id 必须按真实规则由 uid 算出，否则导入时的"已存在"判断对不上。 */
function fakeAccount(pool, id, nickname) {
  const uid = `u-${id}`;
  pool.store.accounts.push({
    id: accountIdOf({ uid }),
    uid,
    uin: '',
    nickname,
    label: '',
    domain: 'www.workbuddy.cn',
    accessToken: `fake-access-token-${id}`,
    refreshToken: `fake-refresh-token-${id}`,
    expiresAtMs: Date.now() + 86400000,
    refreshExpiresAtMs: Date.now() + 86400000,
    accountType: 'personal',
    source: 'test',
    stats: { requests: 0, failures: 0, credits: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: '',
  });
  pool.reindex();
}

test('导出全部：200 且响应头是纯 ASCII', async () => {
  await withServer(async (base, { pool }) => {
    fakeAccount(pool, 'aaa111bbb222', '448****3');
    fakeAccount(pool, 'ccc333ddd444', '周海军');

    const res = await fetch(`${base}/api/accounts/export`);
    assert.equal(res.status, 200, '导出必须 200，不能因为文件名中文就 500');

    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition, '应有 content-disposition');
    // 关键：HTTP 头只能是 ASCII，这里含中文就会在 Node 里直接抛
    assert.ok(/^[\x20-\x7e]+$/.test(disposition), `响应头必须纯 ASCII，实际是：${disposition}`);
    assert.match(disposition, /filename="workbuddy-accounts-all-\d{4}-\d{2}-\d{2}\.json"/);

    const body = await res.json();
    assert.ok(Array.isArray(body), '导出格式是数组（和导入兼容）');
    assert.equal(body.length, 2);
    assert.match(body[0].access_token, /^fake-access-token-/, '字段名用 snake_case');
    assert.ok('expires_at' in body[0], '要有 expires_at');
  });
});

test('导出选中：只返回指定账号，文件名带数量且是 ASCII', async () => {
  await withServer(async (base, { pool }) => {
    fakeAccount(pool, 'aaa111bbb222', '甲');
    fakeAccount(pool, 'ccc333ddd444', '乙');

    const target = accountIdOf({ uid: 'u-aaa111bbb222' });
    const res = await fetch(`${base}/api/accounts/export?ids=${target}`);
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(/^[\x20-\x7e]+$/.test(disposition), '单个导出也不能有非 ASCII 头');
    assert.match(disposition, /workbuddy-accounts-1-\d{4}-\d{2}-\d{2}\.json/);

    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].uid, 'u-aaa111bbb222');
  });
});

test('导出不存在的 id：404 而不是 500', async () => {
  await withServer(async (base, { pool }) => {
    fakeAccount(pool, 'aaa111bbb222', '甲');
    const res = await fetch(`${base}/api/accounts/export?ids=nosuchid`);
    assert.equal(res.status, 404);
  });
});

test('导出的 JSON 能被导入接口原样吃回去', async () => {
  await withServer(async (base, { pool }) => {
    fakeAccount(pool, 'aaa111bbb222', '甲');
    const exported = await (await fetch(`${base}/api/accounts/export`)).json();
    // 导出文件用的是 snake_case，先确认形状
    assert.ok('access_token' in exported[0]);

    const res = await fetch(`${base}/api/accounts/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: JSON.stringify(exported) }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.added, 0, '同一个账号不该被重复添加');
    assert.equal(result.existed, 1, '应识别为已存在');
    assert.equal(result.errors.length, 0, `不应有解析错误：${JSON.stringify(result.errors)}`);
  });
});

test('账号身份：uid / uin / 令牌都没了要报错，不能算成同一个 id', async () => {
  // 空种子会得到空字符串的哈希，所有缺字段的账号都会算出同一个 id，
  // 互相覆盖。宁可抛错也不要静默合并。
  const { accountIdOf } = await import('../src/accounts.js');
  assert.throws(() => accountIdOf({}), /无法确定账号身份/);
  assert.throws(() => accountIdOf({ nickname: '只有昵称' }), /无法确定账号身份/);

  // 三种字段名都要认（内部记录驼峰、导出文件蛇形）
  const a = accountIdOf({ uid: 'u-1' });
  const b = accountIdOf({ accessToken: 'tok-1' });
  const c = accountIdOf({ access_token: 'tok-1' });
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(b, c, '驼峰和蛇形令牌应算出同一个 id');
  assert.notEqual(a, b, '不同账号必须不同 id');
});
