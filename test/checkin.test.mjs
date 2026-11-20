// 签到：状态解析 + 重复签到不该报错 + 已签到不重复领取。
//
// 实测事实（2026-11-18）：
//   状态接口 POST /v2/billing/meter/checkin-activity-status
//     返回 { code, msg, data: { today_checked_in, streak_days, daily_credit, ... } }
//   签到接口 POST /v2/billing/meter/daily-checkin
//     已签到时返回 400 + code 10001「今天已签到，请明天再来」
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Upstream } = await import('../src/upstream.js');

/** 造一个只回放指定响应的 Upstream 替身（不打真实上游）。 */
function fakeUpstream(responses) {
  let call = 0;
  return new Upstream({
    fetchImpl: async () => {
      const spec = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return {
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        text: async () => JSON.stringify(spec.body),
        json: async () => spec.body,
      };
    },
  });
}

const ACCOUNT = { accessToken: 't', refreshToken: '', domain: 'www.workbuddy.cn', uid: 'u' };

test('签到状态：把 data 里的字段挑出来，面板才读得到', async () => {
  // 踩过的坑：把整包 {code,msg,data} 原样返回，面板读 checkin.today_checked_in
  // 永远是 undefined，界面上签到列一直是「—」。
  const upstream = fakeUpstream([{
    status: 200,
    body: {
      code: 0,
      msg: 'OK',
      data: {
        active: true,
        today_checked_in: true,
        streak_days: 47,
        daily_credit: 100,
        today_credit: 100,
        is_streak_day: false,
        next_streak_day: 3,
        streak_bonus_credit: 0,
        checkin_dates: ['2026-11-18'],
      },
    },
  }]);
  const status = await upstream.fetchCheckin(ACCOUNT);
  assert.equal(status.today_checked_in, true);
  assert.equal(status.streak_days, 47);
  assert.equal(status.daily_credit, 100);
  assert.equal(status.today_credit, 100);
  assert.equal(status.is_streak_day, false);
  assert.equal(status.next_streak_day, 3);
  assert.ok(status.checkedAt > 0);
  // 不该把上游的整个 data 原样塞进来（里面还有几十个日期字符串）
  assert.equal('checkin_dates' in status, false);
});

test('签到状态：上游没给 data 时返回 undefined，不编一个假的', async () => {
  const upstream = fakeUpstream([{ status: 200, body: { code: 0, msg: 'OK' } }]);
  assert.equal(await upstream.fetchCheckin(ACCOUNT), undefined);
});

test('重复签到（10001）当成功处理，不算错误', async () => {
  // 这是最重要的一条：已签到是正常结果，显示成红色报错会让用户以为出问题了。
  const upstream = fakeUpstream([{
    status: 400,
    body: { code: 10001, msg: '今天已签到，请明天再来' },
  }]);
  const result = await upstream.checkin(ACCOUNT);
  assert.equal(result.ok, true, '已签到必须算成功');
  assert.equal(result.alreadyCheckedIn, true);
  assert.match(result.message, /已签到/);
});

test('签到成功：解析出领到的积分与连续天数', async () => {
  const upstream = fakeUpstream([{
    status: 200,
    body: { code: 0, msg: '签到成功', data: { credit: 100, streak_days: 48, streak_bonus_credit: 50 } },
  }]);
  const result = await upstream.checkin(ACCOUNT);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.credit, 100);
  assert.equal(result.streakDays, 48);
  assert.equal(result.streakBonusCredit, 50);
});

test('签到成功但只有 today_credit 字段时也要能读', async () => {
  const upstream = fakeUpstream([{
    status: 200,
    body: { code: 0, msg: 'OK', data: { today_credit: 100, streak_days: 5 } },
  }]);
  const result = await upstream.checkin(ACCOUNT);
  assert.equal(result.credit, 100);
  assert.equal(result.streakDays, 5);
});

test('真正的签到失败要如实报错，不能吞掉', async () => {
  const upstream = fakeUpstream([{
    status: 400,
    body: { code: 12345, msg: '签到活动已结束' },
  }]);
  const result = await upstream.checkin(ACCOUNT);
  assert.equal(result.ok, false);
  assert.equal(result.code, 12345);
  assert.match(result.message, /已结束/);
});

test('网络异常返回 ok:false 而不是抛出去', async () => {
  const upstream = new Upstream({
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  const result = await upstream.checkin(ACCOUNT);
  assert.equal(result.ok, false);
  assert.match(result.message, /网络错误/);
});
