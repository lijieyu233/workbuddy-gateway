// 账号库：读本机 WorkBuddy 登录态、导入导出、原子落盘。
// 绝不写 WorkBuddy 桌面端的认证文件——只读它，写永远只写本软件自己的副本。
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { paths } from './paths.js';

const LIVE_FILENAME = 'workbuddy-desktop.info';

export function desktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ];
  }
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME || join(home, '.config');
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  return [];
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

/** 解开桌面端的加密字段包装（Windows 新版本会加密 token）。不支持的包装一律当作缺失。 */
function field(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && value.$wbEncrypted) return undefined;
  return undefined;
}

/**
 * 解析一份 WorkBuddy auth 文档，两种形态都认：
 *   插件形 {auth:{accessToken,...},account:{uid,uin,...}}
 *   扁平形 {accessToken:...}
 * 返回 undefined 表示这份文档没有可用令牌（不是错误，扫描时跳过即可）。
 */
export function parseAuthDocument(text, filePath = '', mtimeMs = 0) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const auth = parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : parsed;
  const identity = parsed.account && typeof parsed.account === 'object' ? parsed.account : parsed;
  const accessToken = field(auth.accessToken);
  if (!accessToken) return undefined;
  const refreshToken = field(auth.refreshToken) || '';
  const domain = field(auth.domain) || '';
  const uid = field(identity.uid) || '';
  const uin = field(identity.uin) || '';
  const nickname = field(identity.nickname) || field(identity.displayName) || '';
  const accountType = field(identity.type) || field(identity.accountType) || '';
  const enterpriseId = field(identity.enterpriseId) || undefined;
  const expiresAtMs = toMs(auth.expiresAt) || (typeof auth.expiresIn === 'number' ? mtimeMs + auth.expiresIn * 1000 : 0);
  const refreshExpiresAtMs = toMs(auth.refreshExpiresAt) || (typeof auth.refreshExpiresIn === 'number' ? mtimeMs + auth.refreshExpiresIn * 1000 : 0);
  return {
    uid,
    uin,
    nickname,
    domain,
    accountType,
    enterpriseId,
    accessToken,
    refreshToken,
    expiresAtMs,
    refreshExpiresAtMs,
    source: filePath ? 'desktop' : 'manual',
    filePath,
    fileMtimeMs: mtimeMs,
  };
}

export function accountIdOf(record) {
  // 种子必须稳定且能区分账号。uid 最可靠；uin 次之；
  // 最后才用令牌（令牌会续期变化，但总比空好）。
  // 注意：三种字段名都认——内部记录用 accessToken，
  // 账号池导出文件用 access_token；只认一种会让导出文件算出空种子。
  const seed = record.uid || record.uin || record.accessToken || record.access_token || '';
  if (seed === '') {
    // 空种子会得到空字符串的哈希，所有缺字段的账号会算出同一个 id 并互相覆盖。
    // 宁可报错，也不要静默地把两个账号合并成一个。
    throw new Error('无法确定账号身份：uid / uin / 令牌都为空');
  }
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 12);
}

/**
 * 解析「账号池导出文件」格式。
 *
 * 这是另一种完全不同的形状：顶层是**数组**，字段是 **snake_case**，而且每项里还嵌了
 * auth_raw / quota_raw / usage_raw 等原始数据：
 *
 *   [{ "uid": "...", "nickname": "...", "access_token": "eyJ...",
 *      "refresh_token": "eyJ...", "domain": "www.workbuddy.cn",
 *      "expires_at": 1797401144438,
 *      "auth_raw": { "auth": { "accessToken": ... }, "account": {...} },
 *      "quota_raw": { ... } }]
 *
 * 只做字段映射，不做猜测：
 *   - access_token 必须有，否则这一项跳过（并记下原因）；
 *   - expires_at 是**毫秒**时间戳（实测 1797401144438 ≈ 2026 年），不是秒；
 *   - quota_raw 里的积分按 CreditGroups 汇总，取不到就留空，不编造 0。
 *
 * @returns {{record?: object, error?: string}}
 */
export function parsePoolEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: '不是对象' };
  }
  // snake_case 优先，兼容驼峰（有的人会把两种混着填）
  const accessToken = field(entry.access_token) ?? field(entry.accessToken)
    // 再退回嵌套的 auth_raw.auth.accessToken（导出的原始登录态）
    ?? field(entry.auth_raw?.auth?.accessToken);
  if (!accessToken) return { error: '没有 access_token' };

  const refreshToken = field(entry.refresh_token) ?? field(entry.refreshToken)
    ?? field(entry.auth_raw?.auth?.refreshToken) ?? '';
  const identity = entry.auth_raw?.account ?? entry.profile_raw ?? entry;
  const uid = field(entry.uid) ?? field(identity?.uid) ?? '';
  const uin = field(entry.uin) ?? field(identity?.uin) ?? '';
  const nickname = field(entry.nickname) || field(entry.email) || field(identity?.nickname) || '';
  const domain = field(entry.domain) ?? field(entry.auth_raw?.auth?.domain) ?? '';
  const accountType = field(identity?.type) || field(entry.accountType) || '';

  // expires_at 已经是毫秒；expiresAt 可能是秒或毫秒，toMs 会判。
  // expires_in 是「从现在起多少秒」，需要以导入时刻为基准换算。
  const expiresAtMs = toMs(entry.expires_at)
    || toMs(entry.expiresAt)
    || toMs(entry.auth_raw?.auth?.expiresAt)
    || (typeof entry.expires_in === 'number' ? Date.now() + entry.expires_in * 1000 : 0);
  const refreshExpiresAtMs = toMs(entry.refresh_expires_at)
    || toMs(entry.refreshExpiresAt)
    || toMs(entry.auth_raw?.auth?.refreshExpiresAt)
    || (typeof entry.refresh_expires_in === 'number' ? Date.now() + entry.refresh_expires_in * 1000 : 0);

  return {
    record: {
      uid,
      uin,
      nickname,
      domain,
      accountType,
      enterpriseId: field(entry.enterpriseId) ?? field(identity?.enterpriseId) ?? undefined,
      accessToken,
      refreshToken,
      expiresAtMs,
      refreshExpiresAtMs,
      // 这种导出常常带积分快照，能读出来就一并存下（面板「余额」有据可查）
      credits: parsePoolCredits(entry.quota_raw ?? entry.usage_raw),
      source: 'import',
    },
  };
}

/**
 * 从 quota_raw / usage_raw 里汇总积分。
 *
 * 两种结构都见过：
 *   quota_raw.data.resourceSummary.CreditGroups[].CycleRemainCapacity / CycleTotalCapacity
 *   usage_raw.data.resourceSummary.CreditGroups[]（同上）
 * 数值是字符串（"3135.01000281"），要转成数字。
 * 读不到就返回 undefined —— 不返回 {remaining:0}，那会把"不知道"说成"用光了"。
 */
export function parsePoolCredits(raw) {
  const summary = raw?.data?.resourceSummary
    ?? raw?.resourceSummary
    ?? raw?.userResource?.data?.resourceSummary;
  const groups = summary?.CreditGroups;
  if (!Array.isArray(groups) || groups.length === 0) return undefined;
  let remaining = 0;
  let size = 0;
  let found = false;
  for (const group of groups) {
    const remain = Number(group?.CycleRemainCapacity);
    const total = Number(group?.CycleTotalCapacity);
    if (Number.isFinite(remain)) { remaining += remain; found = true; }
    if (Number.isFinite(total)) size += total;
  }
  if (!found) return undefined;
  return {
    remaining: +remaining.toFixed(4),
    size: +size.toFixed(4),
    packs: groups.length,
  };
}

/**
 * 把一段 JSON 文本解析成 0..N 个账号记录。
 *
 * 支持三种输入，靠结构自动分辨，不需要用户选格式：
 *   1. 数组                     → 逐项按 parsePoolEntry 解析（账号池导出）
 *   2. {accounts:[...]}         → 同上
 *   3. 单个 auth 文档           → parseAuthDocument（桌面端那种）
 *
 * 返回 { records, errors }：errors 让面板能说清"哪一项为什么没进来"，
 * 而不是静默丢掉几条账号让人以为导入成功。
 */
export function parseImportPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], errors: ['不是合法 JSON'] };
  }

  const records = [];
  const errors = [];
  const pushEntry = (entry, index) => {
    const { record, error } = parsePoolEntry(entry);
    if (record) records.push(record);
    else errors.push(`第 ${index + 1} 项：${error}`);
  };

  if (Array.isArray(parsed)) {
    parsed.forEach(pushEntry);
    return { records, errors };
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
    parsed.accounts.forEach(pushEntry);
    return { records, errors };
  }

  // 单个 auth 文档：沿用原来的解析器
  const single = parseAuthDocument(text, '', Date.now());
  if (single) return { records: [single], errors: [] };
  return { records: [], errors: ['这份 JSON 里没有可用的 accessToken'] };
}


/**
 * 扫描本机桌面端登录态。
 *
 * 默认只读 live 文件 `workbuddy-desktop.info`：这是 App 当前的登录，
 * 同目录里那一堆带时间戳的 `*.info` 是历次登录的备份，上游早已吊销它们的令牌
 * （实测：备份里的 expiresAt 还在未来，发请求却一律 401）。把它们当账号收进来，
 * 只会让账号池一开始就显示一堆“可用”、实际每次都要失败换号。
 * 需要挖历史备份时显式传 { includeBackups: true }。
 */
export function scanDesktopAccounts(dirs = desktopAuthDirs(), { includeBackups = false } = {}) {
  const best = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.info') || name.includes('.observation.')) continue;
      const isLive = name === LIVE_FILENAME;
      if (!isLive && !includeBackups) continue;
      const filePath = join(dir, name);
      let text;
      let mtimeMs;
      try {
        text = readFileSync(filePath, 'utf8');
        mtimeMs = statSync(filePath).mtimeMs;
      } catch { continue; }
      const parsed = parseAuthDocument(text, filePath, mtimeMs);
      if (!parsed) continue;
      const key = `${parsed.uid || parsed.uin}:${parsed.domain}`;
      const previous = best.get(key);
      if (!previous) { best.set(key, parsed); continue; }
      const prevLive = previous.filePath.endsWith(LIVE_FILENAME);
      if (prevLive !== isLive) {
        if (isLive) best.set(key, parsed);
        continue;
      }
      if (parsed.fileMtimeMs > previous.fileMtimeMs) best.set(key, parsed);
    }
  }
  return [...best.values()];
}

export function loadAccounts() {
  if (!existsSync(paths.accounts)) return { version: 1, accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(paths.accounts, 'utf8'));
    if (!parsed || !Array.isArray(parsed.accounts)) return { version: 1, accounts: [] };
    return { version: 1, accounts: parsed.accounts.filter((a) => a && typeof a.id === 'string') };
  } catch {
    try { renameSync(paths.accounts, `${paths.accounts}.broken-${Date.now()}`); } catch { /* ignore */ }
    return { version: 1, accounts: [] };
  }
}

export function saveAccounts(store) {
  const target = paths.accounts;
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  chmodSync(target, 0o600);
}

/** 合并扫描结果：保留用户已有的状态/统计/标签，只更新令牌与身份字段。 */
export function mergeScanned(store, scanned, now = Date.now()) {
  const byId = new Map(store.accounts.map((account) => [account.id, account]));
  let added = 0;
  let updated = 0;
  for (const record of scanned) {
    const id = accountIdOf(record);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        ...record,
        label: '',
        disabled: false,
        createdAt: now,
        updatedAt: now,
        usage: null,
        stats: { requests: 0, failures: 0, credits: 0 },
        lastError: '',
      });
      added += 1;
      continue;
    }
    const before = existing.accessToken;
    Object.assign(existing, {
      uid: record.uid || existing.uid,
      uin: record.uin || existing.uin,
      nickname: record.nickname || existing.nickname,
      domain: record.domain || existing.domain,
      accountType: record.accountType || existing.accountType,
      enterpriseId: record.enterpriseId || existing.enterpriseId,
      accessToken: record.accessToken,
      refreshToken: record.refreshToken || existing.refreshToken,
      expiresAtMs: record.expiresAtMs || existing.expiresAtMs,
      refreshExpiresAtMs: record.refreshExpiresAtMs || existing.refreshExpiresAtMs,
      filePath: record.filePath || existing.filePath,
      fileMtimeMs: record.fileMtimeMs || existing.fileMtimeMs,
      updatedAt: now,
    });
    if (before !== existing.accessToken) updated += 1;
  }
  return { store: { version: 1, accounts: [...byId.values()] }, added, updated };
}

export function planOf(account) {
  const type = String(account.accountType || '').toLowerCase();
  if (account.enterpriseId || type === 'ultimate' || type === 'enterprise' || type === 'business') return 'enterprise';
  return 'personal';
}

export function planLabel(plan) {
  return plan === 'enterprise' ? 'ENTERPRISE' : 'PERSONAL';
}

/** 对外脱敏：列表接口绝不回传令牌明文，只回长度与是否可续期。 */
export function redact(account, runtime) {
  return {
    id: account.id,
    uid: account.uid,
    uin: account.uin,
    nickname: account.nickname,
    label: account.label || '',
    domain: account.domain,
    region: String(account.domain || '').match(/workbuddy\.ai|codebuddy\.ai/) ? 'global' : 'cn',
    plan: planOf(account),
    planLabel: planLabel(planOf(account)),
    accountType: account.accountType,
    enterpriseId: account.enterpriseId || '',
    disabled: account.disabled === true,
    source: account.source,
    hasRefreshToken: Boolean(account.refreshToken),
    expiresAtMs: account.expiresAtMs,
    updatedAt: account.updatedAt,
    ...runtime,
  };
}
