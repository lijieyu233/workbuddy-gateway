// 预加载脚本：只暴露窗口控制需要的三个方法。
//
// 面板本身是个普通网页，不该拿到 Node 能力；这里用最小接口把
// 「最小化 / 最大化 / 关闭」交给页面自绘的按钮调用。
// 浏览器直接打开面板时（没有 preload），这些方法不存在，
// 页面会据此自动隐藏自绘标题栏按钮。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  // 订阅最大化状态变化，用来切换按钮图标
  onStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('window-state', handler);
    return () => ipcRenderer.removeListener('window-state', handler);
  },
});
