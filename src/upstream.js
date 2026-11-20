// WorkBuddy 上游协议层：端点、请求头、请求体整形、SSE 解析。
// 本文件不含任何状态，纯函数 + 一个 fetch 客户端，便于单测。

import { sanitizeMessages } from './sanitize.js';

export const CN_CHAT_BASE = 'https://copilot.tencent.com';
export const CN_BILLING_BASE = 'https://www.codebuddy.cn';
export const GLOBAL_BASE = 'https://www.workbuddy.ai';

// 聊天走 CLI 通道，这是上游按 CLI 计费/限流的身份，必须逐字节保持一致。
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
// 产品配置通道用 App 身份，/v3/config 会按 UA 回答不同目录。
export const PRODUCT_UA = 'WorkBuddy/5.9.4 WorkBuddy/5.9.4 CLI/2.63.2';

export const FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.';

export function regionOf(domain) {
  const lowered = String(domain || '').trim().toLowerCase();
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global';
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global';
  return 'cn';
}

export function chatBase(account) {
  if (regionOf(account.domain) === 'global') {
    const host = String(account.domain || '').trim() || 'www.workbuddy.ai';
    return `https://${host}`;
  }
  return CN_CHAT_BASE;
}

export function billingBase(account) {
  return regionOf(account.domain) === 'global' ? chatBase(account) : CN_BILLING_BASE;
}

function originReferer(account) {
  return regionOf(account.domain) === 'global' ? chatBase(account) : CN_BILLING_BASE;
}

// 32 位小写 UUIDv7，与官方客户端请求 id 形状一致（截图里的使用端显示才对得上）。
export function uuidv7(nowMs = Date.now()) {
  const bytes = new Uint8Array(16);
  const rnd = globalThis.crypto.getRandomValues(bytes);
  for (let index = 0; index < 6; index++) {
    rnd[index] = Math.floor(nowMs / 2 ** (8 * (5 - index))) & 255;
  }
  rnd[6] = (rnd[6] & 0x0f) | 0x70;
  rnd[8] = (rnd[8] & 0x3f) | 0x80;
  return Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 上游聊天接口要求的三联会话身份；缺任意一个都会被 11128 拒。 */
export function conversationHeaders() {
  return {
    'X-Conversation-ID': uuidv7(),
    'X-Conversation-Request-ID': uuidv7(),
    'X-Conversation-Message-ID': uuidv7(),
  };
}

export function commonHeaders(account) {
  const origin = originReferer(account);
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

export function chatHeaders(account, extra = {}) {
  const headers = {
    ...commonHeaders(account),
    'Content-Type': 'application/json',
    ...(account.uid ? { 'X-User-Id': account.uid } : { 'X-No-User-Id': '1' }),
    ...(account.enterpriseId ? { 'X-Enterprise-Id': account.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    ...(account.domain ? { 'X-Domain': account.domain } : { 'X-No-Department-Info': '1' }),
    'X-Product': 'SaaS',
    ...extra,
    ...conversationHeaders(),
    Authorization: `Bearer ${account.accessToken}`,
  };
  return headers;
}

export function refreshHeaders(account) {
  const headers = {
    ...commonHeaders(account),
    'X-Refresh-Token': account.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  };
  if (account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId;
  return headers;
}

export function billingHeaders(account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId;
    headers['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account.domain) headers['X-Domain'] = account.domain;
  return headers;
}

/**
 * 修正图片输入格式。
 *
 * 实测（2026-11-18）：`image_url.url` 放**裸 base64** 会被上游回
 *   400 / 11133 "Invalid request parameters"（extError: the request parameters were rejected…）
 * 而带 `data:image/png;base64,...` 前缀就正常。很多客户端（包括手写脚本）会漏前缀，
 * 于是这条本可以自动修好的错误就变成用户的"模型不能用"。
 *
 * 这里做三件事：
 *   1. 裸 base64 → 补成 data URL（嗅探图片类型）；
 *   2. `image` 字段（Anthropic 风格）→ 转成 OpenAI 的 image_url；
 *   3. 确认不了类型的不动，交给上游判断，不瞎猜。
 */
export function fixImageParts(messages) {
  if (!Array.isArray(messages)) return { messages, fixed: 0 };
  let fixed = 0;
  const out = messages.map((message) => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      // Anthropic 风格：{ type:'image', source:{ type:'base64', media_type, data } }
      if (part.type === 'image' && part.source && typeof part.source.data === 'string') {
        touched = true;
        const media = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
        return { type: 'image_url', image_url: { url: `data:${media};base64,${part.source.data}` } };
      }
      if (part.type !== 'image_url') return part;
      const url = part.image_url?.url;
      if (typeof url !== 'string' || url === '') return part;
      if (/^data:/iu.test(url) || /^https?:\/\//iu.test(url)) return part;
      // 裸 base64：补前缀
      const mime = sniffBase64Mime(url);
      if (!mime) return part;
      touched = true;
      return { ...part, image_url: { ...part.image_url, url: `data:${mime};base64,${url}` } };
    });
    if (!touched) return message;
    fixed += 1;
    return { ...message, content };
  });
  return { messages: out, fixed };
}

/** 从 base64 头部嗅探图片类型；认不出返回 undefined，不猜。 */
export function sniffBase64Mime(base64) {
  const head = base64.slice(0, 32).replace(/\s/gu, '');
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('Qk0')) return 'image/bmp';
  return undefined;
}

/**
 * 把外部客户端发来的 OpenAI 请求体整形为上游能接受的样子。
 *
 * 实测要点：
 *   - 上游只支持流式，非流式请求会被 11101 拒；
 *   - developer 角色要降级成 system，首条必须是 system；
 *   - system/assistant 消息要过渠道校验净化（见 sanitize.js），否则真实客户端
 *     的长系统提示会一律 11128。
 */
export function shapeChatBody(body, { dense = false } = {}) {
  const obj = { ...body };
  obj.stream = true;
  if (Array.isArray(obj.messages)) {
    // 先修图片格式：裸 base64 会被上游 11133 拒，这是可以自动修好的问题。
    const fixedImages = fixImageParts(obj.messages);
    obj.messages = sanitizeMessages(
      fixedImages.messages.map((message) => (
        message && typeof message === 'object' && message.role === 'developer'
          ? { ...message, role: 'system' }
          : message
      )),
      { dense },
    );
    ensureSystemHead(obj.messages);
  } else if (typeof obj.prompt === 'string' && obj.prompt !== '') {
    // 少数客户端只发 prompt（completions 风格），补成一条 user 消息。
    const prompt = obj.prompt;
    delete obj.prompt;
    obj.messages = sanitizeMessages([{ role: 'user', content: prompt }], { dense });
    ensureSystemHead(obj.messages);
  }
  normalizeToolChoice(obj);
  delete obj.stream_options;
  return obj;
}

export function ensureSystemHead(messages) {
  // 空数组没有"首条消息"可检查，也不该在这里补一条凑数：
  // 上游对空 messages 是明确的 400/11133，补一条 system 只会把它变成
  // "只有 system 的请求"（实测能过，但会浪费一次额度做无意义的事）。
  // 空 messages 由 validateChatBody 在发请求之前挡掉。
  if (!Array.isArray(messages) || messages.length === 0) return;
  const head = messages[0];
  if (head && typeof head === 'object' && typeof head.role === 'string' && head.role.trim().toLowerCase() === 'system') return;
  messages.unshift({ role: 'system', content: FALLBACK_SYSTEM_PROMPT });
}

/**
 * 发请求前的本地校验。
 *
 * 有些请求无论重试多少次都不会成功，最典型的是「没有任何 messages」——
 * 上游会回 400/11133 "Invalid request parameters"，而用户看到的是
 * "模型无法处理此请求"，完全摸不着头脑。
 * 实测：空 messages 是 11133 的确定触发条件之一；只要有一条消息就正常。
 * 与其把这种请求发出去、消耗一次额度、再拿一个看不懂的错误，不如在这里直接说清楚。
 */
export function validateChatBody(body) {
  if (!body || typeof body !== 'object') return '请求体不是对象';
  if (!Array.isArray(body.messages)) return 'messages 必须是数组';
  // 实测（2026-11-18）：只有空数组才会被上游 400/11133；
  // 只有 system、只有 user、含非法 role 都正常返回 200。
  // 所以这里只挡空数组，别把本来能过的请求拦下来。
  if (body.messages.length === 0) return 'messages 是空的：至少要有一条消息';
  return undefined;
}

/**
 * 上游把 tool_choice: {type:'function',function:{name}} 压平成裸函数名字符串；
 * type:none 时连 tools 一起删掉。照抄这套规则，才能和官方客户端行为一致。
 */
export function normalizeToolChoice(obj) {
  if (!('tool_choice' in obj)) return obj;
  const choice = obj.tool_choice;
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj.tool_choice;
      delete obj.tools;
      delete obj.functions;
    }
    return obj;
  }
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
    if (type === 'none') {
      delete obj.tool_choice;
      delete obj.tools;
      delete obj.functions;
    } else if (type === 'auto' || type === 'required') {
      obj.tool_choice = type;
    } else if (type === 'function') {
      const name = (choice.function && typeof choice.function.name === 'string' ? choice.function.name : choice.name || '').trim();
      obj.tool_choice = name !== '' ? name : 'auto';
    } else {
      delete obj.tool_choice;
    }
    return obj;
  }
  delete obj.tool_choice;
  return obj;
}

/**
 * 从上游的额度错误里解析「什么时候恢复」。
 *
 * 实测 429/6004 的原文形如：
 *   "您的使用量已超出频率限制，将在 2026-11-18 18:32:31 UTC+8 重置，您也可以切换其他模型继续使用。"
 * 上游没有给 Retry-After 头，但把时间写在正文里。
 * 解析不出来就返回 undefined，绝不编一个时间——那样只会让用户在错误的时间重试。
 */
export function parseQuotaResetAt(message, now = Date.now()) {
  if (typeof message !== 'string') return undefined;
  // 2026-11-18 18:32:31 UTC+8
  const match = message.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC([+-]\d{1,2})/u);
  if (match) {
    const [, year, month, day, hour, minute, second, zone] = match;
    const offsetHours = Number(zone);
    const utcMs = Date.UTC(
      Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(second ?? 0),
    ) - offsetHours * 3_600_000;
    if (Number.isFinite(utcMs) && utcMs > now) return utcMs;
    return undefined;
  }
  // "重试 in 3600 seconds" / "将在 3600 秒后"
  const seconds = message.match(/(\d+)\s*(?:seconds?|秒)/iu);
  if (seconds) {
    const ms = Number(seconds[1]) * 1000;
    if (Number.isFinite(ms) && ms > 0) return now + ms;
  }
  return undefined;
}

/** 把上游错误体压成一句人话：JSON 认 msg/message，HTML（openresty 401）剥标签。 */
export function explainFailure(status, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const plain = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    payload = { msg: plain ? `HTTP ${status}（${plain}）` : `HTTP ${status}` };
  }
  return payload;
}

/**
 * 上游错误体 → 分类。
 *
 * 关键区分是「换一个号有没有用」：
 *   accountScoped=true  错误属于这个账号（令牌失效、配额用完、被封、排队），换号有意义；
 *   accountScoped=false 错误属于这份请求（400 参数错、11128 会话校验），换谁都是同样结果。
 * 把这两类混为一谈，会导致一个失效的旧号把整池拖死，或者一次 400 被当成账号故障刷掉全部号。
 */
export function classifyUpstream(status, payload) {
  const code = payload && typeof payload.code === 'number' ? payload.code : undefined;
  const msg = (payload && (payload.msg || payload.message)) || '';
  const retry = payload && payload.retry_policy ? payload.retry_policy.retry !== false : true;
  // openresty/APISIX 直接用 HTML 401，也要能被认成账号级失败，而不是当成网络抖动。
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false, accountScoped: true, reason: msg || `HTTP ${status}` };
  if (status === 429) return { kind: 'quota', retryable: true, accountScoped: true, reason: msg || 'quota' };
  if (code === 6020 || code === 6021 || code === 6022) return { kind: 'queue', retryable: false, accountScoped: false, reason: msg || 'queued' };
  if (code === 11140) return { kind: 'banned', retryable: false, accountScoped: true, reason: msg || 'channel rejected' };
  if (code === 11128) return { kind: 'client', retryable: false, accountScoped: false, reason: msg || 'conversation rejected' };
  if (code === 11101) return { kind: 'client', retryable: false, accountScoped: false, reason: msg || 'non-stream not supported' };
  if (status >= 500) return { kind: 'server', retryable: true, accountScoped: true, reason: msg || `HTTP ${status}` };
  if (status === 400) return { kind: 'client', retryable: false, accountScoped: false, reason: msg || 'bad request' };
  return { kind: retry ? 'server' : 'client', retryable: retry, accountScoped: retry, reason: msg || `HTTP ${status}` };
}

/**
 * 上游请求客户端。account 每次显式传入，令牌刷新后下一跳立即生效。
 */
export class Upstream {
  /**
   * @param {object} options
   * @param {Function} [options.fetchImpl] 替换底层 fetch，仅用于测试
   *   （签到、余额这些接口不该为了测试就去请求真实上游）。
   */
  constructor({ proxyUrl = '', timeoutMs = 300_000, fetchImpl } = {}) {
    this.proxyUrl = proxyUrl;
    this.timeoutMs = timeoutMs;
    this.dispatcher = undefined;
    this.fetchImpl = fetchImpl;
  }

  async #fetch(url, init) {
    if (this.fetchImpl) return this.fetchImpl(url, init);
    // Node 内置 fetch 不支持 proxy 环境变量；需要时用 undici 的 ProxyAgent。
    if (this.proxyUrl && !this.dispatcher) {
      try {
        const { ProxyAgent } = await import('undici');
        this.dispatcher = new ProxyAgent(this.proxyUrl);
      } catch {
        throw new Error('已配置上游代理，但 undici 不可用；请先 npm i undici，或清空代理设置');
      }
    }
    return fetch(url, this.dispatcher ? { ...init, dispatcher: this.dispatcher } : init);
  }

  async chat(account, body, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.#fetch(`${chatBase(account)}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(account),
      body: JSON.stringify(body),
      signal: combined,
    });
    if (response.ok) return { ok: true, response };
    const text = (await response.text()).slice(0, 8 * 1024);
    const payload = explainFailure(response.status, text);
    return { ok: false, status: response.status, payload, classification: classifyUpstream(response.status, payload), text };
  }

  /** 只发一条最小请求，问“这个账号此刻能不能用”，会被真实计费，所以由面板手动触发。 */
  async probe(account, model, signal) {
    const timeout = AbortSignal.timeout(45_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const body = shapeChatBody({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return this.chat(account, body, combined);
  }

  async refreshToken(account) {
    const response = await this.#fetch(`${chatBase(account)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(account),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = undefined; }
    if (!response.ok || !payload || payload.code !== 0) {
      throw new Error(`令牌续期失败：HTTP ${response.status} ${payload?.msg || text.slice(0, 200)}`);
    }
    const data = payload.data || {};
    if (typeof data.accessToken !== 'string' || data.accessToken === '') {
      throw new Error('令牌续期未返回 accessToken，请在 WorkBuddy 桌面端重新登录');
    }
    return {
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : account.refreshToken,
      expiresAtMs: typeof data.expiresIn === 'number' ? Date.now() + data.expiresIn * 1000 : account.expiresAtMs,
      refreshExpiresAtMs: typeof data.refreshExpiresIn === 'number' ? Date.now() + data.refreshExpiresIn * 1000 : account.refreshExpiresAtMs,
    };
  }

  /**
   * 拉模型目录（App 通道）。
   *
   * 上游 `/v3/config` 每个模型给出这些和「能力」有关的字段，全部原样带出来：
   *   reasoning.supportedEfforts / defaultEffort / canDisableThinking  → 推理强度档位
   *   contextWindow.supportedLengths / defaultLength                  → 可选上下文档位
   *   maxInputTokens / maxOutputTokens / supportsImages / supportsToolCall
   * 不给的一律留 null / 空数组，不在这一层编造默认值。
   */
  async fetchCatalog(account) {
    const response = await this.#fetch(`${chatBase(account)}/v3/config`, {
      method: 'GET',
      headers: {
        ...chatHeaders(account, { 'User-Agent': PRODUCT_UA }),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`模型目录读取失败：HTTP ${response.status}`);
    const payload = await response.json();
    const models = payload?.data?.models ?? payload?.models ?? [];
    return models.map(normalizeCatalogModel).filter((model) => typeof model.id === 'string' && model.id !== '');
  }


/** 积分余额（个人版），失败返回 undefined 而不是编造一个数。 */
  async fetchCredits(account) {
    try {
      const response = await this.#fetch(`${billingBase(account)}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: billingHeaders(account),
        body: JSON.stringify({ PageNumber: 1 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      const accounts = payload?.data?.Response?.Data?.Accounts;
      if (!Array.isArray(accounts)) return undefined;
      let remaining = 0;
      let size = 0;
      let counted = 0;
      for (const pack of accounts) {
        // 上游这批字段既可能是 number 也可能是字符串（"3135.01000281"），
        // 只判 typeof number 会把字符串值静默丢掉，最后算出 0 余额。
        const remain = Number(pack.CycleCapacityRemain);
        const total = Number(pack.CycleCapacitySize);
        if (Number.isFinite(remain)) { remaining += remain; counted += 1; }
        if (Number.isFinite(total)) size += total;
      }
      if (counted === 0) return undefined;
      return { remaining: +remaining.toFixed(4), size: +size.toFixed(4), packs: counted };
    } catch {
      return undefined;
    }
  }

  /**
   * 执行签到。
   *
   * 实测（2026-11-18）：路径是 `POST /v2/billing/meter/daily-checkin`，
   * 已签到时上游回 400 + code 10001「今天已签到，请明天再来」。
   * 「已签到」是**正常结果**不是错误，所以这里把它和真正的失败分开返回，
   * 免得面板把"今天已经签过了"显示成红色报错。
   */
  async checkin(account) {
    try {
      const response = await this.#fetch(`${billingBase(account)}/v2/billing/meter/daily-checkin`, {
        method: 'POST',
        headers: billingHeaders(account),
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = undefined; }
      const code = payload?.code;
      // 10001 = 今天已签过，属于"成功但无需动作"
      if (code === 10001) {
        return { ok: true, alreadyCheckedIn: true, message: payload?.msg || '今天已签到' };
      }
      if (!response.ok || code !== 0) {
        return {
          ok: false,
          status: response.status,
          code,
          message: payload?.msg || text.slice(0, 200) || `HTTP ${response.status}`,
        };
      }
      const data = payload?.data || {};
      return {
        ok: true,
        alreadyCheckedIn: false,
        // 上游签到成功后的 data 字段名与状态接口不完全一致，两种都认：
        // credit / today_credit 是"这次领到多少"，streak_days 是连续天数。
        credit: Number.isFinite(data.credit) ? data.credit
          : Number.isFinite(data.today_credit) ? data.today_credit : undefined,
        streakDays: Number.isFinite(data.streak_days) ? data.streak_days : undefined,
        streakBonusCredit: Number.isFinite(data.streak_bonus_credit) ? data.streak_bonus_credit : undefined,
        message: payload?.msg || '签到成功',
      };
    } catch (error) {
      return { ok: false, message: `网络错误：${error.message}` };
    }
  }

  /**
   * 查签到状态（只读，不会替你签到）。
   *
   * 上游返回 { code, msg, data: { today_checked_in, streak_days, daily_credit, ... } }。
   * 这里只把 data 那一层挑出来并统一字段名——面板读 checkin.today_checked_in，
   * 如果原样返回整包，界面永远是 undefined（实测踩过）。
   * 字段全部按上游原名保留，不加不减。
   */
  async fetchCheckin(account) {
    try {
      const response = await this.#fetch(`${billingBase(account)}/v2/billing/meter/checkin-activity-status`, {
        method: 'POST',
        headers: billingHeaders(account),
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return undefined;
      const payload = await response.json();
      const data = payload?.data;
      if (!data || typeof data !== 'object') return undefined;
      return {
        today_checked_in: data.today_checked_in === true,
        streak_days: Number.isFinite(data.streak_days) ? data.streak_days : null,
        daily_credit: Number.isFinite(data.daily_credit) ? data.daily_credit : null,
        today_credit: Number.isFinite(data.today_credit) ? data.today_credit : null,
        is_streak_day: data.is_streak_day === true,
        next_streak_day: Number.isFinite(data.next_streak_day) ? data.next_streak_day : null,
        streak_bonus_credit: Number.isFinite(data.streak_bonus_credit) ? data.streak_bonus_credit : null,
        active: data.active === true,
        checkedAt: Date.now(),
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * 把一个上游模型条目归一成网关内部形状。
 *
 * 只做「读取 + 形状统一 + 缺字段留空」，不做任何猜测：
 *   - 上游没给 supportedEfforts，就留空数组，而不是假设 ['low','high']；
 *   - 上游没给 contextWindow.supportedLengths，就退回 [maxInputTokens]；
 *   - 越界/非字符串的档位一律过滤掉。
 * 因为面板上这些开关会真的影响发给上游的请求，编一个默认值等于伪造能力。
 */
export function normalizeCatalogModel(model) {
  const reasoning = model?.reasoning && typeof model.reasoning === 'object' ? model.reasoning : undefined;
  // 上游有两种写法，实测 60 个模型里两种都存在：
  //   supportedEfforts: ['low','high','max']  → 多档可选（19 个模型）
  //   effort: 'high'                          → 单档固定（13 个模型）
  // 只认数组会把单档模型误判成"不支持推理"，面板上就显示「思考 不支持」。
  const declared = Array.isArray(reasoning?.supportedEfforts)
    ? reasoning.supportedEfforts
    : (typeof reasoning?.effort === 'string' ? [reasoning.effort] : []);
  const efforts = declared
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  const contextWindow = model?.contextWindow && typeof model.contextWindow === 'object' ? model.contextWindow : undefined;
  const lengths = Array.isArray(contextWindow?.supportedLengths)
    ? contextWindow.supportedLengths.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.trunc(n))
    : [];
  const maxInputTokens = Number.isFinite(model?.maxInputTokens) ? Math.trunc(model.maxInputTokens) : null;
  return {
    id: model?.id,
    name: model?.name || model?.id,
    vendor: model?.vendor ?? null,
    credits: model?.credits ?? model?.credit ?? null,
    descriptionZh: typeof model?.descriptionZh === 'string' ? model.descriptionZh : '',
    descriptionEn: typeof model?.descriptionEn === 'string' ? model.descriptionEn : '',
    supportsImages: model?.supportsImages === true,
    supportsToolCall: model?.supportsToolCall === true,
    supportsReasoning: model?.supportsReasoning === true,
    onlyReasoning: model?.onlyReasoning === true,
    maxInputTokens,
    maxOutputTokens: Number.isFinite(model?.maxOutputTokens) ? Math.trunc(model.maxOutputTokens) : null,
    tags: Array.isArray(model?.tags) ? model.tags.filter((tag) => typeof tag === 'string') : [],
    // 推理强度档位：这是「我该给这个模型传什么 effort」的唯一依据
    reasoning: reasoning
      ? {
        supportedEfforts: [...new Set(efforts)],
        // 单档形态时，这一档就是它唯一能用的值
        singleEffort: !Array.isArray(reasoning.supportedEfforts) && typeof reasoning.effort === 'string',
        defaultEffort: typeof reasoning.defaultEffort === 'string'
          ? reasoning.defaultEffort
          : (typeof reasoning.effort === 'string' ? reasoning.effort : null),
        canDisableThinking: reasoning.canDisableThinking === true,
        summary: typeof reasoning.summary === 'string' ? reasoning.summary : null,
      }
      : null,
    // 上下文档位：面板上 200K / 500K / 1M 那一排按钮的数据来源
    contextLengths: lengths.length > 0
      ? [...new Set(lengths)].sort((a, b) => a - b)
      : (maxInputTokens ? [maxInputTokens] : []),
  };
}
