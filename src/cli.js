#!/usr/bin/env node
// 启动入口：workbuddy-gateway [--port 57282] [--lan] [--open]
import { createGateway } from './server.js';
import { loadConfig, saveConfig, normalizeConfig } from './config.js';
import { Pool } from './pool.js';
import { scanDesktopAccounts, mergeScanned } from './accounts.js';
import { exec } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const raw = loadConfig();
if (valueOf('--port')) raw.port = Number(valueOf('--port'));
if (flag('--lan')) raw.listen = 'lan';
if (flag('--local')) raw.listen = 'local';
const config = normalizeConfig(raw);
saveConfig(config);

const pool = new Pool(config);

// 首次启动先扫一遍本机登录态，省得用户还要点一次“重新检测”。
const scanned = scanDesktopAccounts();
if (scanned.length > 0) {
  const { store, added, updated } = mergeScanned(pool.store, scanned);
  pool.store = store;
  pool.persist();
  console.log(`[账号] 本机检测到 ${scanned.length} 个 WorkBuddy 登录态（新增 ${added}，更新 ${updated}）`);
} else {
  console.log('[账号] 本机没有检测到 WorkBuddy 桌面端登录态，可在面板里手动导入');
}

const { server } = createGateway({ config, pool });

const host = config.listen === 'lan' ? '0.0.0.0' : '127.0.0.1';
server.listen(config.port, host, () => {
  const shown = config.listen === 'lan' ? `http://127.0.0.1:${config.port}` : `http://127.0.0.1:${config.port}`;
  console.log('');
  console.log('  WorkBuddy 反代网关已启动');
  console.log(`  面板    ${shown}`);
  console.log(`  API     http://127.0.0.1:${config.port}/v1`);
  console.log(`  监听    ${config.listen === 'lan' ? '局域网（0.0.0.0）' : '仅本机（127.0.0.1）'}`);
  console.log(`  账号    ${pool.summary().available}/${pool.summary().total} 可用`);
  console.log('');
  if (flag('--open')) openBrowser(shown);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${config.port} 已被占用，用 --port 换一个，或先关掉占用它的程序`);
  } else {
    console.error('[错误]', error.message);
  }
  process.exit(1);
});

function openBrowser(url) {
  const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

const shutdown = () => {
  console.log('\n正在退出…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
// 面板上的「×」通过 /api/shutdown 走到这里，保证退出前先把监听关掉。
globalThis.__wbgwShutdown = shutdown;
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
