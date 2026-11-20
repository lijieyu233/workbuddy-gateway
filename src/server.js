// HTTP 服务：对外 /v1（OpenAI 兼容），对内 /api（面板控制面）。
// 面板接口只允许回环访问，除非用户显式打开 allowPanelFromLan。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatBridge, normalizeChunk, readChunks } from './bridge.js';
import { shapeChatBody } from './upstream.js';
import { applyModelSettings } from './modelsettings.js';
import { findApiKey, ensureApiKey, newApiKey, maskKey, saveConfig } from './config.js';
import { redact, parseAuthDocument, parseImportPayload, mergeScanned, accountIdOf } from './accounts.js';
import { scanDesktopAccounts } from './accounts.js';
import { RequestLog } from './requestlog.js';

const here = dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = join(here, 'panel', 'index.html');

const MAX_BODY = 32 * 1024 * 1024;

export function createGateway({ config, pool }) {
  ensureApiKey(config);
  const log = new RequestLog(config);
  if (!pool.catalog) pool.syncCatalog().catch(() => { ensureCatalogFallback(pool); });
  const bridge = new ChatBridge({ pool, log, config });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname.startsWith('/v1/')) return await handleOpenAi(req, res, url, { config, pool, bridge, log });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, { config, pool, log });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = readFileSync(PANEL_HTML, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
    } catch (error) {
      // 客户端已经走了就别再回 500：那会在一个已销毁的响应上写头，
      // 客户端收到的是 `HTTP/1.1 500 OK` 这种连状态文本都对不上的东西（实测踩过）。
      if (res.destroyed || res.writableEnded || res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: error.message, type: 'internal' } }));
      } catch {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return { server, log, bridge };
}

function ensureCatalogFallback(pool) {
  pool.catalog = [];
  pool.catalogAt = 0;
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }); }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- OpenAI 面

async function handleOpenAi(req, res, url, { config, pool, bridge, log }) {
  if (!config.gatewayEnabled) {
    return sendJson(res, 503, { error: { message: '网关当前已关闭：请在面板里点击“运行中”开启', type: 'gateway_disabled' } });
  }
  const entry = findApiKey(config, req.headers.authorization || '');
  if (!entry) {
    return sendJson(res, 401, { error: { message: '缺少或无效的 API Key（Authorization: Bearer agt_...）', type: 'invalid_api_key' } });
  }
  entry.lastUsedAt = Date.now();
  entry.requests = (entry.requests || 0) + 1;

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = pool.catalog || [];
    const settings = pool.modelSnapshot();
    return sendJson(res, 200, {
      object: 'list',
      // 只列出用户在面板里启用的模型：这和「一键启用」是同一个开关，
      // 否则客户端看到一堆模型却不知道哪些真的配好了。
      // 一个都没启用时退回全部，避免用户刚装好就看到空列表。
      data: (settings.size > 0 && [...settings.values()].some((item) => item.enabled)
        ? models.filter((model) => settings.get(model.id)?.enabled)
        : models
      ).map((model) => {
        const setting = settings.get(model.id);
        return {
          id: model.id,
          object: 'model',
          created: 0,
          // owned_by 固定值：上游 vendor 是单字母内部代号（e/f/j），直接给客户端只会显示成 "f"
          owned_by: 'workbuddy',
          vendor: model.vendor ?? null,
          // 能力字段：客户端可以据此决定要不要发图/工具
          capabilities: {
            images: model.supportsImages === true,
            tools: model.supportsToolCall === true,
            reasoning: model.supportsReasoning === true,
            onlyReasoning: model.onlyReasoning === true,
            canDisableThinking: model.reasoning?.canDisableThinking === true,
            supportedEfforts: model.reasoning?.supportedEfforts ?? [],
            defaultEffort: model.reasoning?.defaultEffort ?? null,
            contextLengths: model.contextLengths ?? [],
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
          },
          // 当前生效值：客户端读到这里就知道实际会用什么强度
          effective: setting ? { reasoningEffort: setting.effectiveEffort, disableThinking: setting.disableThinking, contextLength: setting.contextLength } : undefined,
        };
      }),
    });
  }

  if (req.method === 'GET' && url.pathname === '/v1/me') {
    return sendJson(res, 200, { keyLabel: entry.label, pool: pool.summary() });
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions')) {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: { message: '请求体为空', type: 'bad_request' } });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const result = await bridge.chat({ body }, { apiKeyEntry: entry, signal: controller.signal });
    if (result.status !== 200) {
      return sendJson(res, result.status, result.body);
    }
    // 兜底：无论后面写流/收尾哪一步出问题，客户端断开（res close）时额度一定归还。
    // releaseOnce 内部幂等，这里挂一次就够，不需要别处再兜。
    res.once('close', () => result.releaseOnce?.());

    res.writeHead(result.status, result.headers);
    if (result.body && typeof result.body[Symbol.asyncIterator] === 'function') {
      const iterator = result.body[Symbol.asyncIterator]();
      // 客户端断开时 next() 可能还挂在上游的 read() 上，它自己不会醒。
      // 这里用 abort 把等待 race 掉，保证 finally 一定能执行、额度一定还回去。
      //
      // 两个容易踩的点：
      //   1) 监听不能用 { once: true }：一轮 race 结束后要能再次被唤醒，
      //      否则 abort 在第二轮之前发生就没人接；
      //   2) 每轮都检查 signal.aborted，而不是只信事件——事件可能已经错过了。
      let aborted = false;
      let wakeAbort;
      let released = false;
      const onAbort = () => {
        aborted = true;
        const wake = wakeAbort;
        wakeAbort = undefined;
        wake?.();
      };
      controller.signal.addEventListener('abort', onAbort);
      if (controller.signal.aborted) onAbort();
      try {
        while (!aborted && !controller.signal.aborted) {
          const waited = await Promise.race([
            iterator.next().then((value) => ({ value, aborted: false })),
            new Promise((resolve) => {
              wakeAbort = () => resolve({ aborted: true });
              if (controller.signal.aborted) resolve({ aborted: true });
            }),
          ]);
          wakeAbort = undefined;
          if (waited.aborted || controller.signal.aborted) break;
          const { done, value } = waited.value;
          if (done) break;
          if (res.writableEnded || res.destroyed) break;
          res.write(value);
        }
      } catch {
        // 客户端断开时 write 会抛，这里吞掉：断开不是错误，下面统一收尾。
      } finally {
        wakeAbort = undefined;
        controller.signal.removeEventListener('abort', onAbort);
        // 双重保障，缺一不可：
        // 1) iterator.return() 让生成器收尾（它会 await，不保证立即返回，所以不能只靠它）；
        // 2) 直接还并发额度 —— 这是唯一可靠的还额度点。
        //    只靠生成器的 finally 会漏：next() 挂在上游 read() 上时它永远不跑，
        //    实测 release 一次都没执行，inflight 永久加一，取消几次就把账号堵死。
        if (!released) {
          released = true;
          result.releaseOnce?.();
        }
        try { iterator.return?.(); } catch { /* ignore */ }
        if (!res.writableEnded && !res.destroyed) res.end();
      }
      return;
    }
    res.end(JSON.stringify(result.body));
    return;
  }

  // /v1/responses：把 Responses 风格的 input 折成 chat 请求，再把结果折回 responses 对象。
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const body = await readBody(req);
    const translated = responsesToChat(body);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const result = await bridge.chat({ body: { ...translated, stream: false } }, { apiKeyEntry: entry, signal: controller.signal });
    if (result.status !== 200) return sendJson(res, result.status, result.body);
    return sendJson(res, 200, chatToResponses(result.body));
  }

  sendJson(res, 404, { error: { message: `不支持的接口 ${req.method} ${url.pathname}`, type: 'not_found' } });
}

export function responsesToChat(body) {
  const input = body?.input;
  const messages = [];
  const system = typeof body?.instructions === 'string' && body.instructions !== '' ? body.instructions : '';
  const push = (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'message' && Array.isArray(message.content)) {
      const text = message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
      messages.push({ role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user', content: text });
    }
  };
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) input.forEach(push);
  const out = {
    model: body?.model,
    messages: system !== '' ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: false,
  };
  if (typeof body?.max_output_tokens === 'number') out.max_tokens = body.max_output_tokens;
  if (typeof body?.temperature === 'number') out.temperature = body.temperature;
  return out;
}

export function chatToResponses(completion) {
  const choice = completion?.choices?.[0] || {};
  const text = choice.message?.content || '';
  return {
    id: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response',
    created_at: completion?.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: completion?.model,
    output: [{
      type: 'message',
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: completion?.usage ? {
      input_tokens: completion.usage.prompt_tokens,
      output_tokens: completion.usage.completion_tokens,
      total_tokens: completion.usage.total_tokens,
    } : undefined,
  };
}

// ---------------------------------------------------------------- 面板控制面

async function handleApi(req, res, url, { config, pool, log }) {
  if (!config.allowPanelFromLan && !isLoopback(req)) {
    return sendJson(res, 403, { error: { message: '面板默认只允许本机访问', type: 'forbidden' } });
  }
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/state') {
    const accounts = pool.accounts.map((account) => redact(account, pool.snapshot().find((item) => item.id === account.id) || {}));
    const lan = lanAddresses();
    // 面板要渲染每个模型的开关与档位，必须把「当前设置」一并带上。
    // 只给裸目录的话，renderModels 里 model.setting 恒为空，
    // 界面会永远显示"未启用 / 不思考"——点了按钮服务端存了值，界面却不动。
    const settingMap = pool.modelSnapshot();
    const catalogModels = (pool.catalog || []).map((model) => ({
      ...model,
      setting: settingMap.get(model.id),
    }));
    return sendJson(res, 200, {
      config: publicConfig(config),
      pool: pool.summary(),
      accounts,
      catalog: { models: catalogModels, at: pool.catalogAt || 0 },
      // 账号池合计积分：面板顶部那张卡显示这个，比"某模型已用 63%"有意义得多。
      credits: pool.creditSummary(),
      logs: log.recent(40),
      stats: log.stats(),
      endpoint: {
        host: config.listen === 'lan' ? '0.0.0.0' : '127.0.0.1',
        port: config.port,
        baseUrl: `http://127.0.0.1:${config.port}/v1`,
        // 局域网模式下要给真实网卡地址，不能放 <本机IP> 这种占位符——
        // 那等于让用户自己去猜，而且填进客户端也是错的。
        lanUrls: lan.map((ip) => `http://${ip}:${config.port}/v1`),
        lanAddresses: lan,
      },
    });
  }

  if (route === 'POST /api/gateway') {
    const body = await readBody(req) || {};
    if (typeof body.enabled === 'boolean') {
      config.gatewayEnabled = body.enabled;
      saveConfig(config);
    }
    return sendJson(res, 200, { gatewayEnabled: config.gatewayEnabled });
  }

  if (route === 'POST /api/config') {
    const body = await readBody(req) || {};
    const allowed = ['listen', 'autoRotate', 'tokenRefresh', 'maxConcurrentPerAccount', 'proxyUrl', 'allowPanelFromLan'];
    for (const key of allowed) if (key in body) config[key] = body[key];
    if (body.requestLog && typeof body.requestLog === 'object' && 'enabled' in body.requestLog) {
      config.requestLog.enabled = body.requestLog.enabled !== false;
    }
    Object.assign(config, normalizeInPlace(config));
    saveConfig(config);
    return sendJson(res, 200, { config: publicConfig(config) });
  }

  if (route === 'POST /api/sync-accounts') {
    const scanned = scanDesktopAccounts();
    const { store, added, updated } = mergeScanned(pool.store, scanned);
    pool.store = store;
    pool.persist();
    // reload() 从磁盘重读并给新账号建 runtime 条目；不重载的话新号没法被调度。
    pool.reload();
    return sendJson(res, 200, { scanned: scanned.length, added, updated, pool: pool.summary() });
  }

  if (route === 'POST /api/accounts/import') {
    const body = await readBody(req) || {};
    const text = typeof body.text === 'string' ? body.text : '';
    // 支持数组 / {accounts:[...]} / 单个 auth 文档三种形状，按结构自动分辨。
    const { records, errors } = parseImportPayload(text);
    if (records.length === 0) {
      return sendJson(res, 400, {
        error: {
          message: errors[0] || '没有解析出任何账号',
          type: 'bad_request',
          // 逐项原因一并回给面板，避免"导入失败但不知道哪里失败"
          details: errors.slice(0, 20),
        },
      });
    }
    let added = 0;
    let existed = 0;
    for (const record of records) {
      const result = pool.addAccount(record);
      if (result.added) added += 1;
      else existed += 1;
    }
    return sendJson(res, 200, {
      added,
      existed,
      total: records.length,
      errors,
      pool: pool.summary(),
    });
  }

  if (route === 'GET /api/accounts/export') {
    // 导出成**和导入兼容的格式**：snake_case 的顶层数组。
    //
    // 支持按 id 选择：?ids=a,b,c 只导这几个；不带 ids 才是全部。
    // 一次只能全量导出是很别扭的——想备份单个号或分享一个号时没得选。
    const wanted = (url.searchParams.get('ids') || '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const selected = wanted.length > 0
      ? pool.accounts.filter((account) => wanted.includes(account.id))
      : pool.accounts;
    if (selected.length === 0) {
      return sendJson(res, 404, { error: { message: '没有匹配到要导出的账号', type: 'not_found' } });
    }
    const exported = selected.map((account) => ({
      id: `workbuddy_${account.id}`,
      email: account.nickname || '',
      uid: account.uid || '',
      nickname: account.nickname || '',
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      token_type: 'Bearer',
      domain: account.domain || '',
      expires_at: account.expiresAtMs,
      refresh_expires_at: account.refreshExpiresAtMs,
      uin: account.uin || '',
      // 便于对方核对，不含敏感信息
      account_type: account.accountType || '',
      credits: account.credits
        ? { remaining: account.credits.remaining, total: account.credits.size, packs: account.credits.packs }
        : undefined,
    }));
    // 文件名必须是纯 ASCII：HTTP 头不允许非 ASCII 字符，
    // 之前拼了中文（"-全部"/"-1个"），浏览器收到的是
    // "Invalid character in header content [content-disposition]" 500。
    const suffix = wanted.length > 0 ? `-${wanted.length}` : '-all';
    res.setHeader(
      'content-disposition',
      `attachment; filename="workbuddy-accounts${suffix}-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return sendJson(res, 200, exported);
  }

  let match = url.pathname.match(/^\/api\/accounts\/([0-9a-f]{6,64})$/);
  if (match) {
    const id = match[1];
    if (req.method === 'PATCH') {
      const body = await readBody(req) || {};
      const account = pool.updateAccount(id, body);
      if (!account) return sendJson(res, 404, { error: { message: '账号不存在', type: 'not_found' } });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      const removed = pool.removeAccount(id);
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: { message: '账号不存在', type: 'not_found' } });
    }
  }

  match = url.pathname.match(/^\/api\/accounts\/([0-9a-f]{6,64})\/(probe|usage|reset|checkin)$/);
  if (match && req.method === 'POST') {
    const [, id, action] = match;
    const account = pool.get(id);
    if (!account) return sendJson(res, 404, { error: { message: '账号不存在', type: 'not_found' } });
    if (action === 'reset') {
      // 「复位」要有可感知的结果，否则就是假按钮。
      // 现在它做三件真实的事：
      //   1. 清掉失败记录（让这个号立刻回到正常选号排位）；
      //   2. 重新拉一次余额和签到（顺手把可能过期的显示刷新）；
      //   3. 尝试续期令牌（如果之前因为令牌问题失败过）。
      const account = pool.get(id);
      pool.clearError(account);
      const result = { ok: true, clearedError: true };
      try {
        await pool.ensureFreshToken(account);
        const usage = await pool.syncAccountUsage(id);
        result.credits = usage.credits;
        result.checkin = usage.checkin ? { today_checked_in: usage.checkin.today_checked_in, streak_days: usage.checkin.streak_days } : undefined;
        result.refreshed = true;
      } catch (error) {
        result.refreshed = false;
        result.refreshError = error.message;
      }
      return sendJson(res, 200, { ...result, pool: pool.summary() });
    }
    if (action === 'usage') {
      const usage = await pool.syncAccountUsage(id);
      return sendJson(res, 200, usage);
    }
    if (action === 'checkin') {
      // 签到是真实副作用（会领到积分）。已签到时上游回 10001，
      // 这里当成功返回并标注 alreadyCheckedIn，不让面板显示成红色错误。
      try {
        const result = await pool.checkin(id);
        return sendJson(res, result.ok ? 200 : 502, result);
      } catch (error) {
        return sendJson(res, 502, { ok: false, message: error.message });
      }
    }
    // probe：真发一条最小请求，会真实计费，按钮上必须写明。
    const model = (await readBody(req))?.model || 'deepseek-v4.1-flash';
    const result = await pool.upstream.probe(account, model);
    if (result.ok) {
      await result.response.text();
      pool.clearError(account);
      return sendJson(res, 200, { ok: true, model });
    }
    pool.markFailure(account, result.classification, result.classification.reason);
    return sendJson(res, 200, { ok: false, model, status: result.status, reason: result.classification.reason, kind: result.classification.kind });
  }

  if (route === 'POST /api/checkin/refresh') {
    // 只读地查一遍每个账号的签到状态（不执行签到）。
    // 面板加载时调一次，这样「今天签没签」有真实数据可显示，
    // 而不是一排「—」等着用户逐个点。
    const results = [];
    for (const account of pool.accounts) {
      try {
        await pool.ensureFreshToken(account);
        const status = await pool.upstream.fetchCheckin(account);
        if (status) {
          const rt = pool.runtimeOf(account.id);
          rt.checkin = status;
          account.checkin = status;
          results.push({ id: account.id, ok: true, todayCheckedIn: status.today_checked_in === true });
        } else {
          results.push({ id: account.id, ok: false, reason: '上游没有返回签到状态' });
        }
      } catch (error) {
        results.push({ id: account.id, ok: false, reason: error.message });
      }
    }
    pool.persist();
    return sendJson(res, 200, { results });
  }

  if (route === 'POST /api/catalog/refresh') {
    const models = await pool.syncCatalog();
    return sendJson(res, 200, { count: models.length, models });
  }

  if (route === 'GET /api/models/settings') {
    // 目录 + 每个模型当前生效的设置（含"没设置时上游默认值"）
    const snapshot = pool.modelSnapshot();
    const models = (pool.catalog || []).map((model) => ({
      ...model,
      setting: snapshot.get(model.id) ?? undefined,
    }));
    return sendJson(res, 200, { models, at: pool.catalogAt || 0 });
  }

  if (route === 'POST /api/models/settings') {
    const body = await readBody(req) || {};
    if (typeof body.modelId !== 'string') {
      return sendJson(res, 400, { error: { message: '缺少 modelId', type: 'bad_request' } });
    }
    const updated = pool.updateModelSetting(body.modelId, {
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      // null 是合法值，表示"不思考"（显式清空档位），不能当成"没传"丢掉
      ...('reasoningEffort' in body ? { reasoningEffort: body.reasoningEffort } : {}),
      ...('disableThinking' in body ? { disableThinking: body.disableThinking } : {}),
      ...('contextLength' in body ? { contextLength: body.contextLength } : {}),
    });
    if (!updated) return sendJson(res, 404, { error: { message: '模型不在目录里', type: 'not_found' } });
    const snapshot = pool.modelSnapshot();
    return sendJson(res, 200, { modelId: body.modelId, setting: snapshot.get(body.modelId) });
  }

  if (route === 'POST /api/models/enable-all') {
    const body = await readBody(req) || {};
    if (!pool.catalog || pool.catalog.length === 0) {
      return sendJson(res, 409, { error: { message: '模型目录还没读取，先刷新目录', type: 'no_catalog' } });
    }
    pool.setAllModelsEnabled(body.enabled !== false);
    return sendJson(res, 200, { enabled: body.enabled !== false, count: pool.catalog.length });
  }

  if (route === 'POST /api/models/test') {
    const body = await readBody(req) || {};
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const model = (pool.catalog || []).find((item) => item.id === modelId);
    if (!model) return sendJson(res, 404, { error: { message: '模型不在目录里', type: 'not_found' } });
    const account = pool.pick();
    if (!account) return sendJson(res, 503, { error: { message: '没有可用账号', type: 'no_account' } });
    try {
      const measured = await measureModel({ pool, account, model });
      return sendJson(res, 200, measured);
    } catch (error) {
      return sendJson(res, 502, { error: { message: error.message, type: 'upstream' } });
    }
  }

  if (route === 'GET /api/keys') {
    return sendJson(res, 200, { keys: config.apiKeys.map((entry) => ({ ...entry, key: maskKey(entry.key) })) });
  }

  if (route === 'POST /api/keys') {
    const body = await readBody(req) || {};
    const entry = { id: randomUUID().slice(0, 12), key: newApiKey(), label: typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim().slice(0, 40) : '新密钥', createdAt: Date.now(), lastUsedAt: 0, requests: 0 };
    config.apiKeys.push(entry);
    saveConfig(config);
    // 新建时明文只回这一次，前端负责显示并提示“只显示一次”。
    return sendJson(res, 200, { key: entry.key, id: entry.id });
  }

  match = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    const before = config.apiKeys.length;
    config.apiKeys = config.apiKeys.filter((entry) => entry.id !== match[1]);
    saveConfig(config);
    return sendJson(res, config.apiKeys.length === before ? 404 : 200, { ok: config.apiKeys.length !== before });
  }

  if (route === 'POST /api/keys/reveal') {
    // 明文回显当前默认密钥（面板里点“眼睛”），限制本机 + 二次确认。
    const first = config.apiKeys[0];
    if (!first) return sendJson(res, 404, { error: { message: '还没有密钥', type: 'not_found' } });
    return sendJson(res, 200, { key: first.key });
  }

  if (route === 'POST /api/shutdown') {
    sendJson(res, 200, { ok: true });
    // 给响应留出写出的时间，再退出进程；由宿主（cli.js）注册 onShutdown 负责收尾。
    setTimeout(() => { try { globalThis.__wbgwShutdown?.(); } catch { /* ignore */ } }, 120);
    return;
  }

  if (route === 'GET /api/logs') {
    const limit = Number(url.searchParams.get('limit') || 50);
    return sendJson(res, 200, { logs: log.recent(limit) });
  }

  if (route === 'POST /api/logs/clear') {
    log.clear();
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: { message: `未知接口 ${route}`, type: 'not_found' } });
}

/**
 * 本机的局域网 IPv4 地址（用来告诉用户别的设备该填什么）。
 *
 * 只取「像局域网」的私网地址：10/8、172.16/12、192.168/16。
 * 刻意排除：
 *   - 127.x 回环；
 *   - 169.254.x 自动私有地址（没连上 DHCP 时出现，填进客户端连不通）；
 *   - Hyper-V / Docker / WSL 的虚拟网卡常常是 172.17~31 网段，
 *     它们从别的机器访问不到，列出来只会误导。
 * 排序时把 192.168 排在前面：家用/办公局域网最常见，猜中的概率最高。
 */
function lanAddresses() {
  const result = [];
  const interfaces = networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      const ip = item.address;
      if (!isPrivateIPv4(ip)) continue;
      if (isLikelyVirtual(name, ip)) continue;
      result.push(ip);
    }
  }
  return [...new Set(result)].sort((a, b) => {
    const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/** 私网网段判断（RFC1918）。 */
export function isPrivateIPv4(ip) {
  const parts = String(ip).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 判断是不是虚拟网卡。名字和网段两条线索都用：
 * Windows 上 Hyper-V 的 Default Switch 是 172.x，Docker/WSL 也常落在这里；
 * 这类地址从同一局域网的其它机器根本访问不到。
 */
function isLikelyVirtual(name, ip) {
  if (/vethernet|hyper-v|docker|wsl|vmware|virtualbox|loopback|npcap/iu.test(name)) return true;
  const parts = ip.split('.').map(Number);
  // 172.17.0.0/16 是 Docker 默认网桥，172.18~31 常被各类虚拟交换机占用
  if (parts[0] === 172 && parts[1] >= 17 && parts[1] <= 31) return true;
  return false;
}

/**
 * 真的跑一次模型，量首字延迟、总耗时、思考 token。
 *
 * 这不是"发个 ping 看通不通"：那对推理模型毫无意义（都通，但思考强度可能没生效）。
 * 这里发一条会引出推理的短问题，并读回 usage 里的 reasoning_tokens，
 * 让面板上的「思考强度」有可验证的证据。
 */
async function measureModel({ pool, account, model }) {
  await pool.ensureFreshToken(account);
  const setting = pool.modelSnapshot().get(model.id);
  const shaped = shapeChatBody({
    model: model.id,
    stream: true,
    max_tokens: 120,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '3 个人 3 天做 3 个零件，9 个人 9 天做几个？只给数字。' },
    ],
  });
  const withSettings = applyModelSettings(shaped, model, setting);
  const startedAt = Date.now();
  const response = await pool.upstream.chat(account, withSettings.body);
  if (!response.ok) {
    throw new Error(response.classification?.reason || `HTTP ${response.status}`);
  }
  let firstTokenMs = null;
  let reasoningTokens = 0;
  let completionTokens = 0;
  let content = '';
  try {
    for await (const event of readChunks(response.response.body)) {
      if (event.done) break;
      const chunk = event.data;
      const delta = chunk?.choices?.[0]?.delta;
      if (firstTokenMs === null && (delta?.content || delta?.reasoning_content)) {
        firstTokenMs = Date.now() - startedAt;
      }
      if (typeof delta?.content === 'string') content += delta.content;
      const usage = chunk?.usage;
      if (usage) {
        reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.completion_thinking_tokens ?? reasoningTokens;
        completionTokens = usage.completion_tokens ?? completionTokens;
      }
    }
  } finally {
    pool.release(account);
  }
  pool.markSuccess(account, undefined);
  return {
    modelId: model.id,
    firstTokenMs: firstTokenMs ?? (Date.now() - startedAt),
    totalMs: Date.now() - startedAt,
    reasoningTokens,
    completionTokens,
    applied: withSettings.applied,
    answer: content.trim().slice(0, 40),
  };
}

function publicConfig(config) {
  return {
    port: config.port,
    listen: config.listen,
    gatewayEnabled: config.gatewayEnabled,
    autoRotate: config.autoRotate,
    tokenRefresh: config.tokenRefresh,
    maxConcurrentPerAccount: config.maxConcurrentPerAccount,
    proxyUrl: config.proxyUrl,
    allowPanelFromLan: config.allowPanelFromLan,
    requestLog: { enabled: config.requestLog.enabled },
    keyCount: config.apiKeys.length,
  };
}

function normalizeInPlace(config) {
  // 只做轻量校验，详细的默认值合并交给 config.js 的 normalizeConfig。
  const out = {};
  if (config.listen !== 'lan' && config.listen !== 'local') out.listen = 'local';
  return out;
}
