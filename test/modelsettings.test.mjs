// 逐模型设置：解析、归一、真正进请求体。
//
// 这些测试钉住一条底线：面板上的开关必须真的改变发给上游的请求体。
// 一个"点了没反应"的开关比没有更糟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WORKBUDDY_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'wbgw-ms-'));

const { normalizeCatalogModel } = await import('../src/upstream.js');
const {
  normalizeModelSetting, effectiveSettings, applyModelSettings, DEFAULT_MODEL_SETTINGS,
} = await import('../src/modelsettings.js');

const FLASH = normalizeCatalogModel({
  id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: 'x0.11',
  supportsImages: true, supportsToolCall: true, supportsReasoning: true, onlyReasoning: true,
  maxInputTokens: 1000000, maxOutputTokens: 128000,
  reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true, summary: 'auto' },
  contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] },
});

const NO_DISABLE = normalizeCatalogModel({
  id: 'no-disable-model', name: 'NoDisable', maxInputTokens: 128000, maxOutputTokens: 32000,
  reasoning: { effort: 'high', summary: 'auto' },
});

test('目录解析：单数 effort 形态也要认（上游两种写法都有）', () => {
  // 实测 60 个模型里：19 个用 supportedEfforts 数组，13 个用单数 effort。
  // 只认数组会把单档模型误判成"不支持推理"，面板上显示「思考 不支持」——实际它有档位。
  assert.deepEqual(NO_DISABLE.reasoning.supportedEfforts, ['high'], '单数 effort 要转成一档数组');
  assert.equal(NO_DISABLE.reasoning.singleEffort, true);
  assert.equal(NO_DISABLE.reasoning.defaultEffort, 'high');
  // 数组形态不该被标成单档
  assert.equal(FLASH.reasoning.singleEffort, false);
});

test('目录解析：推理档位与上下文档位都读出来', () => {
  assert.deepEqual(FLASH.reasoning.supportedEfforts, ['low', 'high', 'max']);
  assert.equal(FLASH.reasoning.defaultEffort, 'high');
  assert.equal(FLASH.reasoning.canDisableThinking, true);
  assert.deepEqual(FLASH.contextLengths, [300000, 600000, 1000000]);
  assert.equal(FLASH.contextLengths[0], 300000);
  assert.deepEqual(FLASH.contextLengths, [300000, 600000, 1000000]);
  // 没声明任何档位字段的模型（只有 summary）才真的没有档位
  const bare = normalizeCatalogModel({ id: 'bare', reasoning: { summary: 'auto' } });
  assert.deepEqual(bare.reasoning.supportedEfforts, []);
  assert.equal(bare.reasoning.canDisableThinking, false);
  // 没有 contextWindow 时退回 maxInputTokens
  assert.deepEqual(NO_DISABLE.contextLengths, [128000]);
});

test('设置归一：只接受上游声明过的值', () => {
  // 上游支持 low/high/max，medium 不在其中 → 丢弃
  assert.equal(normalizeModelSetting({ reasoningEffort: 'medium' }, FLASH).reasoningEffort, null);
  assert.equal(normalizeModelSetting({ reasoningEffort: 'low' }, FLASH).reasoningEffort, 'low');
  // 模型不允许关思考时，这个开关必须被拒
  assert.equal(normalizeModelSetting({ disableThinking: true }, NO_DISABLE).disableThinking, false);
  assert.equal(normalizeModelSetting({ disableThinking: true }, FLASH).disableThinking, true);
  // 不在档位里的上下文长度丢弃
  assert.equal(normalizeModelSetting({ contextLength: 999 }, FLASH).contextLength, null);
  assert.equal(normalizeModelSetting({ contextLength: 600000 }, FLASH).contextLength, 600000);
});

test('生效值：没设置时 effectiveEffort 必须是 null（不思考），而不是上游声称的默认档', () => {
  // 实测：不传 reasoning_effort 时上游思考 0 token；
  // 目录里的 defaultEffort=high 只是建议值，不等于不传就按 high 跑。
  // 面板若把 high 显示成"当前生效"，会让用户误以为在思考。
  const snapshot = effectiveSettings([FLASH], {});
  const setting = snapshot.get('deepseek-v4.1-flash');
  assert.equal(setting.configured, false);
  assert.equal(setting.reasoningEffort, null);
  assert.equal(setting.effectiveEffort, null, '没设置 = 不思考');
  assert.equal(setting.upstreamDefaultEffort, 'high', '上游建议值单独暴露');
});

test('生效值：用户设置优先于上游默认', () => {
  const snapshot = effectiveSettings([FLASH], { 'deepseek-v4.1-flash': { enabled: true, reasoningEffort: 'max' } });
  const setting = snapshot.get('deepseek-v4.1-flash');
  assert.equal(setting.configured, true);
  assert.equal(setting.reasoningEffort, 'max');
  assert.equal(setting.effectiveEffort, 'max');
});

test('关闭思考时不再下发 effort 且 effectiveEffort 为 null', () => {
  const snapshot = effectiveSettings([FLASH], { 'deepseek-v4.1-flash': { reasoningEffort: 'max', disableThinking: true } });
  const setting = snapshot.get('deepseek-v4.1-flash');
  assert.equal(setting.effectiveEffort, null, '关思考后不该再声称有强度');

  const { body, applied } = applyModelSettings({ model: 'x' }, FLASH, setting);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in body, false, '关思考不能同时带 effort，语义冲突');
  assert.deepEqual(applied, ['disableThinking']);
});

test('推理强度真的写进请求体', () => {
  const setting = normalizeModelSetting({ reasoningEffort: 'low' }, FLASH);
  const { body, applied } = applyModelSettings({ model: 'x' }, FLASH, setting);
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(applied, ['reasoning_effort=low']);
});

test('模型不支持推理时不写任何推理字段', () => {
  // 没有任何 reasoning 字段的模型
  const noReasoning = normalizeCatalogModel({ id: 'plain', maxInputTokens: 8000 });
  assert.equal(noReasoning.reasoning, null);
  const setting = normalizeModelSetting({ reasoningEffort: 'high', disableThinking: true }, noReasoning);
  const { body, applied } = applyModelSettings({ model: 'x' }, noReasoning, setting);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
  assert.deepEqual(applied, []);
});

test('单档模型：只能选它那一档或关掉，不能传别的档位', () => {
  const setting = normalizeModelSetting({ reasoningEffort: 'low' }, NO_DISABLE);
  assert.equal(setting.reasoningEffort, null, 'low 不在该模型的档位里，必须丢弃');
  const ok = normalizeModelSetting({ reasoningEffort: 'high' }, NO_DISABLE);
  assert.equal(ok.reasoningEffort, 'high');
});

test('applyModelSettings 不改原对象', () => {
  const original = { model: 'x', messages: [] };
  const snapshot = effectiveSettings([FLASH], { 'deepseek-v4.1-flash': { reasoningEffort: 'max' } });
  applyModelSettings(original, FLASH, snapshot.get('deepseek-v4.1-flash'));
  assert.equal('reasoning_effort' in original, false);
});

test('默认设置是关闭的（避免刚装好就列出一堆模型）', () => {
  assert.equal(DEFAULT_MODEL_SETTINGS.enabled, false);
});
