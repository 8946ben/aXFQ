'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, screen, shell,
  nativeImage, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = __dirname;
const STICKERS = path.join(ROOT, 'assets', 'stickers');
const BALL_SIZE = 124;
const PANEL_W = 384;
const PANEL_H = 576;

const CHARACTERS = {
  diana: { name: '嘉然', color: '#ff6fa5', soft: '#ffe6f0' },
  bella: { name: '贝拉', color: '#4d8dff', soft: '#e4eeff' },
  eileen: { name: '乃琳', color: '#9b6df3', soft: '#efe6ff' },
};
const EMOTES = ['idle', 'focus', 'tomato', 'rest', 'done', 'hey', 'cheer', 'wink', 'love', 'extra1', 'extra2'];

let DATA_FILE;
try {
  DATA_FILE = path.join(app.getPath('userData'), 'state.json');
} catch (_) {
  DATA_FILE = path.join(ROOT, 'data', 'state.json');
}

const DEFAULTS = {
  character: 'diana',
  ballPos: null,
  alwaysOnTop: true,
  autoStart: false,
  pomodoro: { focus: 25, short: 5, long: 15, longEvery: 4, autoNext: false, sound: true },
  presets: [], // 自定义标签：{ id, label, minutes, kind: 'focus'|'break', message, emote }
  stats: { date: todayKey(), completed: 0, focusMinutes: 0, totalCompleted: 0, totalMinutes: 0 },
  history: [], // 完成记录：{ at, label, kind, minutes, emote }
  notes: [],
  recentLimit: 60,
};

let state = loadState();
let ballWin = null;
let panelWin = null;
let tray = null;
let quitting = false;
let dragOrigin = null;
let saveTimer = null;
let desiredTab = 'pomodoro';

// ────────────────────────────── 状态持久化 ──────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const merged = {
      ...DEFAULTS, ...raw,
      pomodoro: { ...DEFAULTS.pomodoro, ...(raw.pomodoro || {}) },
      stats: { ...DEFAULTS.stats, ...(raw.stats || {}) },
    };
    if (!CHARACTERS[merged.character]) merged.character = 'diana';
    if (!Array.isArray(merged.notes)) merged.notes = [];
    if (!Array.isArray(merged.presets)) merged.presets = [];
    merged.presets = merged.presets.map(sanitizePreset).filter(Boolean).slice(0, 12);
    if (!Array.isArray(merged.history)) merged.history = [];
    merged.history = merged.history.filter((r) => r && Number.isFinite(r.at)).slice(-500);
    // 旧版本没有 totalMinutes，用当日专注分钟补齐，避免「累计番茄 5 / 累计分钟 0」
    merged.stats.totalMinutes = Number(merged.stats.totalMinutes) || Number(merged.stats.focusMinutes) || 0;
    if (merged.stats.date !== todayKey()) {
      merged.stats = {
        date: todayKey(), completed: 0, focusMinutes: 0,
        totalCompleted: merged.stats.totalCompleted || 0,
        totalMinutes: merged.stats.totalMinutes || 0,
      };
    } else {
      merged.stats.date = todayKey();
    }
    return merged;
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.error('[A-SOUL] save state failed:', err.message);
    }
  }, 250);
}

// ────────────────────────────── 番茄钟 ──────────────────────────────
let timer = { mode: 'focus', remaining: 0, total: 0, running: false, endsAt: 0, cycle: 0 };

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

// 自定义标签（预设）：名称 + 时长 + 类型 + 完成话语 + 表情
function sanitizePreset(p) {
  if (!p || typeof p !== 'object') return null;
  const label = String(p.label || '').trim().slice(0, 12);
  if (!label) return null;
  const id = /^[a-z0-9_-]{3,40}$/i.test(String(p.id || ''))
    ? String(p.id)
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    label,
    minutes: clampInt(p.minutes, 1, 180, 25),
    kind: p.kind === 'break' ? 'break' : 'focus',
    message: String(p.message || '').trim().slice(0, 120),
    emote: EMOTES.includes(p.emote) ? p.emote : 'done',
  };
}

function presetOf(mode) {
  if (typeof mode !== 'string' || !mode.startsWith('preset:')) return null;
  const id = mode.slice(7);
  return state.presets.find((p) => p.id === id) || null;
}

function modeKind(mode) {
  if (mode === 'focus') return 'focus';
  if (mode === 'short' || mode === 'long') return 'break';
  const p = presetOf(mode);
  return p ? p.kind : 'focus';
}

function modeLabel(mode) {
  if (mode === 'focus') return '专注';
  if (mode === 'short') return '短休';
  if (mode === 'long') return '长休';
  const p = presetOf(mode);
  return p ? p.label : '专注';
}

function isValidMode(mode) {
  return ['focus', 'short', 'long'].includes(mode) || !!presetOf(mode);
}

function durationOf(mode) {
  if (mode === 'focus' || mode === 'short' || mode === 'long') {
    const fallback = mode === 'focus' ? 25 : mode === 'short' ? 5 : 15;
    return Math.max(1, Number(state.pomodoro[mode]) || fallback) * 60;
  }
  const p = presetOf(mode);
  return Math.max(1, Number(p && p.minutes) || 25) * 60;
}

function timerSnapshot() {
  return {
    ...timer,
    label: modeLabel(timer.mode),
    kind: modeKind(timer.mode),
    progress: timer.total > 0 ? Math.min(1, Math.max(0, 1 - timer.remaining / timer.total)) : 0,
    durations: { ...state.pomodoro },
    presets: state.presets,
    today: { ...state.stats },
  };
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function emitTimer() { broadcast('timer:tick', timerSnapshot()); }

function setMode(mode, keepRunning = false) {
  if (!isValidMode(mode)) mode = 'focus';
  timer.mode = mode;
  timer.total = durationOf(mode);
  timer.remaining = timer.total;
  timer.running = false;
  timer.endsAt = 0;
  if (!keepRunning) emitTimer();
}

function startTimer() {
  if (timer.running) return;
  if (timer.remaining <= 0) timer.remaining = timer.total || durationOf(timer.mode);
  timer.endsAt = Date.now() + timer.remaining * 1000;
  timer.running = true;
  emitTimer();
  broadcast('ball:emote', { emote: modeKind(timer.mode) === 'focus' ? 'tomato' : 'rest', hold: 1600 });
}

function pauseTimer() {
  if (!timer.running) return;
  timer.remaining = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  timer.running = false;
  timer.endsAt = 0;
  emitTimer();
}

function resetTimer() {
  setMode(timer.mode);
  broadcast('ball:emote', { emote: 'hey', hold: 1200 });
}

function notify(title, body) {
  try {
    const icon = stickerPath(state.character, 'done');
    new Notification({ title, body, icon: fs.existsSync(icon) ? icon : undefined, silent: false }).show();
  } catch (err) {
    console.error('[A-SOUL] notification failed:', err.message);
  }
}

// 完成后朗读自定义话语：交给常驻的悬浮球窗口，面板隐藏时也能出声
function speak(text) {
  if (!text) return;
  if (ballWin && !ballWin.isDestroyed() && ballWin.webContents && !ballWin.webContents.isDestroyed()) {
    ballWin.webContents.send('speak', { text: String(text).slice(0, 160) });
  }
}

function rollDay() {
  if (state.stats.date === todayKey()) return;
  state.stats = {
    date: todayKey(), completed: 0, focusMinutes: 0,
    totalCompleted: state.stats.totalCompleted || 0,
    totalMinutes: state.stats.totalMinutes || 0,
  };
}

function finishTimer() {
  const finished = timer.mode;
  const kind = modeKind(finished);
  const label = modeLabel(finished);
  const preset = presetOf(finished);
  const minutes = Math.max(1, Math.round((timer.total || durationOf(finished)) / 60));

  timer.running = false;
  timer.endsAt = 0;
  rollDay();

  const emote = preset ? preset.emote : (kind === 'focus' ? 'done' : 'hey');
  state.history.push({ at: Date.now(), label, kind, minutes, emote });
  if (state.history.length > 500) state.history = state.history.slice(-500);

  if (kind === 'focus') {
    state.stats.completed += 1;
    state.stats.totalCompleted = (state.stats.totalCompleted || 0) + 1;
    state.stats.focusMinutes += minutes;
    state.stats.totalMinutes = (state.stats.totalMinutes || 0) + minutes;
    timer.cycle += 1;
    const every = Math.max(1, Number(state.pomodoro.longEvery) || 4);
    setMode(timer.cycle % every === 0 ? 'long' : 'short', true);
    notify('专注完成啦！', `${CHARACTERS[state.character].name}：休息一下吧～ 今日已完成 ${state.stats.completed} 个`);
  } else {
    setMode('focus', true);
    notify('休息结束', `${CHARACTERS[state.character].name}：该回来专注啦`);
  }

  saveState();
  broadcast('timer:done', {
    from: finished, fromLabel: label, fromKind: kind, next: timer.mode,
    sound: state.pomodoro.sound !== false,
    message: preset ? preset.message : '',
    emote,
  });
  broadcast('state:changed', state);
  broadcast('ball:emote', { emote, hold: 5000 });
  if (preset && preset.message) speak(preset.message);
  if (state.pomodoro.autoNext) startTimer();
  emitTimer();
}

function tick() {
  if (!timer.running) return;
  const rem = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  if (rem !== timer.remaining) {
    timer.remaining = rem;
    emitTimer();
  }
  if (rem <= 0) finishTimer();
}

// ────────────────── 最近访问的文件 / 最近打开的文件夹 ──────────────────
// Windows「最近使用的项目」(%APPDATA%\Microsoft\Windows\Recent\*.lnk) 里
// 既有打开过的文档，也有资源管理器打开过的文件夹，一份数据覆盖两类需求。
// 用 Electron 内置 shell.readShortcutLink 解析 .lnk，不启动任何外部进程。
function recentDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'Microsoft', 'Windows', 'Recent');
}

function resolveShortcut(lnkPath) {
  try {
    const detail = shell.readShortcutLink(lnkPath);
    return typeof detail.target === 'string' ? detail.target.trim() : '';
  } catch (_) {
    return ''; // 损坏的 / 指向特殊 Shell 项的快捷方式
  }
}

function listRecent() {
  const dir = recentDir();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { dir, items: [], scanned: 0, error: err.message };
  }

  const candidates = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.lnk'))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const limit = Math.max(10, Math.min(120, Number(state.recentLimit) || 60));
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const target = resolveShortcut(c.full);
    // 过滤 GUID 型 Shell 项、控制面板项、已失效目标
    if (!target || target.startsWith('::{') || target.startsWith('shell:')) continue;
    let st;
    try { st = fs.statSync(target); } catch (_) { continue; }
    const isDir = st.isDirectory();
    const clean = target.replace(/[\\/]+$/, '') || target;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = path.basename(clean) || clean;
    out.push({
      name,
      path: target,
      parent: path.dirname(target),
      isDir,
      ext: isDir ? 'folder' : (path.extname(name).toLowerCase().slice(1) || 'file'),
      size: isDir ? 0 : st.size,
      mtime: c.mtime || Date.now(), // .lnk 的修改时间即最近访问时间
    });
    if (out.length >= limit) break;
  }
  return { dir, items: out, scanned: candidates.length, error: null };
}

// ────────────────────────────── 统计 ──────────────────────────────
function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekStats() {
  const days = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const key = dayKeyOf(d.getTime());
    const recs = state.history.filter((r) => r.kind === 'focus' && dayKeyOf(r.at) === key);
    days.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      dow: '日一二三四五六'[d.getDay()],
      minutes: recs.reduce((a, b) => a + (Number(b.minutes) || 0), 0),
      count: recs.length,
    });
  }
  return days;
}

// ────────────────────────────── 工具 ──────────────────────────────
function stickerPath(who, emote) {
  return path.join(STICKERS, who, `${emote}.png`);
}

function workAreaFor(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x, y }).workArea;
  } catch (_) {
    return screen.getPrimaryDisplay().workArea;
  }
}

function clampBallPos(pos) {
  const wa = workAreaFor(pos.x, pos.y);
  return {
    x: Math.round(Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - BALL_SIZE)),
    y: Math.round(Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - BALL_SIZE)),
  };
}

function initialBallPos() {
  if (state.ballPos && Number.isFinite(state.ballPos.x) && Number.isFinite(state.ballPos.y)) {
    return clampBallPos(state.ballPos);
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - BALL_SIZE - 64, y: wa.y + wa.height - BALL_SIZE - 120 };
}

function applyAlwaysOnTop() {
  for (const win of [ballWin, panelWin]) {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(state.alwaysOnTop, state.alwaysOnTop ? 'screen-saver' : 'normal');
    }
  }
}

// 便携版是自解压包：每次运行先解压到 %TEMP%\<固定 hash>\ 再启动，退出即删。
// 指向那里的自启项在下次开机时必然落空，所以直接不允许开启。
function isPortableRun() {
  try {
    const tmp = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
    return path.resolve(process.execPath).toLowerCase().startsWith(tmp);
  } catch (_) {
    return false;
  }
}

// 自启项的 path/args 必须读写一致，否则 getLoginItemSettings 匹配不到自己写的项
function autoStartOptions() {
  return { path: process.execPath, args: app.isPackaged ? [] : [ROOT] };
}

function systemAutoStartOn() {
  try { return !!app.getLoginItemSettings(autoStartOptions()).openAtLogin; } catch (_) { return false; }
}

function setAutoStart(on) {
  const want = !!on;
  if (want && isPortableRun()) {
    return { ok: false, reason: 'portable', autoStart: false };
  }
  state.autoStart = want;
  saveState();
  try {
    // 打包版 exe 本身就是应用；开发模式在 electron.exe 后要跟上项目目录才能跑起来
    app.setLoginItemSettings({ openAtLogin: want, ...autoStartOptions() });
  } catch (err) {
    console.error('[A-SOUL] autostart failed:', err.message);
    return { ok: false, reason: 'error', error: err.message, autoStart: state.autoStart };
  }
  rebuildTray();
  broadcast('state:changed', state);
  return { ok: true, autoStart: state.autoStart };
}

// ────────────────────────────── 悬浮球窗口 ──────────────────────────────
function createBall() {
  const pos = initialBallPos();
  ballWin = new BrowserWindow({
    width: BALL_SIZE, height: BALL_SIZE, x: pos.x, y: pos.y,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    fullscreenable: false, focusable: true, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false, contextIsolation: true,
      // Electron 20+ 默认沙箱化 renderer，沙箱 preload 里 require('path') 不可用。
      // 本地应用无不可信内容，关掉沙箱让 preload 拿到完整 Node 内置模块。
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  ballWin.setAlwaysOnTop(state.alwaysOnTop, state.alwaysOnTop ? 'screen-saver' : 'normal');
  ballWin.loadFile(path.join(ROOT, 'src', 'ball.html'));
  ballWin.once('ready-to-show', () => { if (ballWin && !ballWin.isDestroyed()) ballWin.showInactive(); });
  ballWin.on('moved', () => {
    if (!ballWin || ballWin.isDestroyed()) return;
    const b = ballWin.getBounds();
    state.ballPos = { x: b.x, y: b.y };
    saveState();
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) positionPanel();
  });
  ballWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); ballWin.hide(); }
  });
  return ballWin;
}

// ────────────────────────────── 功能面板窗口 ──────────────────────────────
function positionPanel() {
  if (!ballWin || ballWin.isDestroyed() || !panelWin || panelWin.isDestroyed()) return;
  const b = ballWin.getBounds();
  const wa = workAreaFor(b.x, b.y);
  let x = b.x + b.width + 12;
  if (x + PANEL_W > wa.x + wa.width) x = b.x - PANEL_W - 12;
  if (x < wa.x) x = Math.max(wa.x + 8, wa.x + wa.width - PANEL_W - 8);
  let y = b.y - 24;
  if (y + PANEL_H > wa.y + wa.height) y = wa.y + wa.height - PANEL_H - 8;
  if (y < wa.y) y = wa.y + 8;
  panelWin.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL_W, height: PANEL_H });
}

function createPanel(showImmediately = false) {
  panelWin = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, show: false,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, minimizable: false, maximizable: false,
    skipTaskbar: false, hasShadow: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      nodeIntegration: false, contextIsolation: true,
      // Electron 20+ 默认沙箱化 renderer，沙箱 preload 里 require('path') 不可用。
      // 本地应用无不可信内容，关掉沙箱让 preload 拿到完整 Node 内置模块。
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  panelWin.setAlwaysOnTop(state.alwaysOnTop, state.alwaysOnTop ? 'screen-saver' : 'normal');
  panelWin.loadFile(path.join(ROOT, 'src', 'panel.html'));
  panelWin.once('ready-to-show', () => {
    positionPanel();
    if (showImmediately) { panelWin.show(); panelWin.focus(); }
  });
  panelWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); panelWin.hide(); }
  });
  return panelWin;
}

function openPanel(tab) {
  if (tab) desiredTab = tab;
  if (!panelWin || panelWin.isDestroyed()) {
    createPanel(true);
  } else {
    positionPanel();
    if (panelWin.isMinimized()) panelWin.restore();
    panelWin.showInactive();
    if (panelWin.webContents.isLoading()) {
      panelWin.webContents.once('did-finish-load', () => {
        if (!panelWin || panelWin.isDestroyed()) return;
        positionPanel();
        panelWin.webContents.send('panel:tab', desiredTab);
      });
    } else {
      panelWin.webContents.send('panel:tab', desiredTab);
    }
  }
  return !!panelWin;
}

// ────────────────────────────── 托盘 ──────────────────────────────
function trayIcon() {
  const p = stickerPath(state.character, 'idle');
  try {
    return nativeImage.createFromPath(p).resize({ width: 20, height: 20 });
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

function rebuildTray() {
  if (!tray || tray.isDestroyed()) return;
  const charMenu = Object.entries(CHARACTERS).map(([key, info]) => ({
    label: info.name,
    type: 'radio',
    checked: state.character === key,
    click: () => setCharacter(key),
  }));
  const menu = Menu.buildFromTemplate([
    { label: 'A-SOUL 悬浮球', enabled: false },
    { type: 'separator' },
    { label: '打开面板', click: () => openPanel() },
    { label: '专注统计', click: () => openPanel('stats') },
    { label: '设置…', click: () => openPanel('settings') },
    { label: '番茄钟', submenu: [
      { label: '开始 / 继续', click: startTimer },
      { label: '暂停', click: pauseTimer },
      { label: '重置', click: resetTimer },
    ] },
    { type: 'separator' },
    { label: '切换角色', submenu: charMenu },
    { label: '始终置顶', type: 'checkbox', checked: state.alwaysOnTop, click: (item) => {
      state.alwaysOnTop = item.checked; saveState(); applyAlwaysOnTop(); broadcast('state:changed', state);
    } },
    { label: state.ballVisible === false ? '显示悬浮球' : '隐藏悬浮球', click: () => {
      if (!ballWin || ballWin.isDestroyed()) return;
      if (ballWin.isVisible()) { ballWin.hide(); state.ballVisible = false; }
      else { ballWin.showInactive(); state.ballVisible = true; }
      saveState(); rebuildTray();
    } },
    { label: '开机自启', type: 'checkbox', checked: state.autoStart, click: (item) => setAutoStart(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('A-SOUL 悬浮球 · 番茄钟 / 便签 / 最近访问');
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    rebuildTray();
    tray.on('click', () => openPanel());
    tray.on('double-click', () => openPanel());
  } catch (err) {
    console.error('[A-SOUL] tray failed:', err.message);
  }
}

function setCharacter(who) {
  if (!CHARACTERS[who]) return;
  state.character = who;
  saveState();
  if (tray && !tray.isDestroyed()) tray.setImage(trayIcon());
  rebuildTray();
  broadcast('state:changed', state);
  broadcast('ball:emote', { emote: 'hey', hold: 1800 });
}

function ballContextMenu() {
  const charMenu = Object.entries(CHARACTERS).map(([key, info]) => ({
    label: info.name, type: 'radio', checked: state.character === key,
    click: () => setCharacter(key),
  }));
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => openPanel() },
    { label: '便签', click: () => openPanel('notes') },
    { label: '最近访问', click: () => openPanel('recent') },
    { label: '专注统计', click: () => openPanel('stats') },
    { label: '设置…', click: () => openPanel('settings') },
    { type: 'separator' },
    { label: timer.running ? '暂停番茄钟' : '开始番茄钟', click: () => timer.running ? pauseTimer() : startTimer() },
    { label: '切换角色', submenu: charMenu },
    { type: 'separator' },
    { label: '隐藏悬浮球（托盘可恢复）', click: () => { if (ballWin) { ballWin.hide(); state.ballVisible = false; saveState(); rebuildTray(); } } },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  menu.popup({ window: ballWin });
}

// ────────────────────────────── IPC ──────────────────────────────
function registerIPC() {
  ipcMain.handle('app:bootstrap', () => ({
    state, timer: timerSnapshot(), characters: CHARACTERS, emotes: EMOTES,
    ballSize: BALL_SIZE, stickersRoot: 'assets/stickers',
    env: { portable: isPortableRun(), exePath: process.execPath },
  }));

  ipcMain.handle('state:patch', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return state;
    for (const key of ['pomodoro', 'stats']) {
      if (patch[key]) state[key] = { ...state[key], ...patch[key] };
    }
    for (const key of ['character', 'alwaysOnTop', 'recentLimit', 'autoStart', 'ballVisible']) {
      if (patch[key] !== undefined) state[key] = patch[key];
    }
    if (patch.notes !== undefined && Array.isArray(patch.notes)) state.notes = patch.notes;
    if (patch.pomodoro) {
      // 改时长不打断当前计时：保留已过时间，按新总时长重算剩余
      const elapsed = timer.total - timer.remaining;
      const nextTotal = durationOf(timer.mode);
      timer.total = nextTotal;
      timer.remaining = timer.running ? Math.max(1, nextTotal - elapsed) : nextTotal;
      if (timer.running) timer.endsAt = Date.now() + timer.remaining * 1000;
      emitTimer();
    }
    saveState();
    broadcast('state:changed', state);
    return state;
  });

  ipcMain.handle('character:set', (_e, who) => { setCharacter(who); return state.character; });

  ipcMain.handle('ball:drag-start', () => {
    if (!ballWin || ballWin.isDestroyed()) return null;
    const b = ballWin.getBounds();
    dragOrigin = { x: b.x, y: b.y };
    return dragOrigin;
  });
  ipcMain.on('ball:drag-move', (_e, d) => {
    if (!dragOrigin || !ballWin || ballWin.isDestroyed() || !d) return;
    const pos = clampBallPos({ x: dragOrigin.x + d.dx, y: dragOrigin.y + d.dy });
    ballWin.setPosition(pos.x, pos.y);
  });
  ipcMain.handle('ball:drag-end', () => {
    dragOrigin = null;
    if (ballWin && !ballWin.isDestroyed()) {
      const b = ballWin.getBounds();
      state.ballPos = { x: b.x, y: b.y };
      saveState();
      positionPanel();
    }
  });

  ipcMain.handle('ball:click', () => { openPanel(); });
  ipcMain.handle('ball:context', () => { ballContextMenu(); });
  ipcMain.handle('ball:toggle-timer', () => { timer.running ? pauseTimer() : startTimer(); return timerSnapshot(); });

  ipcMain.handle('panel:open', (_e, tab) => openPanel(tab));
  ipcMain.handle('panel:close', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.hide(); });
  ipcMain.handle('panel:ready', () => ({ tab: desiredTab, timer: timerSnapshot(), state }));

  ipcMain.handle('timer:action', (_e, action, payload) => {
    switch (action) {
      case 'start': startTimer(); break;
      case 'pause': pauseTimer(); break;
      case 'toggle': timer.running ? pauseTimer() : startTimer(); break;
      case 'reset': resetTimer(); break;
      case 'mode': setMode(payload); break;
      default: break;
    }
    return timerSnapshot();
  });

  // 表盘拖动：改的是「本次计时」，不是配置
  // 自定义标签的分钟数属于模板，拖动不得回写，否则设置里配好的时长会被悄悄改掉
  ipcMain.handle('timer:set-duration', (_e, minutes) => {
    const m = clampInt(minutes, 1, 180, 25);
    const isPreset = !!presetOf(timer.mode);
    if (!isPreset && (timer.mode === 'focus' || timer.mode === 'short' || timer.mode === 'long')) {
      state.pomodoro[timer.mode] = m;
    }
    timer.total = m * 60;
    timer.remaining = m * 60;
    timer.running = false;
    timer.endsAt = 0;
    if (!isPreset) {
      saveState();
      broadcast('state:changed', state);
    }
    emitTimer();
    return timerSnapshot();
  });

  ipcMain.handle('presets:save', (_e, list) => {
    if (!Array.isArray(list)) return state.presets;
    const seen = new Set();
    state.presets = list.map(sanitizePreset).filter((p) => {
      if (!p || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    }).slice(0, 12);
    if (String(timer.mode).startsWith('preset:') && !presetOf(timer.mode)) {
      setMode('focus');
    } else if (presetOf(timer.mode) && !timer.running) {
      timer.total = durationOf(timer.mode);
      timer.remaining = timer.total;
    }
    saveState();
    broadcast('state:changed', state);
    emitTimer();
    return state.presets;
  });

  ipcMain.handle('stats:get', () => {
    rollDay();
    return {
      stats: { ...state.stats },
      week: weekStats(),
      history: state.history.slice(-60).reverse(),
    };
  });

  ipcMain.handle('notes:save', (_e, notes) => {
    if (!Array.isArray(notes)) return state.notes;
    state.notes = notes.slice(0, 200);
    saveState();
    return state.notes;
  });

  ipcMain.handle('recent:list', () => listRecent());
  ipcMain.handle('recent:open-folder', async () => {
    const err = await shell.openPath(recentDir());
    return err || '';
  });
  ipcMain.handle('file:open', async (_e, p) => {
    if (typeof p !== 'string') return 'invalid path';
    let err = await shell.openPath(p);
    // 个别环境 openPath 不接受目录，退回「在资源管理器中显示」
    if (err) {
      try {
        if (fs.statSync(p).isDirectory()) { shell.showItemInFolder(p); err = ''; }
      } catch (_) { /* 保持原错误 */ }
    }
    return err || '';
  });
  ipcMain.handle('file:reveal', (_e, p) => {
    if (typeof p !== 'string') return;
    // 文件夹本身「显示所在位置」= 打开它的父目录
    try {
      if (fs.statSync(p).isDirectory()) { shell.openPath(path.dirname(p)); return; }
    } catch (_) { /* 交给 showItemInFolder */ }
    shell.showItemInFolder(p);
  });

  ipcMain.handle('debug:status', () => ({
    ball: ballWin && !ballWin.isDestroyed() ? { ...ballWin.getBounds(), visible: ballWin.isVisible() } : null,
    panel: panelWin && !panelWin.isDestroyed()
      ? { ...panelWin.getBounds(), visible: panelWin.isVisible(), loading: panelWin.webContents.isLoading() }
      : null,
    desiredTab, timer: timerSnapshot(), character: state.character,
    recentDir: recentDir(),
  }));

  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('app:set-always-on-top', (_e, v) => {
    state.alwaysOnTop = !!v; saveState(); applyAlwaysOnTop(); rebuildTray(); broadcast('state:changed', state);
    return state.alwaysOnTop;
  });
  ipcMain.handle('app:set-auto-start', (_e, v) => setAutoStart(v));
  ipcMain.handle('app:auto-start-state', () => ({
    autoStart: state.autoStart, systemOn: systemAutoStartOn(), portable: isPortableRun(),
  }));
}

// ────────────────────────────── 启动 ──────────────────────────────
function main() {
  // Windows 通知需要 AppUserModelId，否则完成提醒可能被系统吞掉
  try { app.setAppUserModelId('com.ben.asoulball'); } catch (_) {}
  // 以系统实际注册项为准，避免 state 与真实状态不一致（比如手动清过注册表）
  try {
    const systemOn = systemAutoStartOn();
    if (systemOn !== state.autoStart) { state.autoStart = systemOn; saveState(); }
  } catch (_) {}
  setMode('focus', true);
  timer.remaining = timer.total;
  emitTimer();
  registerIPC();
  createBall();
  createTray();
  setInterval(tick, 500);
  // 面板预热，首次点击不闪白
  setTimeout(() => { if (!panelWin || panelWin.isDestroyed()) createPanel(false); }, 800);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ballWin && !ballWin.isDestroyed()) ballWin.showInactive();
    openPanel();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 托盘常驻，不随窗口关闭退出 */ });
  app.whenReady().then(main).catch((err) => console.error('[A-SOUL] boot failed:', err));
}
