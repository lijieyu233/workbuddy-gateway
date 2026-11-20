// 签到功能端到端：查状态 → 签到（今天已签，应报 alreadyCheckedIn 而不是错误）→ 再查状态。
// 这是真实副作用接口，只跑一次，不重复领取。
const base = 'http://127.0.0.1:57282';

const state = await fetch(`${base}/api/state`).then((r) => r.json());
const accounts = state.accounts;
if (accounts.length === 0) { console.log('池里没有账号'); process.exit(0); }

console.log('=== 账号及当前签到状态（加载时自动查过）===');
for (const a of accounts) {
  const ci = a.checkin;
  console.log(`  ${a.nickname}: ` + (ci
    ? `today_checked_in=${ci.today_checked_in} streak=${ci.streak_days} daily=${ci.daily_credit}`
    : '（无状态）'));
}

const target = accounts[0];
console.log(`\n=== 对「${target.nickname}」执行签到 ===`);
const res = await fetch(`${base}/api/accounts/${target.id}/checkin`, { method: 'POST', body: '{}' });
const body = await res.json();
console.log('HTTP', res.status);
console.log(JSON.stringify({
  ok: body.ok,
  alreadyCheckedIn: body.alreadyCheckedIn,
  credit: body.credit,
  streakDays: body.streakDays,
  message: body.message,
}, null, 2));
if (body.status) {
  console.log('签到后回查状态:', JSON.stringify({
    today_checked_in: body.status.today_checked_in,
    streak_days: body.status.streak_days,
    today_credit: body.status.today_credit,
  }));
}

console.log('\n=== 确认没有重复领取（今日积分不应翻倍）===');
console.log('当天 today_credit =', body.status?.today_credit, '（应等于 daily_credit =', body.status?.daily_credit, '）');
