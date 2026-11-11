'use strict';
const api = window.asoul;
const $ = (id) => document.getElementById(id);

const RING_R = 84;
const RING_LEN = 2 * Math.PI * RING_R;
const DIAL_MIN_ANGLE = 6;   // 1 分钟
const DIAL_MAX_ANGLE = 720; // 两圈 = 120 分钟
const MODE_LABEL = { focus: '专注', short: '短休', long: '长休' };
const NOTE_COLORS = [
  { bg: '#fff5fa', line: '#f6d8e6', dot: '#ff8fbb' },
  { bg: '#f1f7ff', line: '#d9e6ff', dot: '#6fa8ff' },
  { bg: '#f7f2ff', line: '#e4d6ff', dot: '#a982f5' },
  { bg: '#fff9ea', line: '#f5e6bf', dot: '#eabb58' },
  { bg: '#effaf4', line: '#d4efdf', dot: '#63bd8c' },
];
const EXT_COLORS = {
  folder: '#e6a94b', pdf: '#e2564f', doc: '#4d8dff', docx: '#4d8dff', xls: '#3fa96b', xlsx: '#3fa96b',
  ppt: '#e98442', pptx: '#e98442', zip: '#9b6df3', rar: '#9b6df3', '7z': '#9b6df3',
  png: '#ff6fa5', jpg: '#ff6fa5', jpeg: '#ff6fa5', gif: '#ff6fa5', webp: '#ff6fa5', svg: '#ff6fa5',
  mp4: '#7a6be8', mkv: '#7a6be8', mov: '#7a6be8', mp3: '#7a6be8', wav: '#7a6be8',
  exe: '#8b8296', msi: '#8b8296', js: '#3fb6b6', ts: '#3fb6b6', py: '#3fb6b6',
  json: '#3fb6b6', md: '#3fb6b6', txt: '#3fb6b6', html: '#3fb6b6',
};
const VIEWS = ['pomodoro', 'notes', 'recent', 'stats', 'settings'];
const MAIN_TABS = ['pomodoro', 'notes', 'recent'];

let state = null, timer = null, characters = null, emotes = [];
let currentView = 'pomodoro';
let notes = [], recentItems = [], recentFilter = 'all';
let noteSaveTimer = null, toastTimer = null;
let editingPreset = null, peKind = 'focus', peEmote = 'done';
let envInfo = null;   // { portable, exePath }
const dial = { dragging: false, angle: 0, last: 0 };

// ───────── 通用 ─────────
function fmt(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function relTime(ms) {
  const d = new Date(ms), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtSize(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ───────── 主题 / 角色 ─────────
function buildChars() {
  const box = $('chars');
  box.textContent = '';
  Object.entries(characters).forEach(([key, info]) => {
    const btn = document.createElement('button');
    btn.className = 'char-avatar'; btn.title = `切换到 ${info.name}`; btn.dataset.key = key;
    const img = document.createElement('img');
    img.src = api.stickerUrl(key, 'idle'); img.alt = info.name;
    btn.appendChild(img);
    btn.addEventListener('click', () => api.setCharacter(key));
    box.appendChild(btn);
  });
}

function syncTheme() {
  if (!state || !characters) return;
  const info = characters[state.character] || characters.diana;
  document.documentElement.style.setProperty('--accent', info.color);
  document.documentElement.style.setProperty('--soft', info.soft);
  $('footer-char').textContent = `当前伙伴：${info.name}`;
  for (const el of document.querySelectorAll('.char-avatar')) {
    el.classList.toggle('active', el.dataset.key === state.character);
  }
  $('notes-empty-img').src = api.stickerUrl(state.character, 'hey');
}

// ───────── 表盘 ─────────
function buildTicks() {
  const g = $('dial-ticks');
  g.textContent = '';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '100');
    line.setAttribute('y1', major ? '2' : '4');
    line.setAttribute('x2', '100');
    line.setAttribute('y2', major ? '9' : '8');
    line.setAttribute('transform', `rotate(${i * 6} 100 100)`);
    if (major) line.setAttribute('class', 'major');
    g.appendChild(line);
  }
}

function ringFrac(angle) {
  let f = (angle % 360) / 360;
  if (angle > 0 && f === 0) f = 1;
  return f;
}

function renderDialVisual() {
  if (!timer) return;
  const fill = $('dial-fill'), knob = $('dial-knob');
  const idle = !timer.running && timer.remaining >= timer.total;
  let angle, frac;
  if (dial.dragging) {
    angle = dial.angle;
    frac = ringFrac(angle);
  } else if (idle) {
    angle = (timer.total / 60) * 6;
    frac = ringFrac(angle);
  } else {
    frac = timer.progress || 0;
    angle = frac * 360;
  }
  fill.style.strokeDasharray = RING_LEN.toFixed(2);
  fill.style.strokeDashoffset = (RING_LEN * (1 - frac)).toFixed(2);
  knob.style.display = (idle || dial.dragging) ? '' : 'none';
  const rad = (angle * Math.PI) / 180;
  knob.setAttribute('cx', (100 + RING_R * Math.sin(rad)).toFixed(2));
  knob.setAttribute('cy', (100 - RING_R * Math.cos(rad)).toFixed(2));
}

function pointerAngle(e) {
  const r = $('dial').getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const a = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
  return (a + 360) % 360;
}

function updateDialPreview() {
  const minutes = Math.max(1, Math.round(dial.angle / 6));
  $('hero-time').textContent = fmt(minutes * 60);
  $('hero-hint').textContent = `松手设为 ${minutes} 分钟`;
  const lap = Math.floor(dial.angle / 360) + 1;
  $('dial-lap').textContent = dial.angle > 360 ? `第 ${lap} 圈` : '';
  $('dial-lap').classList.toggle('show', dial.angle > 360);
  renderDialVisual();
}

function bindDial() {
  const el = $('dial');
  el.addEventListener('pointerdown', async (e) => {
    if (!timer || e.button !== 0) return;
    if (timer.running) { toast('专注中不能调时长，先按「重置」'); return; }
    dial.dragging = true;
    dial.angle = Math.max(DIAL_MIN_ANGLE, Math.round((timer.total / 60) * 6));
    dial.last = pointerAngle(e);
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    updateDialPreview();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dial.dragging) return;
    const a = pointerAngle(e);
    let d = a - dial.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    dial.last = a;
    dial.angle = Math.min(DIAL_MAX_ANGLE, Math.max(DIAL_MIN_ANGLE, dial.angle + d));
    updateDialPreview();
  });
  const end = async (e) => {
    if (!dial.dragging) return;
    dial.dragging = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    const minutes = Math.max(1, Math.round(dial.angle / 6));
    const snap = await api.setDuration(minutes);
    if (snap) timer = snap;
    renderTimer();
    const isPreset = !!(snap && String(snap.mode || '').startsWith('preset:'));
    toast(isPreset ? `本次 ${minutes} 分钟 · 不改动标签设置` : `已设为 ${minutes} 分钟`);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ───────── 番茄钟 ─────────
function renderTimer() {
  if (!timer) return;
  const label = timer.label || MODE_LABEL[timer.mode] || '专注';
  const name = (characters[state.character] || {}).name || 'A-SOUL';
  const dirty = timer.remaining < timer.total;
  $('hero-time').textContent = fmt(timer.remaining);
  $('hero-mode').textContent = label;
  if (!dial.dragging) {
    $('hero-hint').textContent = timer.running
      ? `${name} 陪你一起${timer.kind === 'focus' ? '专注' : '休息'}中…`
      : (dirty ? '已暂停，随时继续' : '拖动表盘设置时长');
  }
  $('btn-start').textContent = timer.running ? '暂停' : (timer.kind === 'focus' ? '开始专注' : '开始休息');
  const backFocus = $('btn-back-focus');
  if (backFocus) backFocus.hidden = !(timer.kind !== 'focus' && !timer.running);
  if (!dial.dragging) {
    $('dial-lap').classList.remove('show');
    $('dial-lap').textContent = '';
  }
  renderDialVisual();
  renderPresetRow();
  const today = timer.today || {};
  $('stat-today').textContent = today.completed || 0;
  $('stat-min').textContent = today.focusMinutes || 0;
}

function renderPresetRow() {
  if (!timer || !state) return;
  const row = $('preset-row');
  row.textContent = '';
  // 只渲染用户自定义标签；内置的专注/短休/长休不再占按钮位
  const items = (state.presets || []).map((p) => ({
    mode: `preset:${p.id}`, label: p.label, minutes: p.minutes, kind: p.kind,
  }));
  row.hidden = items.length === 0;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'preset' + (timer.mode === it.mode ? ' active' : '');
    b.title = `${it.label} · ${it.minutes} 分钟${it.kind === 'break' ? '（休息）' : '（专注）'}`;
    const dot = document.createElement('i');
    dot.style.background = it.kind === 'break' ? '#63bd8c' : 'var(--accent)';
    b.appendChild(dot);
    const span = document.createElement('span');
    span.className = 'pl';
    span.textContent = it.label;
    b.appendChild(span);
    b.addEventListener('click', async () => {
      const snap = await api.timerAction('mode', it.mode);
      if (snap) timer = snap;
      renderTimer();
    });
    row.appendChild(b);
  }
}

// ───────── 便签 ─────────
function saveNotesSoon() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => api.saveNotes(notes), 400);
}

function sortedNotes() {
  return notes.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
}

function renderNotes() {
  const list = $('notes-list');
  list.textContent = '';
  $('notes-count').textContent = `${notes.length} 条便签`;
  $('notes-empty').classList.toggle('show', notes.length === 0);

  for (const note of sortedNotes()) {
    const card = document.createElement('div');
    card.className = 'note' + (note.pinned ? ' pinned' : '');
    const c = NOTE_COLORS[note.color] || NOTE_COLORS[0];
    card.style.setProperty('--note-bg', c.bg);
    card.style.setProperty('--note-line', c.line);
    card.style.setProperty('--note-accent', c.dot);

    const head = document.createElement('div');
    head.className = 'note-head';
    const dot = document.createElement('span'); dot.className = 'note-dot';
    const date = document.createElement('span'); date.className = 'note-date';
    date.textContent = relTime(note.updatedAt || note.createdAt || Date.now());
    const pin = document.createElement('button'); pin.className = 'note-act';
    pin.title = note.pinned ? '取消置顶' : '置顶'; pin.textContent = note.pinned ? '★' : '☆';
    pin.addEventListener('click', () => { note.pinned = !note.pinned; note.updatedAt = Date.now(); saveNotesSoon(); renderNotes(); });
    const del = document.createElement('button'); del.className = 'note-act';
    del.title = '删除'; del.textContent = '×';
    del.addEventListener('click', () => {
      notes = notes.filter((n) => n.id !== note.id);
      saveNotesSoon(); renderNotes(); toast('便签已删除');
    });
    head.append(dot, date, pin, del);

    const ta = document.createElement('textarea');
    ta.placeholder = '写点什么…';
    ta.value = note.text || '';
    ta.addEventListener('input', () => {
      note.text = ta.value;
      note.updatedAt = Date.now();
      date.textContent = '编辑中…';
      saveNotesSoon();
    });

    const colors = document.createElement('div');
    colors.className = 'color-row';
    NOTE_COLORS.forEach((cc, i) => {
      const i2 = document.createElement('i');
      i2.style.background = cc.dot;
      i2.className = (note.color === i || (!note.color && i === 0)) ? 'on' : '';
      i2.title = '换个颜色';
      i2.addEventListener('click', () => { note.color = i; note.updatedAt = Date.now(); saveNotesSoon(); renderNotes(); });
      colors.appendChild(i2);
    });

    card.append(head, ta, colors);
    list.appendChild(card);
  }
}

function addNote() {
  const now = Date.now();
  notes.push({ id: `n-${now}-${Math.random().toString(36).slice(2, 7)}`, text: '', color: 0, pinned: false, createdAt: now, updatedAt: now });
  saveNotesSoon();
  renderNotes();
  const first = $('notes-list').querySelector('textarea');
  if (first) first.focus();
}

// ───────── 最近访问的文件 / 打开的文件夹 ─────────
function shortParent(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : p;
}

async function refreshRecent() {
  const res = await api.listRecent();
  if (!res) return;
  recentItems = res.items || [];
  const nFile = recentItems.filter((i) => !i.isDir).length;
  const nDir = recentItems.length - nFile;
  const stat = $('recent-stat');
  stat.title = res.dir || '';
  stat.textContent = res.error
    ? `读取失败：${res.error}`
    : `${recentItems.length} 项 · ${nFile} 个文件 / ${nDir} 个文件夹`;
  if (res.error) toast(`最近项目读取失败：${res.error}`);
  renderFiles();
}

function renderFiles() {
  const list = $('file-list');
  list.textContent = '';
  const shown = recentItems.filter((f) =>
    recentFilter === 'all' || (recentFilter === 'folder' ? f.isDir : !f.isDir));
  $('files-empty').classList.toggle('show', shown.length === 0);
  $('filter-count').textContent = `显示 ${shown.length} 项`;

  for (const f of shown) {
    const row = document.createElement('div');
    row.className = 'file';
    row.title = f.path;

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.style.setProperty('--fc', f.isDir ? '#e6a94b' : (EXT_COLORS[f.ext] || '#9a8fa6'));
    icon.textContent = f.isDir ? 'DIR' : (f.ext.length > 4 ? f.ext.slice(0, 4) : f.ext);

    const main = document.createElement('div');
    main.className = 'file-main';
    const name = document.createElement('div');
    name.className = 'file-name'; name.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.title = f.parent || '';
    meta.textContent = `${shortParent(f.parent)}  ·  ${relTime(f.mtime)}${f.isDir ? '' : '  ·  ' + fmtSize(f.size)}`;
    main.append(name, meta);

    const reveal = document.createElement('button');
    reveal.className = 'icon-btn file-reveal';
    reveal.title = f.isDir ? '打开上级目录' : '打开所在文件夹';
    reveal.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/><path d="M12 13v4M10 15l2-2 2 2"/></svg>';
    reveal.addEventListener('click', (e) => { e.stopPropagation(); api.revealPath(f.path); });

    row.addEventListener('click', async () => {
      const err = await api.openPath(f.path);
      if (err) toast(`打开失败：${err}`);
    });
    row.append(icon, main, reveal);
    list.appendChild(row);
  }
}

// ───────── 专注统计 ─────────
async function refreshStats() {
  const data = await api.getStats();
  if (!data) return;
  const s = data.stats || {};
  $('sc-today').textContent = s.completed || 0;
  $('sc-min').textContent = s.focusMinutes || 0;
  $('sc-total').textContent = s.totalCompleted || 0;
  $('sc-totalmin').textContent = s.totalMinutes || 0;

  const week = data.week || [];
  const max = Math.max(30, ...week.map((d) => d.minutes || 0));
  const total = week.reduce((a, d) => a + (d.minutes || 0), 0);
  const chart = $('week-chart');
  chart.textContent = '';
  week.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'week-col';
    col.title = `${d.label} · ${d.count} 个 · ${d.minutes} 分钟`;
    const val = document.createElement('span');
    val.className = 'week-val';
    val.textContent = d.minutes ? d.minutes : '';
    const bar = document.createElement('div');
    bar.className = 'week-bar' + (d.minutes ? '' : ' zero');
    bar.style.height = `${d.minutes ? Math.max(8, Math.round((d.minutes / max) * 62)) : 10}px`;
    const dow = document.createElement('span');
    dow.className = 'week-dow' + (i === week.length - 1 ? ' today' : '');
    dow.textContent = d.dow;
    col.append(val, bar, dow);
    chart.appendChild(col);
  });
  if (!total) {
    const hint = document.createElement('div');
    hint.className = 'week-empty';
    hint.textContent = '最近 7 天还没有专注记录';
    chart.appendChild(hint);
  }

  const hist = data.history || [];
  const list = $('hist-list');
  list.textContent = '';
  $('hist-empty').classList.toggle('show', hist.length === 0);
  $('hist-count').textContent = hist.length ? `最近 ${hist.length} 条` : '';
  for (const h of hist) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const img = document.createElement('img');
    img.src = api.stickerUrl(state.character, h.emote || 'done');
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'hist-main';
    const label = document.createElement('div');
    label.className = 'hist-label';
    label.textContent = h.label || (h.kind === 'focus' ? '专注' : '休息');
    const meta = document.createElement('div');
    meta.className = 'hist-meta';
    meta.textContent = `${relTime(h.at)} · ${h.kind === 'focus' ? '专注' : '休息'}`;
    main.append(label, meta);
    const min = document.createElement('span');
    min.className = 'hist-min';
    min.textContent = `${h.minutes || 0} 分钟`;
    row.append(img, main, min);
    list.appendChild(row);
  }
}

// ───────── 设置 ─────────
function syncAutoStart() {
  const box = $('opt-autostart');
  if (!box) return;
  const portable = !!(envInfo && envInfo.portable);
  box.disabled = portable;
  box.checked = portable ? false : !!(state && state.autoStart);
  $('autostart-row').classList.toggle('off', portable);
  const hint = $('autostart-hint');
  hint.textContent = portable
    ? '便携版每次从临时目录启动，系统里留不住自启项。换成安装版就能用。'
    : '登录 Windows 后自动在桌面显示悬浮球。';
  hint.classList.toggle('warn', portable);
}

function syncSettings() {
  if (!state) return;
  const p = state.pomodoro;
  $('opt-auto').checked = !!p.autoNext;
  $('opt-sound').checked = p.sound !== false;
  $('opt-top').checked = !!state.alwaysOnTop;
  syncAutoStart();
}

function renderPresetList() {
  if (!state) return;
  const box = $('preset-list');
  box.textContent = '';
  const list = state.presets || [];
  $('preset-count').textContent = `${list.length} 个`;
  $('preset-empty').classList.toggle('show', list.length === 0);

  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'preset-item';
    const img = document.createElement('img');
    img.src = api.stickerUrl(state.character, p.emote || 'done');
    img.alt = '';
    const main = document.createElement('div');
    main.className = 'pi-main';
    const name = document.createElement('div');
    name.className = 'pi-name';
    name.textContent = p.label;
    const meta = document.createElement('div');
    meta.className = 'pi-meta';
    meta.textContent = `${p.minutes} 分钟 · ${p.kind === 'break' ? '休息' : '专注'}${p.message ? ` · “${p.message}”` : ''}`;
    main.append(name, meta);
    const edit = document.createElement('button');
    edit.className = 'pi-act'; edit.title = '编辑'; edit.textContent = '✎';
    edit.addEventListener('click', () => openEditor(p));
    const del = document.createElement('button');
    del.className = 'pi-act'; del.title = '删除'; del.textContent = '×';
    del.addEventListener('click', async () => {
      const saved = await api.savePresets(list.filter((x) => x.id !== p.id));
      if (saved) state.presets = saved;
      renderPresetList(); renderPresetRow();
      toast('标签已删除');
    });
    row.append(img, main, edit, del);
    box.appendChild(row);
  }
}

function renderEmoteGrid(selected) {
  const grid = $('pe-emotes');
  grid.textContent = '';
  peEmote = selected || 'done';
  for (const key of emotes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = key === peEmote ? 'active' : '';
    b.title = key;
    const img = document.createElement('img');
    img.src = api.stickerUrl(state.character, key);
    img.alt = key;
    b.appendChild(img);
    b.addEventListener('click', () => {
      peEmote = key;
      for (const el of grid.querySelectorAll('button')) el.classList.toggle('active', el === b);
    });
    grid.appendChild(b);
  }
}

function syncKindButtons() {
  for (const el of document.querySelectorAll('#pe-kind button')) {
    el.classList.toggle('active', el.dataset.kind === peKind);
  }
}

function openEditor(preset) {
  editingPreset = preset ? { ...preset } : null;
  peKind = preset ? preset.kind : 'focus';
  $('pe-title').textContent = preset ? '编辑标签' : '新标签';
  $('pe-label').value = preset ? preset.label : '';
  $('pe-minutes').value = preset ? preset.minutes : 25;
  $('pe-message').value = preset ? preset.message : '';
  $('pe-delete').hidden = !preset;
  syncKindButtons();
  renderEmoteGrid(preset ? preset.emote : 'done');
  $('preset-editor').hidden = false;
  setTimeout(() => $('pe-label').focus(), 30);
}

function closeEditor() {
  $('preset-editor').hidden = true;
  editingPreset = null;
}

async function saveEditor() {
  const label = $('pe-label').value.trim();
  if (!label) { toast('先给标签起个名字'); return; }
  const minutes = clampInt($('pe-minutes').value, 1, 180, 25);
  const message = $('pe-message').value.trim();
  const list = (state.presets || []).slice();
  if (editingPreset) {
    const i = list.findIndex((p) => p.id === editingPreset.id);
    if (i >= 0) list[i] = { ...list[i], label, minutes, kind: peKind, message, emote: peEmote };
  } else {
    if (list.length >= 12) { toast('最多 12 个标签'); return; }
    list.push({
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      label, minutes, kind: peKind, message, emote: peEmote,
    });
  }
  const saved = await api.savePresets(list);
  if (saved) state.presets = saved;
  const wasEditing = !!editingPreset;
  closeEditor();
  renderPresetList();
  renderPresetRow();
  toast(wasEditing ? '标签已更新' : '标签已添加');
}

// ───────── 视图切换 ─────────
function switchView(view) {
  if (!VIEWS.includes(view)) view = 'pomodoro';
  currentView = view;
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('active', MAIN_TABS.includes(view) && el.dataset.tab === view);
  }
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('active', el.id === `view-${view}`);
  if (view === 'recent') refreshRecent();
  if (view === 'notes') renderNotes();
  if (view === 'stats') refreshStats();
  if (view === 'settings') { syncSettings(); renderPresetList(); }
  if (view === 'pomodoro') renderTimer();
}

// ───────── 事件绑定 ─────────
function bind() {
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchView(btn.dataset.tab);
  });
  $('btn-close').addEventListener('click', () => api.closePanel());
  $('btn-settings').addEventListener('click', () => switchView('settings'));
  $('btn-settings-back').addEventListener('click', () => switchView('pomodoro'));
  $('btn-stats').addEventListener('click', () => switchView('stats'));
  $('btn-stats-back').addEventListener('click', () => switchView('pomodoro'));

  $('btn-start').addEventListener('click', async () => {
    const snap = await api.timerAction('toggle');
    if (snap) timer = snap;
    renderTimer();
  });
  $('btn-reset').addEventListener('click', async () => {
    const snap = await api.timerAction('reset');
    if (snap) timer = snap;
    renderTimer();
  });
  $('btn-back-focus').addEventListener('click', async () => {
    const snap = await api.timerAction('mode', 'focus');
    if (snap) timer = snap;
    renderTimer();
  });

  $('opt-auto').addEventListener('change', (e) => api.patchState({ pomodoro: { autoNext: e.target.checked } }));
  $('opt-sound').addEventListener('change', (e) => api.patchState({ pomodoro: { sound: e.target.checked } }));
  $('opt-top').addEventListener('change', (e) => api.setAlwaysOnTop(e.target.checked));
  $('opt-autostart').addEventListener('change', async (e) => {
    const r = await api.setAutoStart(e.target.checked);
    if (!r || r.ok === false) {
      e.target.checked = false;
      toast(r && r.reason === 'portable' ? '便携版不支持开机自启，请用安装版' : '开启开机自启失败');
      return;
    }
    toast(r.autoStart ? '已开启开机自启' : '已关闭开机自启');
  });

  // 标签编辑
  $('btn-add-preset').addEventListener('click', () => openEditor(null));
  $('pe-close').addEventListener('click', closeEditor);
  $('pe-cancel').addEventListener('click', closeEditor);
  $('pe-save').addEventListener('click', saveEditor);
  $('pe-delete').addEventListener('click', async () => {
    if (!editingPreset) return;
    const saved = await api.savePresets((state.presets || []).filter((p) => p.id !== editingPreset.id));
    if (saved) state.presets = saved;
    closeEditor();
    renderPresetList(); renderPresetRow();
    toast('标签已删除');
  });
  $('pe-kind').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    peKind = btn.dataset.kind;
    syncKindButtons();
  });
  $('preset-editor').addEventListener('click', (e) => {
    if (e.target === $('preset-editor')) closeEditor();
  });

  $('btn-new-note').addEventListener('click', addNote);
  $('btn-refresh').addEventListener('click', () => { refreshRecent(); toast('已刷新'); });
  $('btn-open-recent').addEventListener('click', () => api.openRecentFolder());
  $('filter-row').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    recentFilter = btn.dataset.filter;
    for (const el of document.querySelectorAll('#filter-row button')) el.classList.toggle('active', el === btn);
    renderFiles();
  });

  api.on('panel:tab', (tab) => switchView(tab));
  api.on('state:changed', (s) => {
    state = s;
    syncTheme();
    $('opt-top').checked = !!s.alwaysOnTop;
    renderPresetRow();
    if (currentView === 'settings') {
      $('opt-auto').checked = !!s.pomodoro.autoNext;
      $('opt-sound').checked = s.pomodoro.sound !== false;
      syncAutoStart();
      renderPresetList();
    }
  });
  api.on('timer:tick', (t) => {
    timer = t;
    if (currentView === 'pomodoro') renderTimer();
  });
  api.on('timer:done', (d) => {
    const msg = d.message ? `“${d.message}”` : (d.fromKind === 'focus' ? '🍅 专注完成，休息一下吧！' : '休息结束，继续加油！');
    toast(msg);
    if (currentView === 'pomodoro') renderTimer();
    if (currentView === 'stats') refreshStats();
  });
}

(async () => {
  const boot = await api.bootstrap();
  state = boot.state; timer = boot.timer; characters = boot.characters; emotes = boot.emotes || [];
  envInfo = boot.env || null;
  notes = Array.isArray(state.notes) ? state.notes.slice() : [];
  if (!Array.isArray(state.presets)) state.presets = [];
  buildChars();
  buildTicks();
  bindDial();
  syncTheme();
  syncSettings();
  renderTimer();
  renderNotes();
  bind();
  const ready = await api.panelReady();
  switchView((ready && ready.tab) || 'pomodoro');
})();
