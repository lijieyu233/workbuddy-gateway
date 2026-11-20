// 配置读写。配置文件里含 API Key 明文（本机服务），因此文件权限收紧到 0600，且任何日志都不打印。
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { paths } from './paths.js';

export const DEFAULT_CONFIG = {
  version: 1,
  // 截图里的端口就是 57282，保持一致便于客户端直接照抄。
  port: 57282,
  // local = 仅本机回环；lan = 监听 0.0.0.0，供局域网其它机器接入。
  listen: 'local',
  // 实例网关：开启后本实例对外提供 /v1 服务；关闭等价于“代理”开关拨到关。
  gatewayEnabled: true,
  // 空数组时首次启动自动生成一把 agt_ 前缀的密钥。
  apiKeys: [],
  // 账号池：开启后失败自动换号。
  autoRotate: true,
  // 注意：没有"冷却"配置。账号失败只记录原因，不封锁账号（见 pool.pick 的排序策略）。
  maxConcurrentPerAccount: 2,
  // auto = 到期前自动用网关自己的副本续期；off = 只读桌面端登录态，过期即标记异常。
  tokenRefresh: 'auto',
  refreshSkewMs: 5 * 60_000,
  // 上游出口代理，例如 http://127.0.0.1:7890
  proxyUrl: '',
  requestLog: { enabled: true, maxEntries: 500 },
  // 客户端传了上游不认识的模型名时，退回到这个（必须是真实 id，不是显示名）。
  defaultModel: 'deepseek-v4.1-flash',
  // 面板允许局域网访问？默认只允许回环，避免把带密钥的面板暴露出去。
  allowPanelFromLan: false,
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  config.port = clampInt(config.port, 1, 65535, DEFAULT_CONFIG.port);
  config.listen = config.listen === 'lan' ? 'lan' : 'local';
  config.maxConcurrentPerAccount = clampInt(config.maxConcurrentPerAccount, 1, 16, 2);
  config.tokenRefresh = config.tokenRefresh === 'off' ? 'off' : 'auto';
  config.requestLog = { ...DEFAULT_CONFIG.requestLog, ...(config.requestLog || {}) };
  config.requestLog.maxEntries = clampInt(config.requestLog.maxEntries, 20, 5000, 500);
  config.apiKeys = Array.isArray(config.apiKeys) ? config.apiKeys.filter((k) => k && typeof k.key === 'string') : [];
  config.gatewayEnabled = config.gatewayEnabled !== false;
  config.autoRotate = config.autoRotate !== false;
  return config;
}

export function newApiKey() {
  // 前缀与截图一致：agt_ + 24 字节随机，方便在日志/面板里一眼认出。
  return `agt_${randomBytes(24).toString('base64url')}`;
}

export function maskKey(key) {
  if (typeof key !== 'string' || key.length <= 12) return '••••';
  return `${key.slice(0, 12)}${'•'.repeat(6)}${key.slice(-4)}`;
}

export function loadConfig() {
  if (!existsSync(paths.config)) return normalizeConfig({});
  try {
    return normalizeConfig(JSON.parse(readFileSync(paths.config, 'utf8')));
  } catch {
    // 坏配置不静默清空：留一份备份再回落到默认值，免得把用户密钥直接冲掉。
    try { renameSync(paths.config, `${paths.config}.broken-${Date.now()}`); } catch { /* ignore */ }
    return normalizeConfig({});
  }
}

export function saveConfig(config) {
  // 先确保目录存在：首次启动时 HOME 还不存在，直接写临时文件会 ENOENT。
  paths.home;
  const target = paths.config;
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  chmodSync(target, 0o600);
  return config;
}

export function ensureApiKey(config) {
  if (config.apiKeys.length > 0) return config;
  const key = newApiKey();
  config.apiKeys = [{ id: randomBytes(6).toString('hex'), key, label: '默认密钥', createdAt: Date.now(), lastUsedAt: 0, requests: 0 }];
  saveConfig(config);
  return config;
}

export function findApiKey(config, raw) {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  return config.apiKeys.find((entry) => entry.key === token);
}
