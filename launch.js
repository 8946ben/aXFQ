'use strict';
// 零依赖启动器：优先用本项目的 electron，否则复用本机 clawd-on-desk 已安装的 electron。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const candidates = [
  path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe'),
  'D:/program/clawd/clawd-on-desk/node_modules/electron/dist/electron.exe',
  process.env.ASOUL_ELECTRON || '',
].filter(Boolean);

const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('[A-SOUL] 找不到 electron.exe。请先运行 npm install，或设置环境变量 ASOUL_ELECTRON 指向 electron.exe。');
  process.exit(1);
}

// WorkBuddy / Claude Code 等 Electron 宿主会设置 ELECTRON_RUN_AS_NODE=1，
// 这会让 Electron 退化成纯 Node 进程，require('electron') 拿不到 app。
// 启动 GUI 前必须剥掉（与 clawd-on-desk 的 launch.js 同样处理）。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [__dirname];
// ASOUL_CDP=1 时开放本地调试端口，方便自动化验证（默认关闭）
if (process.env.ASOUL_CDP === '1') args.push('--remote-debugging-port=9222');

console.log('[A-SOUL] using', exe);
const child = spawn(exe, args, { stdio: 'inherit', windowsHide: false, env, cwd: __dirname });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('[A-SOUL] 启动失败:', err.message);
  process.exit(1);
});
