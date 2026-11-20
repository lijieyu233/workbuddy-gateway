// 两种导出格式都要能导入。
// 真实用户给过两份形状不同的 JSON，任一种导入失败都等于功能不可用：
//   A: 顶层数组 + snake_case（access_token / expires_at）+ quota_raw 积分快照
//   B: 顶层数组 + 驼峰（accessToken 存在 auth_raw.auth 里，顶层也有 expiresAt）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportPayload } from '../src/accounts.js';

const FORMAT_B = `[{
  "access_token": "TOKEN_B",
  "refresh_token": "REFRESH_B",
  "uid": "365994a9-9a78-41e9-85ea-fcf35e4e6531",
  "nickname": "周海军15007306073",
  "domain": "www.workbuddy.cn",
  "expiresAt": 1795514912000,
  "refreshExpiresAt": 1795687712000,
  "auth_raw": {
    "auth": {
      "accessToken": "TOKEN_B",
      "refreshToken": "REFRESH_B",
      "expiresAt": 1795514912,
      "refreshExpiresAt": 1795687712,
      "domain": "www.workbuddy.cn"
    },
    "account": { "uid": "365994a9-9a78-41e9-85ea-fcf35e4e6531", "nickname": "周海军15007306073", "uin": "330113610522" }
  }
}]`;

const FORMAT_A = `[{
  "id": "workbuddy_258aea4722",
  "email": "永恒海星派大星",
  "uid": "35b8d97d-0c93-43bd-9b9f-bbbf3de4aeb3",
  "nickname": "永恒海星派大星",
  "access_token": "TOKEN_A",
  "refresh_token": "REFRESH_A",
  "domain": "www.workbuddy.cn",
  "expires_at": 1797401144438,
  "refresh_expires_at": 1797573944438,
  "quota_raw": {
    "userResource": {
      "data": {
        "resourceSummary": {
          "CreditGroups": [
            { "Name": "套餐基础积分", "CycleRemainCapacity": "500", "CycleTotalCapacity": "500" },
            { "Name": "平台奖励积分", "CycleRemainCapacity": "3135.01000281", "CycleTotalCapacity": "7821" }
          ]
        }
      }
    }
  },
  "auth_raw": { "auth": { "accessToken": "TOKEN_A" }, "account": { "uid": "35b8d97d-0c93-43bd-9b9f-bbbf3de4aeb3", "uin": "330102935554" } }
}]`;

test('格式 B：顶层数组 + 驼峰 expiresAt（毫秒）', () => {
  const { records, errors } = parseImportPayload(FORMAT_B);
  assert.deepEqual(errors, []);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.accessToken, 'TOKEN_B');
  assert.equal(r.refreshToken, 'REFRESH_B');
  assert.equal(r.uid, '365994a9-9a78-41e9-85ea-fcf35e4e6531');
  assert.equal(r.nickname, '周海军15007306073');
  assert.equal(r.domain, 'www.workbuddy.cn');
  // 毫秒时间戳不能被当成秒再乘 1000
  assert.equal(r.expiresAtMs, 1795514912000);
  assert.equal(r.refreshExpiresAtMs, 1795687712000);
  // uin 只在 auth_raw.account 里
  assert.equal(r.uin, '330113610522');
});

test('格式 A：下划线字段 + quota_raw 积分快照', () => {
  const { records, errors } = parseImportPayload(FORMAT_A);
  assert.deepEqual(errors, []);
  const r = records[0];
  assert.equal(r.accessToken, 'TOKEN_A');
  assert.equal(r.expiresAtMs, 1797401144438);
  assert.equal(r.uin, '330102935554');
  assert.equal(r.nickname, '永恒海星派大星');
  assert.deepEqual(r.credits, { remaining: 3635.01, size: 8321, packs: 2 });
});

test('导入：坏数据逐项报错，但不影响好的那几条', () => {
  const { records, errors } = parseImportPayload(JSON.stringify([
    { access_token: 'OK1', uid: 'u1' },
    { uid: 'u2' },                              // 缺 token
    { access_token: 'OK2', uid: 'u3', expires_in: 3600 },
    'not-an-object',
  ]));
  assert.equal(records.length, 2, '两条有效的要进来');
  assert.equal(errors.length, 2, '两条坏的要说清原因');
  assert.ok(records[1].expiresAtMs > Date.now(), 'expires_in 应换算成未来时间');
});

test('导入：兼容 {accounts:[...]} 包装', () => {
  const wrapped = JSON.stringify({ accounts: [{ access_token: 'T', uid: 'u' }] });
  assert.equal(parseImportPayload(wrapped).records.length, 1);
});

test('导入：兼容单个 auth 文档（桌面端那种）', () => {
  const single = JSON.stringify({ auth: { accessToken: 'T1', domain: 'copilot.tencent.com' }, account: { uid: 'u9' } });
  const { records, errors } = parseImportPayload(single);
  assert.deepEqual(errors, []);
  assert.equal(records[0].accessToken, 'T1');
  assert.equal(records[0].uid, 'u9');
});

test('导入：非法输入给出明确原因而不是静默成功', () => {
  assert.match(parseImportPayload('not json').errors[0], /不是合法 JSON/);
  assert.equal(parseImportPayload('[]').records.length, 0);
  assert.equal(parseImportPayload('{}').errors.length, 1);
});

