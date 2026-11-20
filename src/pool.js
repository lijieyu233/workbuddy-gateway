// 账号池与调度：选号、并发、令牌续期、用量记账。
// 设计底线：任何一次失败都要能说清“是哪个号、什么原因”，不静默吞错。
import { EventEmitter } from 'node:events';
import { Upstream } from './upstream.js';
import { loadAccounts, saveAccounts, accountIdOf } from './accounts.js';
import { loadModelSettings, saveModelSettings, normalizeModelSetting, effectiveSettings } from './modelsettings.js';

const NOW = () => Date.now();

export class Pool extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.store = loadAccounts();
    this.upstream = new Upstream({ proxyUrl: config.proxyUrl });
    this.runtime = new Map();
    this.refreshing = new Map();
    this.queue = [];
    this.closed = false;
    // 逐模型设置（推理强度 / 关闭思考 / 上下文档位 / 是否启用）
    this.modelSettings = loadModelSettings();
    for (const account of this.store.accounts) this.#runtime(account.id);
  }

  get accounts() { return this.store.accounts; }

  #runtime(id) {
    let entry = this.runtime.get(id);
    if (!entry) {
      // 从账号记录里恢复上次已知的额度与余额：这些是上游给过的事实，
      // 进程重启不该把它们抹掉（否则面板一重启就显示「尚无额度数据」）。
      const account = this.store.accounts.find((item) => item.id === id);
      entry = {
        inflight: 0,
        cooldownUntil: 0,
        // 上游声明的额度恢复时间，只用于展示，不作为封锁依据
        recoverAtMs: 0,
        lastError: '',
        lastErrorAt: 0,
        lastUsedAt: 0,
        quotaByModel: { ...(account?.quotaByModel || {}) },
        credits: account?.credits,
        checkin: account?.checkin,
        lastSyncedAt: account?.lastSyncedAt || 0,
        probe: undefined,
      };
      this.runtime.set(id, entry);
    }
    return entry;
  }

  reload() {
    this.store = loadAccounts();
    const live = new Set(this.store.accounts.map((a) => a.id));
    for (const id of [...this.runtime.keys()]) if (!live.has(id)) this.runtime.delete(id);
    for (const account of this.store.accounts) this.#runtime(account.id);
    return this.store;
  }

  /**
   * 账号运行时的公开读取口。任何直接替换 store 的调用方（导入、同步）都要先过一遍，
   * 否则 runtime 里没有条目，后续读取会拿到 undefined。
   */
  runtimeOf(id) {
    return this.#runtime(id);
  }

  /** 为当前 store 里的每个账号补齐 runtime 条目。替换 store 之后必须调用。 */
  reindex() {
    const live = new Set(this.store.accounts.map((account) => account.id));
    for (const id of [...this.runtime.keys()]) if (!live.has(id)) this.runtime.delete(id);
    for (const account of this.store.accounts) this.#runtime(account.id);
  }

  persist() {
    saveAccounts(this.store);
  }

  get(id) {
    return this.store.accounts.find((account) => account.id === id);
  }

  /**
   * 账号状态：停用 / 异常 / 可用。
   *
   * 已经没有「冷却」这个概念了（按要求去掉）：失败只记录原因用于展示，
   * 不阻止账号被再次选中。避免坏账号反复被选的方式改成「排序靠后」，见 pick()。
   */
  stateOf(account) {
    const rt = this.#runtime(account.id);
    const now = NOW();
    if (account.disabled) return 'disabled';
    const expired = account.expiresAtMs > 0 && account.expiresAtMs < now;
    if (expired && !account.refreshToken) return 'unavailable';
    // 有未清除的错误时仍然算「可用」，但面板会把原因显示出来
    if (rt.lastError) return 'available';
    return 'available';
  }

  snapshot() {
    const now = NOW();
    return this.store.accounts.map((account) => {
      const rt = this.#runtime(account.id);
      return {
        id: account.id,
        state: this.stateOf(account),
        // 冷却已取消，这个字段恒为 0，保留是为了面板/接口形状稳定
        cooldownRemainingMs: 0,
        recoverAtMs: rt.recoverAtMs || 0,
        inflight: rt.inflight,
        lastError: rt.lastError,
        lastErrorAt: rt.lastErrorAt,
        lastUsedAt: rt.lastUsedAt,
        quotaByModel: rt.quotaByModel,
        credits: rt.credits,
        checkin: rt.checkin,
        lastSyncedAt: rt.lastSyncedAt,
        probe: rt.probe,
      };
    });
  }

  /** 面板汇总。冷却已取消，cooling 恒为 0。 */
  summary() {
    const counts = { available: 0, unavailable: 0, cooling: 0, disabled: 0, total: 0, failing: 0 };
    for (const account of this.store.accounts) {
      counts.total += 1;
      const state = this.stateOf(account);
      if (state === 'available') counts.available += 1;
      else if (state === 'disabled') counts.disabled += 1;
      else counts.unavailable += 1;
      // 「异常」只统计真正不可用的（停用/令牌过期无刷新），失败次数单独给一个数
      if (this.#runtime(account.id).lastError) counts.failing += 1;
    }
    const plans = {};
    for (const account of this.store.accounts) {
      const plan = account.enterpriseId || String(account.accountType || '').toLowerCase() === 'ultimate' ? 'enterprise' : 'personal';
      plans[plan] = (plans[plan] || 0) + 1;
    }
    return { ...counts, plans };
  }

  /**
   * 账号池的积分合计。
   *
   * 只统计真的读到过余额的账号（credits 存在的），并单独给出"有几个号已知余额"，
   * 这样面板不会把「2 个号里只有 1 个查过」显示成池子的总量。
   * 一个都查不到时 remaining 为 null，而不是 0——0 的意思是"用光了"，不是"不知道"。
   */
  creditSummary() {
    let remaining = 0;
    let size = 0;
    let known = 0;
    for (const account of this.store.accounts) {
      const rt = this.#runtime(account.id);
      const credits = rt.credits ?? account.credits;
      if (!credits || typeof credits.remaining !== 'number') continue;
      known += 1;
      remaining += credits.remaining;
      size += typeof credits.size === 'number' ? credits.size : 0;
    }
    return {
      remaining: known > 0 ? +remaining.toFixed(2) : null,
      size: known > 0 ? +size.toFixed(2) : null,
      known,
      total: this.store.accounts.length,
    };
  }

  markSuccess(account, usage) {
    const rt = this.#runtime(account.id);
    rt.lastError = '';
    rt.lastErrorAt = 0;
    rt.cooldownUntil = 0;
    rt.lastUsedAt = NOW();
    account.stats = account.stats || { requests: 0, failures: 0, credits: 0 };
    account.stats.requests += 1;
    if (usage) {
      if (typeof usage.credit === 'number') account.stats.credits = +(account.stats.credits + usage.credit).toFixed(4);
      const quota = usage.quota;
      if (quota && typeof quota === 'object' && typeof quota.model === 'string') {
        // 上游每个模型各自报一条 quota：percent 是「已用百分比」（实测发一次请求由 4 涨到 6），
        // reset_at 是秒级时间戳。这里原样存，不做换算，免得把已用说成剩余。
        const record = {
          usedPercent: typeof quota.percent === 'number' ? quota.percent : null,
          resetAt: Number(quota.reset_at) || null,
          at: NOW(),
        };
        rt.quotaByModel[quota.model] = record;
        // 同时写进账号记录：额度是「上游已经告诉我们的事实」，
        // 只存内存的话每次重启面板都变成「尚无额度数据」，
        // 看起来像功能坏了，其实数据早就有过。
        account.quotaByModel = { ...(account.quotaByModel || {}), [quota.model]: record };
      }
    }
    this.persist();
  }

  /**
   * 记录一次失败。
   *
   * 只记录原因与计数，**不再设置冷却**（按要求去掉冷却）。
   * 副作用是这个号下一次仍可能被选中，所以 pick() 里按「最近是否失败」排序，
   * 让刚失败的号排在健康号后面——既不封锁账号，也不至于反复撞同一堵墙。
   */
  markFailure(account, classification, message, resetAtMs) {
    const rt = this.#runtime(account.id);
    account.stats = account.stats || { requests: 0, failures: 0, credits: 0 };
    account.stats.failures += 1;
    rt.lastError = message || classification.reason || 'unknown';
    rt.lastErrorAt = NOW();
    rt.cooldownUntil = 0;
    // 上游给的恢复时间只用于展示（例如"额度 18:32 恢复"），不作为封锁依据
    rt.recoverAtMs = resetAtMs && resetAtMs > NOW() ? resetAtMs : 0;
    this.persist();
    this.emit('account-failed', {
      accountId: account.id,
      kind: classification.kind,
      message: rt.lastError,
      recoverAtMs: rt.recoverAtMs,
    });
  }

  clearError(account) {
    const rt = this.#runtime(account.id);
    rt.lastError = '';
    rt.lastErrorAt = 0;
    rt.cooldownUntil = 0;
    this.persist();
  }

  /** 令牌续期做单飞：同一个号并发多个请求时只打一次续期接口。 */
  async ensureFreshToken(account) {
    if (this.config.tokenRefresh === 'off') return account;
    const expiring = account.expiresAtMs && account.expiresAtMs - this.config.refreshSkewMs < NOW();
    if (!expiring || !account.refreshToken) return account;
    const existing = this.refreshing.get(account.id);
    if (existing) return existing;
    const task = (async () => {
      const result = await this.upstream.refreshToken(account);
      account.accessToken = result.accessToken;
      account.refreshToken = result.refreshToken || account.refreshToken;
      account.expiresAtMs = result.expiresAtMs || account.expiresAtMs;
      account.refreshExpiresAtMs = result.refreshExpiresAtMs || account.refreshExpiresAtMs;
      account.updatedAt = NOW();
      this.persist();
      return account;
    })().finally(() => this.refreshing.delete(account.id));
    this.refreshing.set(account.id, task);
    return task;
  }

  /**
   * 选出下一个账号。
   *
   * 冷却已取消，所以不能用它当门禁。替代办法是**排序**，让健康号优先：
   *   1. 有未清除错误的排后面（刚失败过，先别撞它）
   *   2. 并发占用低的优先
   *   3. 最久没用过的优先（轮换，避免总用同一个号）
   * 这样既不封锁任何账号（用户要求），也不会让一个坏号把每次请求都拖一遍。
   */
  pick(excluded = new Set()) {
    const now = NOW();
    const candidates = this.store.accounts
      .filter((account) => !excluded.has(account.id) && !account.disabled)
      .map((account) => ({ account, rt: this.#runtime(account.id) }))
      .filter(({ rt }) => rt.inflight < this.config.maxConcurrentPerAccount)
      .filter(({ account }) => !account.expiresAtMs || account.expiresAtMs > now || Boolean(account.refreshToken));
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => {
      const aBad = a.rt.lastError ? 1 : 0;
      const bBad = b.rt.lastError ? 1 : 0;
      if (aBad !== bBad) return aBad - bBad;
      if (a.rt.inflight !== b.rt.inflight) return a.rt.inflight - b.rt.inflight;
      return a.rt.lastUsedAt - b.rt.lastUsedAt;
    });
    return candidates[0].account;
  }

  acquire(account) {
    this.#runtime(account.id).inflight += 1;
  }

  release(account) {
    const rt = this.#runtime(account.id);
    rt.inflight = Math.max(0, rt.inflight - 1);
  }

  addAccount(record) {
    const id = accountIdOf(record);
    if (this.get(id)) return { added: false, id };
    const account = {
      id,
      ...record,
      label: record.label || '',
      disabled: false,
      createdAt: NOW(),
      updatedAt: NOW(),
      usage: null,
      stats: { requests: 0, failures: 0, credits: 0 },
      lastError: '',
    };
    // 导入文件常带积分快照（quota_raw 里汇总出来的），存到账号记录上，
    // 这样面板「余额」在还没请求过上游时就已有数据。
    if (record.credits) account.credits = record.credits;
    delete account.credits_imported;
    this.store.accounts.push(account);
    // 先建 runtime，再把导入的余额灌进去（#runtime 初始化时会从账号记录读一次）
    const rt = this.#runtime(id);
    if (record.credits) rt.credits = record.credits;
    this.persist();
    return { added: true, id };
  }

  removeAccount(id) {
    const before = this.store.accounts.length;
    this.store.accounts = this.store.accounts.filter((account) => account.id !== id);
    this.runtime.delete(id);
    this.persist();
    return this.store.accounts.length !== before;
  }

  updateAccount(id, patch) {
    const account = this.get(id);
    if (!account) return undefined;
    const allowed = ['label', 'disabled', 'accountType', 'enterpriseId', 'domain', 'nickname'];
    for (const key of allowed) {
      if (key in patch) account[key] = patch[key];
    }
    account.updatedAt = NOW();
    this.persist();
    return account;
  }

  /**
   * 把客户端传来的 model 归一成上游认的 id。
   *
   * 上游目录里 id 和显示名是两套写法：
   *   id   = "deepseek-v4.1-flash"     ← 上游唯一接受的
   *   name = "DeepSeek-V4.1-Flash"     ← 面板/菜单里给人看的
   * 客户端（尤其从别的服务抄配置的）经常直接填显示名，原样转发会被上游拒：
   *   400 "model [DeepSeek-V4.1-Flash] service info not found"
   *
   * **显示名会重名**（实测 60 个模型里有 4 组）：
   *   "Hy4 preview" 同时是 hy4-preview-ctrl / -exp / -x / hy4preview-exp1 / -exp2
   *   "Hy3" 同时是 hy3-b / hy3-c；"DeepSeek-V3-0324" 有两个；"Hy4 flash" 有两个
   * 这种情况不能拿 find() 的第一个结果充数——那等于把用户要的模型悄悄换成另一个。
   * 所以重名时返回 undefined 表示"有歧义"，由调用方如实报错并列出候选 id。
   */
  resolveModel(requested) {
    if (typeof requested !== 'string' || requested === '') return { id: requested };
    const models = this.catalog || [];
    if (models.length === 0) return { id: requested };
    const exact = models.find((model) => model.id === requested);
    if (exact) return { id: exact.id };
    const lower = requested.trim().toLowerCase();
    const byId = models.find((model) => String(model.id).toLowerCase() === lower);
    if (byId) return { id: byId.id };
    // 显示名匹配可能有多个，全部收集起来再判断
    const byName = models.filter((model) => String(model.name || '').toLowerCase() === lower);
    if (byName.length === 1) return { id: byName[0].id };
    if (byName.length > 1) {
      return { ambiguous: true, candidates: byName.map((model) => model.id) };
    }
    return { id: requested };
  }

  /** 拉一次模型目录并缓存，供 /v1/models 与面板倍率显示用。
   *
   * 目录是账号无关的，但令牌是个账号绑定的：某个号 401 不代表没有目录可读。
   * 所以这里逐个试，第一个能读到的就缓存下来，只有全部失败才报错。
   */
  async syncCatalog() {
    const accounts = this.store.accounts.filter((account) => !account.disabled);
    if (accounts.length === 0) throw new Error('没有可用账号，无法读取模型目录');
    const failures = [];
    for (const account of accounts) {
      try {
        await this.ensureFreshToken(account);
        const models = await this.upstream.fetchCatalog(account);
        this.catalogAt = NOW();
        this.catalog = models;
        this.catalogAccountId = account.id;
        return models;
      } catch (error) {
        failures.push(`${account.nickname || account.id}: ${error.message}`);
      }
    }
    throw new Error(`所有账号都读不到模型目录：${failures.slice(0, 3).join('；')}`);
  }

  /**
   * 更新一个模型的设置。
   *
   * 只接受该模型上游声明支持的值：不在 supportedEfforts 里的档位、不支持关闭思考的
   * 模型上的 disableThinking、不在 supportedLengths 里的档位，全部丢弃。
   * 这样面板不会出现「点了但请求没变」的假开关——因为它一开始就选不了。
   */
  updateModelSetting(modelId, patch) {
    const model = (this.catalog || []).find((item) => item.id === modelId);
    if (!model) return undefined;
    const current = this.modelSettings[modelId] ?? {};
    const merged = normalizeModelSetting({ ...current, ...patch }, model);
    this.modelSettings = { ...this.modelSettings, [modelId]: merged };
    saveModelSettings(this.modelSettings);
    return merged;
  }

  /** 批量启用/禁用（面板上的「一键启用」）。 */
  setAllModelsEnabled(enabled) {
    const next = { ...this.modelSettings };
    for (const model of this.catalog || []) {
      next[model.id] = normalizeModelSetting({
        ...(next[model.id] ?? {}),
        enabled,
      }, model);
    }
    this.modelSettings = next;
    saveModelSettings(next);
    return next;
  }

  /** 当前生效的模型设置快照（含"没设置时上游默认值"），给面板与 /v1/models 用。 */
  modelSnapshot() {
    return effectiveSettings(this.catalog || [], this.modelSettings);
  }

  /**
   * 给一个账号签到。
   *
   * 签到的副作用是真实的（会真的领到积分），所以：
   *   - 只在你点按钮时执行，绝不在后台自动跑；
   *   - 已经签过就如实说"今天已签到"，不报错、也不假装又领了一次；
   *   - 签完立刻回查一次状态，用上游的新数字更新面板，不做乐观猜测。
   */
  async checkin(accountId) {
    const account = this.get(accountId);
    if (!account) throw new Error('账号不存在');
    await this.ensureFreshToken(account);
    const result = await this.upstream.checkin(account);
    if (!result.ok) return result;
    // 回查状态：这是"签到之后到底算不算数"的唯一可信来源
    const status = await this.upstream.fetchCheckin(account);
    const rt = this.#runtime(account.id);
    if (status) {
      rt.checkin = status;
      account.checkin = status;
      rt.lastSyncedAt = NOW();
      account.lastSyncedAt = rt.lastSyncedAt;
    }
    this.persist();
    return { ...result, status: status ?? undefined };
  }

  async syncAccountUsage(accountId) {
    const account = this.get(accountId);
    if (!account) throw new Error('账号不存在');
    await this.ensureFreshToken(account);
    const [credits, checkin] = await Promise.all([
      this.upstream.fetchCredits(account),
      this.upstream.fetchCheckin(account),
    ]);
    const rt = this.#runtime(account.id);
    if (credits) {
      rt.credits = credits;
      account.credits = credits;
    }
    if (checkin) {
      rt.checkin = checkin;
      account.checkin = checkin;
    }
    rt.lastSyncedAt = NOW();
    account.lastSyncedAt = rt.lastSyncedAt;
    this.persist();
    return { credits, checkin };
  }

  close() {
    this.closed = true;
  }
}
