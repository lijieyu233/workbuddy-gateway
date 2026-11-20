// OpenAI 兼容协议转换：把 /v1/chat/completions 的请求交给上游，把上游 chunk 原样/规范化吐回。
// 上游本身就发 OpenAI chat.completion.chunk，所以主流场景是直通；这里只做三件必要的事：
//   1) 上游只支持流式 → 非流式请求在网关侧聚合出一个完整响应；
//   2) 外部客户端可能把 reasoning_content 当正文 → 统一放进 delta.reasoning_content；
//   3) 用量与 credit 透传，便于客户端显示成本。
import { randomUUID } from 'node:crypto';
import { shapeChatBody, validateChatBody, parseQuotaResetAt } from './upstream.js';
import { normalizeModelSetting, applyModelSettings } from './modelsettings.js';

/** 单个请求的上下文，负责在重试之间复用同一份 body，并把上游 chunk 规范化。 */
export class ChatBridge {
  constructor({ pool, log, config }) {
    this.pool = pool;
    this.log = log;
    this.config = config;
  }

  /**
   * 主入口：处理一次 /v1/chat/completions。
   * 返回 { status, headers, body } —— stream 时 body 是 AsyncIterable<string>。
   */
  async chat(request, { apiKeyEntry, signal } = {}) {
    const startedAt = Date.now();
    const requestId = `chatcmpl-${randomUUID()}`;
    // 客户端可能把显示名当 id 传（"DeepSeek-V4.1-Flash"），上游只认 id。
    // 在整形之前先归一，否则会被上游 "model ... service info not found" 拒掉。
    const resolved = this.pool.resolveModel(request.body?.model);
    // 显示名重名（如 5 个模型都叫 "Hy4 preview"）：不能替用户猜，明确报错并列出候选 id。
    if (resolved.ambiguous) {
      const message = `模型名 "${request.body?.model}" 有歧义，请改用 id 之一：${resolved.candidates.join(' / ')}`;
      this.log.push({
        id: requestId, method: 'POST', path: '/v1/chat/completions', model: String(request.body?.model || ''), accountId: '-',
        stream: request.body?.stream === true, status: 400, ms: Date.now() - startedAt, error: message,
        keyLabel: apiKeyEntry?.label,
      });
      return this.#error(400, 'ambiguous_model', message);
    }
    const requestedModel = resolved.id;
    const shapedRequest = requestedModel === request.body?.model ? request.body : { ...request.body, model: requestedModel };

    // 逐模型设置（推理强度 / 关闭思考）：面板上选的东西必须真的进请求体，
    // 否则就是假开关。这里在整形之后应用，并记录实际改了什么。
    const catalogModel = (this.pool.catalog || []).find((item) => item.id === requestedModel);
    const stored = this.pool.modelSettings?.[requestedModel];
    const setting = stored === undefined
      ? undefined
      : normalizeModelSetting(stored, catalogModel);
    const withSettings = applyModelSettings(shapedRequest, catalogModel, setting);

    let body = shapeChatBody(withSettings.body);
    const wantsStream = request.body.stream === true;
    const model = typeof body.model === 'string' ? body.model : '';
    const appliedSettings = withSettings.applied;

    // 本地校验：有些请求发多少次都不会成功（最典型是空 messages，上游 400/11133）。
    // 与其消耗一次额度再拿回一句看不懂的"模型无法处理此请求"，不如当场说清楚。
    const invalid = validateChatBody(withSettings.body);
    if (invalid) {
      this.log.push({
        id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: '-',
        stream: wantsStream, status: 400, ms: Date.now() - startedAt, error: invalid,
        keyLabel: apiKeyEntry?.label, requestShape: describeBody(withSettings.body),
      });
      return this.#error(400, 'invalid_request', invalid);
    }

    const excluded = new Set();
    let lastFailure;
    // 11128 是「渠道校验」，同一份 body 换个号也是同样结果，所以不能靠换号解决。
    // 唯一有效的兜底是：第一轮用常规净化，被拒后用 dense 模式（把长 system 拆成
    // 多个 text part）再发一次。实测拆 part 能绕过跨句组合匹配。
    let dense = false;
    // 参数瘦身也只做一次，避免反复删字段重发。
    let slimmed = false;

    while (true) {
      if (this.pool.accounts.length === 0) {
        return this.#error(503, 'no_account', '账号池为空：请先在面板里导入 WorkBuddy 账号');
      }
      const account = this.pool.pick(excluded);
      if (!account) {
        const summary = this.pool.summary();
        const reason = lastFailure
          ? `所有可用账号都失败了，最后一次错误：${lastFailure}`
          : `没有可用账号（可用 ${summary.available}/${summary.total}，异常 ${summary.unavailable}）`;
        return this.#error(503, 'no_available_account', reason, lastFailure);
      }

      this.pool.acquire(account);
      try {
        await this.pool.ensureFreshToken(account);
      } catch (error) {
        this.pool.release(account);
        excluded.add(account.id);
        lastFailure = `账号 ${account.nickname || account.id} 令牌续期失败：${error.message}`;
        this.pool.markFailure(account, { kind: 'auth', retryable: false }, error.message);
        continue;
      }

      let upstream;
      try {
        upstream = await this.pool.upstream.chat(account, body, signal);
      } catch (error) {
        this.pool.release(account);
        excluded.add(account.id);
        lastFailure = `账号 ${account.nickname || account.id} 网络错误：${error.message}`;
        this.pool.markFailure(account, { kind: 'server', retryable: true }, error.message);
        continue;
      }

      if (!upstream.ok) {
        this.pool.release(account);
        const classification = upstream.classification;
        const message = describeUpstreamFailure(upstream);
        // 额度耗尽时上游会写明恢复时间，用它当冷却终点，别用固定 5 分钟硬猜。
        const resetAtMs = classification.kind === 'quota'
          ? parseQuotaResetAt(message)
          : undefined;

        // 渠道校验（11128）：换号没用，但换一种 body 形状可能有用。
        // 只重试一次，且必须还没往客户端吐过任何字节。
        if (classification.kind === 'client' && upstream.payload?.code === 11128 && !dense) {
          dense = true;
          // 重试也要重新套用逐模型设置，否则第二轮会把推理强度/关闭思考丢掉。
          body = shapeChatBody(applyModelSettings(shapedRequest, catalogModel, setting).body, { dense: true });
          this.pool.markFailure(account, classification, message, resetAtMs);
          lastFailure = `渠道校验拒绝（11128），已改用分段模式重试：${message}`;
          continue;
        }

        // 参数被上游拒（400）：换号没用（换谁都是同一份 body），但很可能是我把
        // 客户端的一些非标准字段原样转发了。做一次「瘦身」重试：只保留上游明确支持的字段。
        // 实测这句 "the request parameters were rejected by the model provider" 就是这样来的。
        if (upstream.status === 400 && !slimmed) {
          slimmed = true;
          const slim = slimBody(body);
          if (slim.removed.length > 0) {
            body = slim.body;
            this.pool.markFailure(account, classification, message, resetAtMs);
            lastFailure = `上游拒绝参数，已去掉 ${slim.removed.join('/')} 重试：${message}`;
            continue;
          }
        }

        // 模型名不认识：**不自动换模型**。
        //
        // 原来这里会静默改成默认模型重试，结果是用户填 "deepseek" 时，
        // 网关偷偷用 deepseek-v4.1-flash 执行并扣费（实测扣了 2.13 credit），
        // 日志还只记原始名字，用户完全不知道用的其实是另一个模型。
        // 不同模型倍率和能力都不同，替用户换等于替他花钱做决定。
        // 现在明确报错并列出可选 id。
        if (/service info not found|model .* not found/iu.test(message)) {
          // 注意：pool.catalog 是上游原始目录（没有 setting 字段），
          // 启用状态来自 modelSnapshot()，而它是 **Map（id → setting）**，不是数组。
          // 这里两种形状都兼容，避免再次误报"没有已启用模型"。
          const snapshot = this.pool.modelSnapshot?.();
          let entries = [];
          if (snapshot instanceof Map) {
            entries = [...snapshot.entries()].map(([id, setting]) => ({ id, setting }));
          } else if (Array.isArray(snapshot)) {
            entries = snapshot;
          } else if (Array.isArray(snapshot?.models)) {
            entries = snapshot.models;
          }
          const enabled = entries.filter((m) => m.setting?.enabled === true);
          const list = enabled.length > 0 ? enabled : entries;
          const available = list.slice(0, 8).map((m) => m.id);
          this.pool.markFailure(account, classification, message, resetAtMs);
          const hint = available.length
            ? `模型 "${model}" 不存在。可用的有：${available.join(' / ')}`
            : `模型 "${model}" 不存在，且当前没有已启用的模型`;
          this.log.push({
            id: requestId, method: 'POST', path: '/v1/chat/completions', model,
            accountId: account.id, stream: wantsStream,
            status: 400, ms: Date.now() - startedAt, error: hint,
          });
          return this.#error(400, 'model_not_found', hint);
        }

        // 账号级失败（令牌失效/配额/被封/5xx）：这个号不行，换成池里下一个。
        // 请求级失败（400 参数错、排队）：换谁都是同一结果，直接回给调用方，
        // 否则一次错误请求会把整池账号逐个冷却掉。
        if (classification.accountScoped && this.config.autoRotate) {
          excluded.add(account.id);
          this.pool.markFailure(account, classification, message, resetAtMs);
          lastFailure = `账号 ${account.nickname || account.id}：${message}`;
          continue;
        }
        this.pool.markFailure(account, classification, message, resetAtMs);
        this.log.push({
          id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
          stream: wantsStream, status: upstream.status, ms: Date.now() - startedAt, error: message,
          keyLabel: apiKeyEntry?.label,
          // 失败时记下请求体的"形状"（字段名 + 消息角色/长度），不记正文内容。
          // 这类 400 不看到底发了什么字段根本查不出来。
          requestShape: describeBody(body),
        });
        const status = classification.kind === 'quota' ? 429 : upstream.status > 0 ? upstream.status : 502;
        return this.#error(status, classification.kind, message);
      }

      // 拿到 200：开始往客户端吐字节。一旦开始输出，就不能再换号重试（会重复内容）。
      if (wantsStream) {
        // 幂等释放：生成器跑完会调，调用方发现客户端断开也会调，只生效一次。
        let released = false;
        const releaseOnce = () => {
          if (released) return;
          released = true;
          this.pool.release(account);
        };
        return {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-workbuddy-account': headerSafe(account.nickname || account.id),
          },
          releaseOnce,
          body: this.#streamOut({ upstream, account, requestId, model, startedAt, apiKeyEntry, signal, releaseOnce }),
        };
      }

      const aggregate = await this.#aggregate({ upstream, account, requestId, model, startedAt, apiKeyEntry, signal });
      return aggregate;
    }
  }

  /**
   * 流式输出：规范化后转发，结束时把 usage 记进账号池与请求日志。
   *
   * 并发额度（inflight）的释放不放在最外层的 finally 里赌，而是挂到
   * `releaseOnce` 上，由这里和调用方（server.js）各调一次、内部只生效一次。
   * 原因：客户端断开时这个生成器可能卡在 reader.read() 上永远不返回，
   * 它的 finally 就永远不跑——实测 release 一次都没执行，inflight 永久加一，
   * 取消几次就把账号按并发上限堵死。调用方持有 res，能立刻知道客户端走了。
   */
  async *#streamOut({ upstream, account, requestId, model, startedAt, apiKeyEntry, signal, releaseOnce }) {
    let usage;
    try {
      for await (const event of readChunks(upstream.response.body, signal)) {
        if (event.done) break;
        const chunk = normalizeChunk(event.data, requestId, model);
        if (!chunk) continue;
        if (chunk.usage) usage = chunk.usage;
        // 所有 chunk 统一用网关自己的 id：上游最后一块会带一次上游 id，
        // 客户端按 id 归并流时会把它当成另一条响应。
        chunk.id = requestId;
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      yield 'data: [DONE]\n\n';
      this.pool.markSuccess(account, usage);
      this.log.push({
        id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
        stream: true, status: 200, ms: Date.now() - startedAt,
        promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
        credit: typeof usage?.credit === 'number' ? usage.credit : undefined,
        keyLabel: apiKeyEntry?.label,
      });
    } catch (error) {
      // 客户端主动断开（用户点了停止、关了页面、切走了会话）不是账号故障。
      // 之前这里无条件 markFailure，导致一次取消就把账号冷却 1 分钟，
      // 面板上出现「可用 0/1、冷却 1」，下一次请求直接 503 —— 明明上游好着。
      if (signal?.aborted || isAbortError(error)) {
        this.log.push({
          id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
          stream: true, status: 200, ms: Date.now() - startedAt, error: '客户端取消',
          keyLabel: apiKeyEntry?.label,
        });
        return;
      }
      // 已经吐了一半才断：只记日志，不能重试（否则客户端会看到重复内容）。
      this.log.push({
        id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
        stream: true, status: 200, ms: Date.now() - startedAt, error: `流中断：${error.message}`,
        keyLabel: apiKeyEntry?.label,
      });
      this.pool.markFailure(account, { kind: 'server', retryable: true }, `流中断：${error.message}`);
    } finally {
      releaseOnce?.();
    }
  }

  /** 聚合流式响应成一个非流式 chat.completion。 */
  async #aggregate({ upstream, account, requestId, model, startedAt, apiKeyEntry, signal }) {
    let content = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage;
    const toolCalls = new Map();
    try {
      for await (const event of readChunks(upstream.response.body, signal)) {
        if (event.done) break;
        const chunk = event.data;
        if (!chunk || !Array.isArray(chunk.choices)) continue;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices) {
          const delta = choice.delta || {};
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const index = typeof call.index === 'number' ? call.index : 0;
              const current = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.function.name += call.function.name;
              if (call.function?.arguments) current.function.arguments += call.function.arguments;
              toolCalls.set(index, current);
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        // 非流式路径上客户端断开同样不该冷却账号。
        this.log.push({
          id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
          stream: false, status: 200, ms: Date.now() - startedAt, error: '客户端取消',
          keyLabel: apiKeyEntry?.label,
        });
        return this.#error(499, 'client_cancelled', '客户端取消了请求');
      }
      this.pool.markFailure(account, { kind: 'server', retryable: true }, `上游中断：${error.message}`);
      return this.#error(502, 'upstream_aborted', `上游中断：${error.message}`);
    } finally {
      this.pool.release(account);
    }

    this.pool.markSuccess(account, usage);
    this.log.push({
      id: requestId, method: 'POST', path: '/v1/chat/completions', model, accountId: account.id,
      stream: false, status: 200, ms: Date.now() - startedAt,
      promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens,
      credit: typeof usage?.credit === 'number' ? usage.credit : undefined,
      keyLabel: apiKeyEntry?.label,
    });

    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call], index) => ({
        ...call,
        id: call.id || `call_${index}`,
      }));
      message.content = content === '' ? null : content;
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-workbuddy-account': headerSafe(account.nickname || account.id) },
      body: {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || upstream.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: usage ? normalizeUsage(usage) : undefined,
      },
    };
  }

  #error(status, code, message, detail) {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        error: {
          message,
          type: code,
          code,
          ...(detail && detail !== message ? { detail } : {}),
        },
      },
    };
  }
}

/**
 * 把上游失败拼成一句能排查、能行动的话。
 *
 * 之前直接用 `msg` 当错误信息，面板上只剩一句英文
 * "the request parameters were rejected by the model provider"——没有 code、
 * 没有原因、没有下一步，等于什么都没说。
 *
 * 上游 400 的响应其实信息很全（实测 11133）：
 *   msg: "Invalid request parameters"
 *   extError: { code:'invalid_request_error', message:'the request parameters were rejected…' }
 *   displayMsg.zh / displayTips.zh: 中文解释 + 建议
 *   actions: ['SWITCH_MODEL','NEW_CONVERSATION',…]  ← 上游自己告诉我们该怎么办
 * 这里把 code、中文提示、建议动作都带上，并给 11133 补一句我们自己的判断
 * （通常是图片用了裸 base64 而不是 data URL）。
 */
export function describeUpstreamFailure(upstream) {
  const payload = upstream.payload || {};
  const code = typeof payload.code === 'number' ? payload.code : undefined;
  const raw = payload.msg || payload.message || upstream.text?.slice(0, 200) || `HTTP ${upstream.status}`;
  const ext = payload.extError && typeof payload.extError === 'object' ? payload.extError : undefined;
  const zh = payload.displayTips?.zh || payload.displayMsg?.zh || '';
  const actions = Array.isArray(payload.actions) ? payload.actions.filter((a) => typeof a === 'string') : [];

  const parts = [];
  parts.push(code === undefined ? raw : `${raw}（code ${code}）`);
  // extError.message 往往比 msg 具体，但同义重复时不要叠加
  if (ext?.message && typeof ext.message === 'string' && !raw.includes(ext.message)) parts.push(ext.message);
  if (zh) parts.push(zh);
  if (actions.length > 0) parts.push(`上游建议：${actions.map(actionLabel).join(' / ')}`);
  // 我们自己的判断，比上游的通用提示更具体
  if (code === 11133) parts.push('常见原因是图片以裸 base64 发送，应使用 data:image/...;base64, 形式');
  return parts.join(' · ');
}

/** 把上游的 actions 翻成可读的中文，别让用户猜 SWITCH_MODEL 是什么意思。 */
function actionLabel(action) {
  const map = {
    SWITCH_MODEL: '换个模型',
    NEW_CONVERSATION: '新建会话',
    SUBMIT_FEEDBACK: '提交反馈',
    RETRY: '重试',
  };
  return map[action] || action;
}

/**
 * 上游明确接受的请求字段（实测过的白名单）。
 *
 * 400 "the request parameters were rejected by the model provider" 通常是
 * 客户端塞了上游不认的字段（各家 SDK 都在 OpenAI 协议上加了私货：
 * `metadata`、`store`、`service_tier`、`parallel_tool_calls`…）。
 * 与其逐个试，不如在失败时裁掉白名单之外的字段再发一次。
 */
export const UPSTREAM_FIELDS = new Set([
  'model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', 'stop',
  'tools', 'tool_choice', 'functions', 'response_format', 'reasoning_effort',
  'thinking', 'n', 'presence_penalty', 'frequency_penalty', 'seed',
  'max_completion_tokens',
]);

/**
 * 裁掉白名单外的字段。返回裁掉的名字，供日志说明"这次为什么能过"。
 * 没有可裁的就返回空数组，调用方据此避免无意义的重试。
 */
export function slimBody(body) {
  if (!body || typeof body !== 'object') return { body, removed: [] };
  const removed = [];
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (UPSTREAM_FIELDS.has(key)) out[key] = value;
    else removed.push(key);
  }
  return { body: out, removed };
}

/**
 * 描述一份请求体的「形状」：有哪些顶层字段、消息有几条什么角色、content 是字符串还是 parts。
 * 刻意**不**包含任何正文内容，只留排查 400 必需的结构信息。
 */
export function describeBody(body) {
  if (!body || typeof body !== 'object') return '';
  const fields = Object.keys(body).sort();
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => {
      const role = m?.role ?? '?';
      const kind = typeof m?.content === 'string' ? `str(${m.content.length})` : Array.isArray(m?.content) ? 'parts' : (m?.content === undefined ? 'none' : typeof m.content);
      const extra = [];
      if (Array.isArray(m?.content)) {
        extra.push(m.content.map((p) => (p && typeof p.type === 'string' ? p.type : '?')).join('+'));
      }
      if (Array.isArray(m?.tool_calls)) extra.push(`tc${m.tool_calls.length}`);
      if (typeof m?.tool_call_id === 'string') extra.push('tcid');
      if (typeof m?.name === 'string') extra.push('name');
      return `${role}:${kind}${extra.length ? '(' + extra.join(',') + ')' : ''}`;
    })
    : [];
  return JSON.stringify({ fields, messages, count: Array.isArray(body.messages) ? body.messages.length : -1 });
}

/** 客户端断开 / 超时取消的判定：这类错误不该算到账号头上。 */
function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const message = String(error.message || '');
  return /aborted|abort|cancelled|canceled/iu.test(message);
}

/**
 * HTTP 响应头只能是 ASCII（Node 对非 ASCII 会直接抛 ERR_INVALID_CHAR）。
 * 上游账号昵称经常是中文（「测试号」「永恒海星派大星」…），
 * 直接塞进 x-workbuddy-account 会让整个响应失败 —— 这会让所有流式请求挂掉，
 * 而且表面上像是随机的 500，很难从现象追到原因。
 * 所以这里做百分号编码，非 ASCII 一律转义；客户端按需解码即可。
 */
export function headerSafe(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  // encodeURIComponent 会把中文转成 %XX；它保留的字符都是 ASCII 安全字符。
  // 额外把"技术上合法但容易出问题"的字符也编码掉。
  return encodeURIComponent(text).replace(/[!'()*]/gu, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeUsage(usage) {
  const out = {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
  if (typeof usage.credit === 'number') out.credit = usage.credit;
  if (usage.completion_tokens_details) out.completion_tokens_details = usage.completion_tokens_details;
  if (usage.prompt_tokens_details) out.prompt_tokens_details = usage.prompt_tokens_details;
  return out;
}

/** 上游 chunk → 规范 chunk。丢掉 extra_fields 之类的上游私有字段，保留 reasoning 与 tool_calls。 */
export function normalizeChunk(chunk, fallbackId, fallbackModel) {
  if (!chunk || typeof chunk !== 'object') return undefined;
  const choices = Array.isArray(chunk.choices) ? chunk.choices.map((choice) => {
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const clean = { role: delta.role };
    if (typeof delta.content === 'string' && delta.content !== '') clean.content = delta.content;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') clean.reasoning_content = delta.reasoning_content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      clean.tool_calls = delta.tool_calls.map((call, index) => ({
        index: typeof call.index === 'number' ? call.index : index,
        ...(call.id ? { id: call.id } : {}),
        type: call.type || 'function',
        function: {
          ...(call.function?.name ? { name: call.function.name } : {}),
          ...(call.function?.arguments ? { arguments: call.function.arguments } : {}),
        },
      }));
    }
    for (const key of Object.keys(clean)) if (clean[key] === undefined) delete clean[key];
    return {
      index: choice.index ?? 0,
      delta: Object.keys(clean).length > 0 ? clean : { content: '' },
      finish_reason: choice.finish_reason || null,
    };
  }) : [];
  return {
    id: chunk.id || fallbackId,
    object: 'chat.completion.chunk',
    created: chunk.created || Math.floor(Date.now() / 1000),
    model: chunk.model || fallbackModel,
    choices,
    ...(chunk.usage ? { usage: normalizeUsage(chunk.usage) } : {}),
  };
}

/**
 * 读上游 SSE。
 *
 * abort 必须能**立刻**打断 `reader.read()`，否则客户端断开时这个生成器会卡在
 * 一次 read 上，外层的 `iterator.return()` 也要等到下一次 chunk 才生效——
 * 实测结果是 `release()` 一次都没跑，inflight 永久加一，取消几次就把账号堵死。
 * 所以这里监听 signal，abort 时主动 cancel reader，让 read() 立即以 done 结束。
 */
export async function* readChunks(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    // 不 await：这里只需要让 read() 尽快失败/结束，异常由 finally 统一处理。
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    while (true) {
      if (aborted) return;
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        // abort 导致 read 抛错，属于正常取消路径
        return;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line === '' || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { yield { done: true }; return; }
        try { yield { data: JSON.parse(data) }; } catch { /* 跳过非 JSON 行 */ }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}
