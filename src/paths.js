// 目录与文件位置：所有状态都放在用户目录下的 ~/.workbuddy-gateway，绝不写 WorkBuddy 桌面端的认证文件。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function homeDir() {
  return process.env.WORKBUDDY_GATEWAY_HOME || join(homedir(), '.workbuddy-gateway');
}

export function ensureHome() {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const paths = {
  get home() { return ensureHome(); },
  get config() { return join(homeDir(), 'config.json'); },
  get accounts() { return join(homeDir(), 'accounts.json'); },
  get logs() { return join(homeDir(), 'requests.jsonl'); },
  get catalog() { return join(homeDir(), 'catalog.json'); },
};
