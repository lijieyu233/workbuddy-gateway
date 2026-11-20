// Electron 主进程：把网关作为子进程拉起，窗口指向面板。
//
// 关键点：不重复实现业务逻辑，窗口只是点开那个本地面板。
// 关窗即退出网关（避免后台留一个孤儿进程占着端口）。
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { join, dirname } = require('node:path');
const { createConnection } = require('node:net');

const here = __dirname;
const PORT = Number(process.env.WBGW_PORT || 57282);
const HOST = '127.0.0.1';

let gateway = null;
let win = null;
let tray = null;
let quitting = false;

/** 端口是否已被监听（用来判断网关是否就绪，或已有实例占用）。 */
function isPortOpen(port, host = HOST, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForGateway(port, deadlineMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function startGateway() {
  const cli = join(here, '..', 'src', 'cli.js');
  gateway = spawn(process.execPath, [cli, '--port', String(PORT)], {
    cwd: join(here, '..'),
    // ELECTRON_RUN_AS_NODE：让同一个可执行文件以纯 Node 方式跑网关，
    // 省掉再装一个 Node 运行时。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  gateway.stdout?.on('data', (chunk) => process.stdout.write(`[gateway] ${chunk}`));
  gateway.stderr?.on('data', (chunk) => process.stderr.write(`[gateway] ${chunk}`));
  gateway.on('exit', (code) => {
    gateway = null;
    if (!quitting && code !== 0) {
      dialog.showErrorBox('网关已退出', `网关进程意外退出（退出码 ${code}）。\n请查看日志后重试。`);
    }
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'WorkBuddy 网关',
    // 和页面 body 背景一致，窗口创建瞬间不会闪白
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    // 自绘标题栏：系统那条白/灰标题栏和深色界面割裂，
    // 而且 Windows 上会多出一整行占位。改用无边框 + 页面内自绘控制按钮。
    frame: false,
    // 保留系统圆角与阴影（Win11），视觉上仍像一个正常窗口
    roundedCorners: true,
    // 最大化时不要把内容盖到任务栏下面
    webPreferences: {
      // 面板只是本地页面，不需要 Node 能力，保持隔离
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 由页面通过 IPC 之外的窗口控制按钮实现最小化/最大化，
      // 这里只需要 preload 暴露三个方法
      preload: join(__dirname, 'preload.cjs'),
    },
  });

  // 最大化状态变化要通知页面，好让按钮图标（□ / ❐）跟着变
  const sendState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('window-state', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
  win.webContents.once('did-finish-load', sendState);

  // 外部链接走系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://${HOST}:${PORT}/`);
  win.on('closed', () => { win = null; });
}

function buildTray() {
  // 托盘图标：用内置的 1x1 透明图会看不见，这里画一个简单的圆形
  // （避免额外依赖图标文件，且能在所有平台显示）
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inside = dx * dx + dy * dy <= (size / 2 - 1) ** 2;
      const i = (y * size + x) * 4;
      // BGRA
      buf[i] = inside ? 255 : 0;
      buf[i + 1] = inside ? 141 : 0;
      buf[i + 2] = inside ? 76 : 0;
      buf[i + 3] = inside ? 255 : 0;
    }
  }
  const image = nativeImage.createFromBuffer(buf, { width: size, height: size });
  try {
    tray = new Tray(image);
    tray.setToolTip(`WorkBuddy 反代网关 · ${HOST}:${PORT}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: () => (win ? win.show() : createWindow()) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => (win ? win.isVisible() ? win.focus() : win.show() : createWindow()));
  } catch {
    // 托盘在某些 Linux 环境不可用，不影响主窗口
    tray = null;
  }
}

// 无 GPU 的机器（远程桌面、虚拟机、部分老机器）上，Chromium 的 GPU 进程会
// 反复崩溃并最终 FATAL 退出整个应用。面板是纯 DOM 界面，不需要 GPU 加速，
// 所以直接关掉硬件加速——代价为零，换来的是这类环境下能正常打开。
app.disableHardwareAcceleration();
// 更进一步：完全禁用 GPU 进程，避免它在启动阶段就 FATAL。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
// 某些 Windows 环境下启用 GPU 沙箱会导致进程起不来
app.commandLine.appendSwitch('no-sandbox');
// 关掉磁盘缓存：默认缓存目录偶尔会因为权限（拒绝访问 0x5）建不起来，
// 反复刷错误日志。面板是本地静态页，不需要 HTTP 缓存。
app.commandLine.appendSwitch('disable-http-cache');
// 把 Electron 的 userData 放到用户目录下，避免项目目录不可写导致缓存/存储失败。
app.setPath('userData', join(app.getPath('appData'), 'workbuddy-gateway-desktop'));

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // 页面自绘标题栏上的三个按钮（无边框窗口下没有系统按钮可点）
  ipcMain.on('window:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
  ipcMain.on('window:toggle-maximize', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => { if (win && !win.isDestroyed()) win.close(); });

  // 端口已占用：可能是上一次没退干净，也可能用户自己在跑 cli.js。
  // 两种情况都直接连上已有实例，不另起一个抢端口。
  if (await isPortOpen(PORT)) {
    await createWindow();
  } else {
    startGateway();
    const ready = await waitForGateway(PORT);
    if (!ready) {
      dialog.showErrorBox('启动失败', `网关在 20 秒内没有就绪（端口 ${PORT}）。\n可能是端口被占用，或有旧进程没退出。`);
      app.quit();
      return;
    }
    await createWindow();
  }
  buildTray();

  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  quitting = true;
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (gateway) {
    try { gateway.kill(); } catch { /* ignore */ }
    gateway = null;
  }
  if (tray) { try { tray.destroy(); } catch { /* ignore */ } }
});
