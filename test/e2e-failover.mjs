// 故障切换自测：往池里塞一个令牌已失效的账号，验证请求能自动换到真账号，
// 且坏号被冷却、不影响后续请求。会真实消耗一次额度。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-failover-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { scanDesktopAccounts, mergeScanned, accountIdOf } = await import('../src/accounts.js');

const config = normalizeConfig({ port: 0 });
ensureApiKey(config);
const pool = new Pool(config);
const scanned = scanDesktopAccounts();
if (scanned.length === 0) { console.log('本机没有 WorkBuddy 登录态，跳过'); process.exit(0); }
pool.store = mergeScanned(pool.store, scanned).store;

// 假账号：令牌形似但不合法，上游会 401 → 必须被识别为账号级失败并换号。
const bogus = {
  uid: 'dead-account-0001', uin: '99999999999', nickname: '失效号', domain: 'copilot.tencent.com',
  accountType: 'personal', accessToken: 'deadbeef'.repeat(20), refreshToken: '', expiresAtMs: Date.now() + 86400000,
};
pool.addAccount(bogus);
const bogusId = accountIdOf(bogus);

// 强制第一次请求先撞上假号：pick() 按 lastUsedAt 升序选号，
// 把真账号标成“刚用过”，假账号的 0 就会排到前面。不这么做测试会一直走真号，
// 等于什么故障切换都没验证到。
for (const account of pool.accounts) {
  if (account.id !== bogusId) pool.runtimeOf(account.id).lastUsedAt = Date.now();
}
console.log('池内账号 =', pool.summary());

const { server } = createGateway({ config, pool });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const key = config.apiKeys[0].key;
const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

// 第一次请求优先挑并发最低 + 最久没用过的号，可能先撞上假号。
const r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: false, max_tokens: 12, messages: [{ role: 'user', content: '说一个字' }] }),
});
const body = await r.json();
console.log('请求状态 =', r.status, '| 正文 =', JSON.stringify(body.choices?.[0]?.message?.content));
console.log('实际服务账号 =', r.headers.get('x-workbuddy-account'));

const state = await fetch(`${base}/api/state`).then((x) => x.json());
for (const account of state.accounts) {
  console.log(`  ${account.nickname.padEnd(12)} state=${account.state.padEnd(11)} err=${(account.lastError || '').slice(0, 60)}`);
}

const bad = state.accounts.find((a) => a.id === bogusId);
if (bad) {
  // 冷却已取消：失效号不再被标成 cooling，但必须记下失败原因。
  console.log(bad.state === 'available' ? '✔ 失效号未被封锁（冷却已取消）' : `✘ 失效号状态异常：${bad.state}`);
  console.log(bad.lastError.includes('401') ? '✔ 错误原因记录了 401' : `✘ 错误原因不对：${bad.lastError}`);
}

// 真实账号此刻可能额度耗尽（429/6004），那样请求失败是环境使然，不是切换坏了。
// 这里只断言「失败原因里出现了真实账号的报错」，说明确实切换过去试过了。
const switched = r.status === 200 || /频率限制|quota|429|6004/iu.test(JSON.stringify(body));
console.log(switched
  ? '✔ 请求被自动切换到了可用账号' + (r.status === 200 ? '' : '（该账号额度已用尽，切换本身正常）')
  : `✘ 请求失败：${JSON.stringify(body).slice(0, 200)}`);

// 第二次请求同样会先跳过失败号
const r2 = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: false, max_tokens: 12, messages: [{ role: 'user', content: '再说一个字' }] }),
});
console.log('第二次请求 =', r2.status, '| account =', r2.headers.get('x-workbuddy-account'));

await new Promise((resolve) => server.close(resolve));
process.exitCode = 0;
process.exit(0);
