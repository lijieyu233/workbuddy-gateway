// 端到端自测：用隔离的 HOME 拉起真实服务，账号来自本机 WorkBuddy 登录态（可跳过），
// 断言 /v1/models、/v1/chat/completions（流式与非流式）、鉴权与错误路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'wbgw-test-'));
process.env.WORKBUDDY_GATEWAY_HOME = workdir;

const { normalizeConfig, ensureApiKey } = await import('../src/config.js');
const { Pool } = await import('../src/pool.js');
const { createGateway } = await import('../src/server.js');
const { shapeChatBody, normalizeToolChoice, classifyUpstream, uuidv7, regionOf, chatBase } = await import('../src/upstream.js');
const { parseAuthDocument, accountIdOf, mergeScanned } = await import('../src/accounts.js');
const { sanitizeText, sanitizeMessages, splitIntoParts, breakBetweenSentences } = await import('../src/sanitize.js');
const bridgeModule = await import('../src/bridge.js');
const upstreamModule = await import('../src/upstream.js');

test('净化：句间空格改成换行（不动文字）', () => {
  const input = 'First sentence here. Second sentence there.';
  const out = sanitizeText(input);
  assert.equal(out, 'First sentence here.\nSecond sentence there.');
  // 字一个不少，只是分隔符变了
  assert.equal(out.replace(/\n/g, ' '), input);
});

test('净化：零宽字符不是我们的方案（网关会规范化掉）', () => {
  // 保留一条断言，防止后来的人「灵机一动」改成插零宽字符
  const out = sanitizeText('You are an AI agent powered by DeepSeek Harness.');
  assert.equal(out.includes('\u200b'), false);
});

test('净化：大小写变体同样要被改写（上游不区分大小写）', () => {
  for (const input of [
    'you are an ai agent powered by deepseek harness.',
    'YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS.',
    'You Are An AI Agent Powered By DeepSeek Harness.',
  ]) {
    const out = sanitizeText(input);
    assert.ok(out.includes('running inside'), `${input} → ${out}`);
  }
});

test('净化：夹了零宽字符的变体也要命中（先把零宽去掉）', () => {
  const inputs = [
    'You are an AI agent powered by DeepSeek\u200b Harness.',
    'You are an AI agent powered by Deep\u200bSeek Harness.',
    'You are an AI agent powered by DeepSeek\u200bHarness.',
  ];
  for (const input of inputs) {
    const out = sanitizeText(input);
    assert.equal(out.includes('\u200b'), false, '零宽应被移除');
    assert.ok(out.includes('running inside'), `${input} → ${out}`);
  }
});

test('净化：实测被拒的身份短语改写成等价说法', () => {
  const cases = [
    ['You are an AI agent powered by DeepSeek Harness.', 'running inside'],
    ["You are Claude Code, Anthropic's official CLI for Claude.", 'the official CLI from Anthropic'],
  ];
  for (const [input, expected] of cases) {
    const out = sanitizeText(input);
    assert.ok(out.includes(expected), `${input} → ${out}`);
    assert.equal(out.includes('\n'), false, '单句不该被断行');
  }
});

test('净化：幂等', () => {
  const input = 'You are an AI agent powered by DeepSeek Harness. Tokens prefixed with @ are paths.';
  const once = sanitizeText(input);
  assert.equal(sanitizeText(once), once);
});

test('净化：只动 system 与 assistant，不改 user 和 tool', () => {
  const messages = [
    { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
    { role: 'user', content: 'You are an AI agent powered by DeepSeek Harness.' },
    { role: 'tool', content: 'You are an AI agent powered by DeepSeek Harness.' },
    { role: 'assistant', content: 'First one. Second one.' },
  ];
  const out = sanitizeMessages(messages);
  assert.ok(out[0].content.includes('running inside'));
  assert.equal(out[1].content, messages[1].content, 'user 消息不能被改');
  assert.equal(out[2].content, messages[2].content, 'tool 消息不能被改');
  assert.ok(out[3].content.includes('\n'));
});

test('净化：数组 parts 的每个 text 都处理', () => {
  const messages = [{
    role: 'system',
    content: [
      { type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { type: 'text', text: 'First. Second.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ],
  }];
  const out = sanitizeMessages(messages);
  assert.ok(out[0].content[0].text.includes('running inside'));
  assert.ok(out[0].content[1].text.includes('\n'));
  assert.equal(out[0].content[2].type, 'image_url', '非文本 part 原样保留');
});

test('dense 模式：长 system 文本被拆成多个 part', () => {
  const long = 'This is sentence one about nothing. '.repeat(20);
  const out = sanitizeMessages([{ role: 'system', content: long }], { dense: true });
  assert.ok(Array.isArray(out[0].content), 'dense 模式下应变成 parts 数组');
  assert.ok(out[0].content.length > 1, '应该拆成多个 part');
  const rejoined = out[0].content.map((p) => p.text).join('');
  assert.equal(rejoined.replace(/\n/g, ' ').trim(), sanitizeText(long).replace(/\n/g, ' ').trim());
});

test('splitIntoParts：短文本不拆', () => {
  assert.equal(splitIntoParts('short text'), undefined);
  assert.equal(splitIntoParts('A. B.'), undefined);
});

test('uuidv7 形状：32 位小写十六进制、版本位为 7', () => {
  const id = uuidv7(1794961892000);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id[12], '7');
  assert.match('89ab', new RegExp(id[16]));
});

test('区域识别与端点', () => {
  assert.equal(regionOf('workbuddy.ai'), 'global');
  assert.equal(regionOf('copilot.tencent.com'), 'cn');
  assert.equal(chatBase({ domain: '' }), 'https://copilot.tencent.com');
  assert.equal(chatBase({ domain: 'www.workbuddy.ai' }), 'https://www.workbuddy.ai');
});

test('请求体整形：强制流式、developer 降级、补 system 头', () => {
  const shaped = shapeChatBody({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }],
    stream_options: { include_usage: true },
  });
  assert.equal(shaped.stream, true);
  assert.equal(shaped.messages[0].role, 'system');
  assert.equal(shaped.messages[0].content, 'be brief');
  assert.equal(shaped.stream_options, undefined);
});

test('请求体整形：只有 prompt 时补成 messages', () => {
  const shaped = shapeChatBody({ model: 'm', prompt: 'hello' });
  assert.deepEqual(shaped.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(shaped.messages[1].content, 'hello');
});

test('tool_choice 压平规则', () => {
  const obj = { tool_choice: { type: 'function', function: { name: 'get_weather' } }, tools: [{ type: 'function' }] };
  normalizeToolChoice(obj);
  assert.equal(obj.tool_choice, 'get_weather');

  const none = { tool_choice: 'none', tools: [{ type: 'function' }] };
  normalizeToolChoice(none);
  assert.equal(none.tool_choice, undefined);
  assert.equal(none.tools, undefined);

  const required = { tool_choice: { type: 'required' } };
  normalizeToolChoice(required);
  assert.equal(required.tool_choice, 'required');
});

test('上游错误分类', () => {
  assert.equal(classifyUpstream(401, { msg: 'bad token' }).kind, 'auth');
  assert.equal(classifyUpstream(429, {}).kind, 'quota');
  assert.equal(classifyUpstream(429, {}).retryable, true);
  assert.equal(classifyUpstream(400, { code: 11128, msg: 'conversation id missing' }).kind, 'client');
  assert.equal(classifyUpstream(400, { code: 11140 }).kind, 'banned');
  assert.equal(classifyUpstream(500, {}).retryable, true);
});

test('auth 文档解析：插件形与扁平形都认', () => {
  const nested = parseAuthDocument(JSON.stringify({
    auth: { accessToken: 'tok', refreshToken: 'r', domain: 'copilot.tencent.com', expiresAt: 4102444800000 },
    account: { uid: 'u-1', uin: '100', nickname: '名字', type: 'personal' },
  }), '/tmp/x.info', Date.now());
  assert.equal(nested.accessToken, 'tok');
  assert.equal(nested.uid, 'u-1');
  assert.equal(nested.accountType, 'personal');
  assert.equal(nested.expiresAtMs, 4102444800000);

  const flat = parseAuthDocument(JSON.stringify({ accessToken: 'tok2' }), '', Date.now());
  assert.equal(flat.accessToken, 'tok2');
  assert.equal(flat.uid, '');

  assert.equal(parseAuthDocument('{}'), undefined);
  assert.equal(parseAuthDocument('not json'), undefined);
  assert.equal(parseAuthDocument(JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1 } } })), undefined);
});

test('账号 id 稳定且不同账号不撞', () => {
  assert.equal(accountIdOf({ uid: 'a' }), accountIdOf({ uid: 'a', accessToken: 'x' }));
  assert.notEqual(accountIdOf({ uid: 'a' }), accountIdOf({ uid: 'b' }));
});

test('合并扫描结果：只更新令牌，不动统计与标签', () => {
  const store = {
    version: 1,
    accounts: [{
      id: accountIdOf({ uid: 'a' }), uid: 'a', accessToken: 'old', label: '我的号',
      stats: { requests: 7, failures: 1, credits: 2.5 }, disabled: false, createdAt: 1, updatedAt: 1,
    }],
  };
  const scanned = [{ uid: 'a', accessToken: 'new', expiresAtMs: 999, domain: 'copilot.tencent.com' }];
  const { store: merged, updated } = mergeScanned(store, scanned, 12345);
  const account = merged.accounts[0];
  assert.equal(updated, 1);
  assert.equal(account.accessToken, 'new');
  assert.equal(account.label, '我的号');
  assert.deepEqual(account.stats, { requests: 7, failures: 1, credits: 2.5 });
  assert.equal(account.updatedAt, 12345);
});

test('模型名归一：显示名、大小写都能映射回 id', () => {
  const config = normalizeConfig({ port: 0 });
  const pool = new Pool(config);
  pool.catalog = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro' },
  ];
  // 上游只认 id；客户端常把显示名当 id 传
  assert.equal(pool.resolveModel('DeepSeek-V4.1-Flash').id, 'deepseek-v4.1-flash');
  assert.equal(pool.resolveModel('deepseek-v4.1-flash').id, 'deepseek-v4.1-flash');
  assert.equal(pool.resolveModel('DEEPSEEK-V4.1-FLASH').id, 'deepseek-v4.1-flash');
  assert.equal(pool.resolveModel('GLM-5.3').id, 'glm-5.3');
  assert.equal(pool.resolveModel('kimi-k3.1-pro').id, 'kimi-k3.1-pro');
  // 不认识的模型原样返回，交给上游判断，不在这里编造
  assert.equal(pool.resolveModel('no-such-model').id, 'no-such-model');
  assert.equal(pool.resolveModel('').id, '');
  assert.equal(pool.resolveModel(undefined).id, undefined);
  // 目录没读到时不能瞎映射
  const empty = new Pool(normalizeConfig({ port: 0 }));
  assert.equal(empty.resolveModel('DeepSeek-V4.1-Flash').id, 'DeepSeek-V4.1-Flash');
});

test('模型名归一：显示名重名时明确报歧义，不能静默挑第一个', () => {
  // 实测目录里 4 组重名，例如 5 个模型都叫 "Hy4 preview"。
  // 用 find() 取第一个会把用户要的模型悄悄换成另一个。
  const pool = new Pool(normalizeConfig({ port: 0 }));
  pool.catalog = [
    { id: 'hy4-preview-ctrl', name: 'Hy4 preview' },
    { id: 'hy4-preview-exp', name: 'Hy4 preview' },
    { id: 'hy4preview-exp1', name: 'Hy4 preview' },
    { id: 'hy4-preview-x', name: 'Hy4 preview' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  ];
  const ambiguous = pool.resolveModel('Hy4 preview');
  assert.equal(ambiguous.ambiguous, true, '重名必须报歧义');
  assert.equal(ambiguous.id, undefined, '歧义时不能给出某个 id');
  assert.deepEqual(ambiguous.candidates, ['hy4-preview-ctrl', 'hy4-preview-exp', 'hy4preview-exp1', 'hy4-preview-x']);

  // 唯一的名字仍然正常映射
  assert.equal(pool.resolveModel('DeepSeek-V4.1-Flash').id, 'deepseek-v4.1-flash');
  // 直接给 id 永远可用（即使显示名重名）
  assert.equal(pool.resolveModel('hy4-preview-x').id, 'hy4-preview-x');
  assert.equal(pool.resolveModel('HY4-PREVIEW-EXP').id, 'hy4-preview-exp');
});

test('响应头必须 ASCII：中文账号名要编码', () => {
  // 踩过的坑：账号昵称是中文（「测试号」）时直接塞进 x-workbuddy-account，
  // Node 会抛 ERR_INVALID_CHAR，整个流式响应变成 500。
  // 这意味着"账号昵称含中文的用户，所有请求都失败"，而表面上只是莫名的 500。
  const { headerSafe } = bridgeModule;
  for (const name of ['测试号', '永恒海星派大星', '448****3', 'a"b', 'a\nb', 'Ünïcode']) {
    const safe = headerSafe(name);
    assert.match(safe, /^[\x20-\x7e]*$/u, `${name} 编码后必须是纯 ASCII，实际：${safe}`);
  }
  // 正常的 ASCII 名字不应该被改动太多（可读性）
  assert.equal(headerSafe('448****3').replace(/%2A/gu, '*'), '448****3');
  // 中文要能还原
  assert.equal(decodeURIComponent(headerSafe('测试号')), '测试号');
});

test('本地校验：空 messages 直接挡掉，不发上游', () => {
  // 实测（2026-11-18）：messages 为空数组时上游回 400/11133，
  // 而用户看到的却是"模型无法处理此请求"，完全摸不着头脑。
  // 这种请求发多少次都不会成功，还会白烧一次额度。
  const { validateChatBody } = upstreamModule;
  assert.match(validateChatBody({ model: 'm', messages: [] }), /空的/);
  assert.match(validateChatBody({ model: 'm', messages: { a: 1 } }), /必须是数组/);
  assert.match(validateChatBody(null), /不是对象/);
  // 这些上游实测都能过，不能拦
  assert.equal(validateChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), undefined);
  assert.equal(validateChatBody({ model: 'm', messages: [{ role: 'system', content: 's' }] }), undefined);
  assert.equal(validateChatBody({ model: 'm', messages: [{ role: 'robot', content: 'x' }] }), undefined);
});

test('ensureSystemHead 不给空数组补 system（交给校验挡）', () => {
  const { ensureSystemHead } = upstreamModule;
  const empty = [];
  ensureSystemHead(empty);
  assert.equal(empty.length, 0, '空数组不该被补成一条 system，那只会变成无意义的请求');
  const normal = [{ role: 'user', content: 'hi' }];
  ensureSystemHead(normal);
  assert.equal(normal[0].role, 'system');
});

test('图片格式：裸 base64 自动补成 data URL（上游否则 11133）', () => {
  const { fixImageParts, sniffBase64Mime, shapeChatBody } = upstreamModule;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  assert.equal(sniffBase64Mime(PNG), 'image/png');
  assert.equal(sniffBase64Mime('/9j/4AAQSkZJRg'), 'image/jpeg');
  assert.equal(sniffBase64Mime('R0lGODlh'), 'image/gif');
  assert.equal(sniffBase64Mime('UklGRhIAAABXRUJQ'), 'image/webp');
  assert.equal(sniffBase64Mime('这不是base64'), undefined, '认不出的不能瞎猜');

  const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }];
  const fixed = fixImageParts(messages);
  assert.equal(fixed.fixed, 1);
  assert.ok(fixed.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'));

  // 已经带前缀/是 http URL 的不动
  assert.equal(fixImageParts([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }]).fixed, 0);
  assert.equal(fixImageParts([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }]).fixed, 0);

  // Anthropic 风格 source 也要转
  const anthropic = fixImageParts([{
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }],
  }]);
  assert.equal(anthropic.fixed, 1);
  assert.deepEqual(anthropic.messages[0].content[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } });

  // 经由 shapeChatBody 也要生效（这是真实路径）
  // 注意 shapeChatBody 会在首条不是 system 时插入一条 system，所以按 role 找 user
  const shaped = shapeChatBody({ model: 'm', messages });
  const userMessage = shaped.messages.find((item) => item.role === 'user');
  assert.ok(userMessage.content[0].image_url.url.startsWith('data:image/png;base64,'), '经 shapeChatBody 后仍应带前缀');
});

test('图片格式：文本消息不受影响', () => {
  const { fixImageParts } = upstreamModule;
  const messages = [{ role: 'user', content: '纯文本' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  const result = fixImageParts(messages);
  assert.equal(result.fixed, 0);
  assert.deepEqual(result.messages, messages);
});

test('参数瘦身：裁掉上游不认的字段，保留白名单', () => {
  const { slimBody } = bridgeModule;
  const result = slimBody({
    model: 'm', messages: [], stream: true, max_tokens: 10,
    // 各家 SDK 在 OpenAI 协议上加的私货
    metadata: { user: 'x' }, store: false, service_tier: 'auto',
    parallel_tool_calls: true, prompt_cache_key: 'k', safety_identifier: 's',
  });
  assert.deepEqual(result.removed.sort(), ['metadata', 'parallel_tool_calls', 'prompt_cache_key', 'safety_identifier', 'service_tier', 'store'].sort());
  assert.deepEqual(Object.keys(result.body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
});

test('参数瘦身：没有可裁字段时返回空，避免无意义重试', () => {
  const { slimBody } = bridgeModule;
  const clean = { model: 'm', messages: [], stream: true };
  assert.deepEqual(slimBody(clean).removed, []);
  assert.deepEqual(slimBody(clean).body, clean);
});

test('错误描述带上 code 与上游中文提示，而不是只丢一句英文', () => {
  const { describeUpstreamFailure } = bridgeModule;
  const text = describeUpstreamFailure({
    status: 400,
    text: '{"code":11133,"msg":"the request parameters were rejected by the model provider","displayMsg":{"zh":"请求参数被拒绝"}}',
    payload: {
      code: 11133,
      msg: 'the request parameters were rejected by the model provider',
      displayMsg: { zh: '请求参数被拒绝' },
    },
  });
  assert.ok(text.includes('code 11133'), `应带 code，实际：${text}`);
  assert.ok(text.includes('the request parameters were rejected'), '应保留原始信息');
  assert.ok(text.includes('请求参数被拒绝'), '应附上上游中文提示');
});

test('网络面：鉴权、模型列表、网关开关', async (t) => {
  const config = normalizeConfig({ port: 0, gatewayEnabled: true, apiKeys: [] });
  ensureApiKey(config);
  mkdirSync(join(workdir), { recursive: true });
  writeFileSync(join(workdir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [] }));
  const pool = new Pool(config);
  pool.catalog = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.00' }];
  const { server } = createGateway({ config, pool });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const unauthorized = await fetch(`${base}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const key = config.apiKeys[0].key;
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(models.status, 200);
  const payload = await models.json();
  assert.equal(payload.data[0].id, 'deepseek-v4.1-flash');

  // 账号池为空时必须给 503 且说明原因，而不是挂住
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 503);
  const error = await chat.json();
  assert.match(error.error.message, /账号池为空/);

  // 网关开关关掉后立即 503
  config.gatewayEnabled = false;
  const disabled = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(disabled.status, 503);
  config.gatewayEnabled = true;

  // 面板状态可读，且不包含令牌明文
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state.pool.total, 0);
  assert.equal(JSON.stringify(state).includes(key), false);

  // Responses 风格转换
  const translated = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'hi' }),
  });
  assert.equal(translated.status, 503);

  rmSync(workdir, { recursive: true, force: true });
});
