// 逐模型设置：推理强度、上下文档位、是否启用、是否允许思考。
//
// 设计原则：这里存的每一条都会真的改变发给上游的请求体，没有纯装饰的开关。
//   - enabled          → 该模型是否出现在 /v1/models 里
//   - reasoningEffort  → 请求体里的 reasoning_effort（实测上游尊重，low/high/max 的思考 token 不同）
//   - disableThinking  → 请求体里 thinking:{type:'disabled'}（实测思考 token 归零）
//   - contextLength    → 面板上的上下文档位（200K/500K/1M），只用于显示与预算参考
//
// 上游会给每个模型的 supportedEfforts，面板据此渲染成单选项；用户没设置时用上游的 defaultEffort。
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

export const DEFAULT_MODEL_SETTINGS = {
  enabled: false,
  reasoningEffort: null,
  disableThinking: false,
  contextLength: null,
};

function filePath() {
  return join(paths.home, 'model-settings.json');
}

export function loadModelSettings() {
  const file = filePath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
  } catch {
    return {};
  }
}

export function saveModelSettings(models) {
  const file = filePath();
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return models;
}

/**
 * 把一条设置归一化。只接受该模型上游真的声明支持的值，其余一律丢弃——
 * 一个不在 supportedEfforts 里的档位发给上游会直接 400/11133。
 */
export function normalizeModelSetting(setting, catalogModel) {
  const raw = setting && typeof setting === 'object' ? setting : {};
  const supported = catalogModel?.reasoning?.supportedEfforts ?? [];
  const lengths = catalogModel?.contextLengths ?? [];
  const effort = typeof raw.reasoningEffort === 'string' && supported.includes(raw.reasoningEffort)
    ? raw.reasoningEffort
    : null;
  const contextLength = Number.isFinite(raw.contextLength) && lengths.includes(Math.trunc(raw.contextLength))
    ? Math.trunc(raw.contextLength)
    : null;
  return {
    enabled: raw.enabled === true,
    reasoningEffort: effort,
    // 只有在模型允许关闭思考时才接受这个开关，否则等于伪造一个上游不接受的状态
    disableThinking: raw.disableThinking === true && catalogModel?.reasoning?.canDisableThinking === true,
    contextLength,
  };
}

/**
 * 按当前模型目录，算出每个模型最终生效的设置。
 *
 * 关于 effectiveEffort：**不能**用上游目录里的 `defaultEffort` 冒充实际档位。
 * 实测（2026-11-18，deepseek-v4.1-flash）：
 *   不传 reasoning_effort            → 思考 0 token
 *   reasoning_effort: high          → 思考 119 token
 *   reasoning_effort: low           → 思考 85 token
 * 也就是说目录写着 defaultEffort=high，但**不传就是不思考**。
 * 面板若把 defaultEffort 显示成"当前生效"，用户会以为在用 high，实际一个字都没思考。
 * 所以这里 effectiveEffort 只在用户真的设过时才有值，否则是 null，由面板显示「不思考」。
 */
export function effectiveSettings(catalog, stored) {
  const byId = new Map();
  for (const model of catalog || []) {
    const raw = stored?.[model.id];
    const setting = raw === undefined
      ? { ...DEFAULT_MODEL_SETTINGS, configured: false }
      : { ...normalizeModelSetting(raw, model), configured: true };
    byId.set(model.id, {
      ...setting,
      // 只有真的设了档位才算"会思考"；disableThinking 优先压掉它
      effectiveEffort: setting.disableThinking ? null : (setting.reasoningEffort ?? null),
      // 上游声称的默认档位单独暴露，供面板在"不思考"旁边提示"上游建议 high"
      upstreamDefaultEffort: model.reasoning?.defaultEffort ?? null,
    });
  }
  return byId;
}

/**
 * 把设置应用到一份已经整形好的请求体上。
 *
 * 返回 { body, applied }：applied 说明这次真正改了什么，供日志与面板核对，
 * 避免"界面上打开了但实际没生效"这种假象。
 */
export function applyModelSettings(body, model, setting) {
  if (!body || typeof body !== 'object') return { body, applied: [] };
  const applied = [];
  const next = { ...body };

  if (setting?.disableThinking === true && model?.reasoning?.canDisableThinking === true) {
    next.thinking = { type: 'disabled' };
    // 关思考时不能同时给 effort，否则语义冲突
    delete next.reasoning_effort;
    applied.push('disableThinking');
  } else if (typeof setting?.reasoningEffort === 'string' && model?.reasoning?.supportedEfforts?.includes(setting.reasoningEffort)) {
    next.reasoning_effort = setting.reasoningEffort;
    applied.push(`reasoning_effort=${setting.reasoningEffort}`);
  }

  return { body: next, applied };
}
