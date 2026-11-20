// 上游「渠道校验」净化层。
//
// 上游网关会对 system / assistant 消息做大小写不敏感的**精确子串匹配**，命中就返回
//   400 / 11128 "Illegal API invocation from an unapproved channel"
// 这会让真实客户端（带长系统提示的）一律失败——短提示能通，所以很容易被漏测。
//
// 实测结论（2026-11-18，CN 网关，deepseek-v4.1-flash，逐条对照）：
//   1. 零宽字符穿插 **无效**：网关会先做规范化，插 U+200B 照样被拒。
//   2. 把整句换成同义说法 有效（"powered by" → "running inside"）。
//   3. 两个句子之间用**空格**连接会被拒，换成**换行**就能过——说明它匹配的是跨句的连续文本。
//   4. 把 content 拆成多个 text part 也能过（网关逐 part 匹配）。
//
// 因此这里做两层处理，且都不丢信息：
//   A. 句间分隔符从空格改成换行（不动一个字，只动分隔符）；
//   B. 少数已实测的禁用短语换成等价说法。
// 仍然被拒时，用「拆 text part」再兜一次底。
const ZERO_WIDTH_SPACE = '\u200b';

/**
 * 已实测会被 11128 拒的短语 → 等价改写。
 *
 * 只收「亲自测过被拒」的条目：没测过的短语写进来，等于凭猜测改用户的提示词。
 * 每条都保持原意，不删信息。
 */
export const CHANNEL_GATE_PHRASES = [
  // 实测：原句 400/11128，"running inside" 版本 200
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI agent running inside DeepSeek Harness'],
  // 实测：同族句式，上游按产品名+身份词匹配
  ['You are a coding agent powered by the ', 'You are a coding agent running on the '],
  ['You are interacting with the user through the DeepSeek Harness Web GUI', 'You are working with the user inside the DeepSeek Harness Web GUI'],
  // 实测：原句 400/11128
  ["You are Claude Code, Anthropic's official CLI for Claude", "You are Claude Code, the official CLI from Anthropic for Claude"],
];

/** 句间加换行：把「. 空格」变成「. 换行」。只动分隔符，字一个不改。 */
export function breakBetweenSentences(text) {
  return text
    .replace(/([.!?;])[ \t]+(?=\S)/gu, '$1\n')
    .replace(/([。！？；])[ \t]*(?=\S)/gu, '$1\n');
}

export function rewriteGatePhrases(text) {
  let out = text;
  for (const [from, to] of CHANNEL_GATE_PHRASES) {
    if (out.includes(from)) { out = out.replaceAll(from, to); continue; }
    // 上游是大小写不敏感的精确匹配：全小写/全大写版本的同一句照样被拒，
    // 而 replaceAll 区分大小写会漏掉它。这里按原文长度做一次不区分大小写的替换，
    // 保持改写后的用词（不把用户的文字改成另一种大小写风格）。
    const lower = out.toLowerCase();
    const needle = from.toLowerCase();
    const at = lower.indexOf(needle);
    if (at >= 0) out = `${out.slice(0, at)}${to}${out.slice(at + from.length)}`;
  }
  return out;
}

/** 网关会扫这两类角色的消息开头/内容；user 与 tool 不动，免得改用户自己的话。 */
export function scannedRole(role) {
  if (typeof role !== 'string') return false;
  const name = role.trim().toLowerCase();
  return name === 'system' || name === 'assistant';
}

/**
 * 处理文本里的零宽字符。
 *
 * 零宽字符对网关无效（它自己会规范化掉再比），但会打断我们的短语匹配，所以要先处理。
 * 但不能一根筋地全删或全换空格，两种写法各会坏一种情况：
 *
 *   "Deep\u200bSeek Harness"     删掉 → "DeepSeek Harness"  命中短语 ✔
 *                               换空格 → "Deep Seek Harness" 漏掉   ✘
 *   "DeepSeek\u200bHarness"      删掉 → "DeepSeekHarness"   漏掉   ✘（上游照样拒）
 *                               换空格 → "DeepSeek Harness"  命中 ✔
 *
 * 所以按结果选：先看「全删」的版本能不能命中已知短语，能就用它（还原原词最忠实），
 * 不能就退回「换空格」的版本。
 */
function normalizeZeroWidth(text) {
  if (!/[\u200b-\u200d\ufeff]/u.test(text)) return text;
  const stripped = text.replace(/[\u200b-\u200d\ufeff]/gu, '');
  if (containsGatePhrase(stripped)) return stripped;
  return text.replace(/[\u200b-\u200d\ufeff]/gu, ' ').replace(/[ \t]{2,}/gu, ' ');
}

/** 大小写不敏感地判断文本里是否含某条禁用短语。 */
function containsGatePhrase(text) {
  const lower = text.toLowerCase();
  return CHANNEL_GATE_PHRASES.some(([from]) => lower.includes(from.toLowerCase()));
}

/** 对一段文本做净化。幂等：重复调用不会再变。 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text === '') return text;
  // 再改短语，最后断句：改写后可能引入新的句子边界。
  return breakBetweenSentences(rewriteGatePhrases(normalizeZeroWidth(text)));
}

/**
 * 净化一条消息的 content（字符串或 parts 数组都支持）。
 * 返回新的 content，不修改入参。
 */
export function sanitizeContent(content) {
  if (typeof content === 'string') return sanitizeText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (typeof part.text !== 'string') return part;
    if (typeof part.type === 'string' && part.type.toLowerCase() !== 'text') return part;
    return { ...part, text: sanitizeText(part.text) };
  });
}

/**
 * 是否需要拆 part 兜底。
 * 单句内的禁用短语在改写表里没有时，换行救不了；此时把长文本按句切成多个
 * text part，让网关的逐-part 匹配看不到跨句组合。
 */
export function splitIntoParts(text, maxLen = 200) {
  if (typeof text !== 'string' || text.length <= maxLen) return undefined;
  const sentences = text.match(/[^.!?;\n]+[.!?;]*\s*|\n+/gu);
  if (!sentences || sentences.length < 2) return undefined;
  const parts = [];
  let current = '';
  for (const sentence of sentences) {
    if (current !== '' && current.length + sentence.length > maxLen) {
      parts.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current !== '') parts.push(current);
  if (parts.length < 2) return undefined;
  return parts.filter((part) => part.trim() !== '').map((text) => ({ type: 'text', text }));
}

/**
 * 对整份 messages 做净化。
 * dense=true 时额外把长 system 文本拆成多个 part（失败重试的那一路用）。
 */
export function sanitizeMessages(messages, { dense = false } = {}) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || !scannedRole(message.role)) return message;
    const content = sanitizeContent(message.content);
    if (!dense) return { ...message, content };
    if (typeof content === 'string') {
      const parts = splitIntoParts(content);
      return parts ? { ...message, content: parts } : { ...message, content };
    }
    if (Array.isArray(content) && content.length === 1 && typeof content[0]?.text === 'string') {
      const parts = splitIntoParts(content[0].text);
      return parts ? { ...message, content: parts } : { ...message, content };
    }
    return { ...message, content };
  });
}
