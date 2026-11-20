// 请求日志：环形缓冲，落 JSONL；只记录元数据，正文与令牌一律不落盘。
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { paths } from './paths.js';

export class RequestLog {
  constructor(config) {
    this.config = config;
    this.entries = [];
    this.load();
  }

  load() {
    if (!existsSync(paths.logs)) return;
    try {
      const lines = readFileSync(paths.logs, 'utf8').split('\n').filter(Boolean);
      const slice = lines.slice(-this.config.requestLog.maxEntries);
      this.entries = slice.map((line) => {
        try { return JSON.parse(line); } catch { return undefined; }
      }).filter(Boolean);
    } catch { /* 日志坏了不影响服务 */ }
  }

  push(entry) {
    if (!this.config.requestLog.enabled) return entry;
    const record = {
      id: entry.id,
      at: Date.now(),
      method: entry.method,
      path: entry.path,
      model: entry.model,
      accountId: entry.accountId,
      stream: entry.stream === true,
      status: entry.status,
      ms: entry.ms,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      credit: entry.credit ?? null,
      error: entry.error ? String(entry.error).slice(0, 400) : '',
      keyLabel: entry.keyLabel || '',
      // 只有失败的请求才记请求体摘要：这类 400 不看 body 根本查不出原因。
      // 成功请求不记，避免把对话内容落到磁盘上。
      requestShape: entry.requestShape || '',
    };
    this.entries.push(record);
    if (this.entries.length > this.config.requestLog.maxEntries) {
      this.entries = this.entries.slice(-this.config.requestLog.maxEntries);
      // 超限时整体重写，避免日志无限增长
      try { writeFileSync(paths.logs, `${this.entries.map((item) => JSON.stringify(item)).join('\n')}\n`); } catch { /* ignore */ }
    } else {
      try { appendFileSync(paths.logs, `${JSON.stringify(record)}\n`); } catch { /* ignore */ }
    }
    return record;
  }

  recent(limit = 50) {
    return this.entries.slice(-Math.max(1, Math.min(limit, 500))).reverse();
  }

  clear() {
    this.entries = [];
    try { writeFileSync(paths.logs, ''); } catch { /* ignore */ }
  }

  stats() {
    const now = Date.now();
    const dayAgo = now - 24 * 3600 * 1000;
    const recent = this.entries.filter((entry) => entry.at >= dayAgo);
    const failed = recent.filter((entry) => entry.error).length;
    const credits = recent.reduce((sum, entry) => sum + (typeof entry.credit === 'number' ? entry.credit : 0), 0);
    return {
      total: this.entries.length,
      last24h: recent.length,
      failed24h: failed,
      credits24h: +credits.toFixed(4),
    };
  }
}
