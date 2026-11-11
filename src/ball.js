'use strict';
const api = window.asoul;
const RING_LEN = 2 * Math.PI * 56;
const MODE_LABEL = { focus: '专注', short: '短休', long: '长休' };
const CLICK_EMOTES = ['hey', 'wink', 'love', 'cheer', 'extra1', 'extra2', 'tomato'];

const elBall = document.getElementById('ball');
const elFace = document.getElementById('face');
const elRing = document.getElementById('ring-fg');
const elBadge = document.getElementById('badge');
const elBadgeMode = document.getElementById('badge-mode');
const elBadgeTime = document.getElementById('badge-time');
const elToast = document.getElementById('toast');
elFace.addEventListener('error', () => console.error('[A-SOUL] 表情加载失败:', elFace.src));

let state = null;
let timer = null;
let characters = null;
let override = null;
let overrideUntil = 0;
let toastTimer = null;

function fmt(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function currentEmote() {
  if (override && Date.now() < overrideUntil) return override;
  if (timer && timer.running) return timer.mode === 'focus' ? 'focus' : 'rest';
  return 'idle';
}

function setEmote(emote, hold = 1500) {
  override = emote;
  overrideUntil = Date.now() + hold;
  render();
}

function showToast(text, ms = 2600) {
  elToast.textContent = text;
  elToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.remove('show'), ms);
}

function render() {
  if (!state || !timer) return;
  const info = characters[state.character] || characters.diana;
  const root = document.documentElement;
  root.style.setProperty('--accent', info.color);
  root.style.setProperty('--soft', info.soft);
  root.style.setProperty('--glow', info.color + '66');

  const src = api.stickerUrl(state.character, currentEmote());
  if (elFace.getAttribute('src') !== src) elFace.src = src;

  const offset = RING_LEN * (1 - (timer.progress || 0));
  elRing.style.strokeDasharray = RING_LEN.toFixed(2);
  elRing.style.strokeDashoffset = offset.toFixed(2);
  elBall.classList.toggle('running', !!timer.running);

  const showBadge = timer.running || timer.remaining < timer.total;
  elBadge.classList.toggle('show', !!showBadge);
  elBadgeMode.textContent = timer.label || MODE_LABEL[timer.mode] || '专注';
  elBadgeTime.textContent = fmt(timer.remaining);
}

function beep(enabled) {
  if (!enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.16, 0.34].forEach((delay, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = [659.25, 880, 1046.5][i];
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.17);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch (_) { /* 音频设备不可用则静默 */ }
}

// 朗读自定义完成话语（系统 TTS，语音列表可能延迟加载）
let voiceCache = null;
function pickVoice() {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  if (!voiceCache) {
    const voices = synth.getVoices() || [];
    voiceCache = voices.find((v) => /zh[-_]CN/i.test(v.lang))
      || voices.find((v) => /^zh/i.test(v.lang))
      || voices.find((v) => /Huihui|Yaoyao|Xiaoxiao|Kangkang|Chinese/i.test(v.name))
      || null;
  }
  return voiceCache;
}
function speak(text) {
  try {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'zh-CN'; u.rate = 1.02; u.pitch = 1.06; u.volume = 1;
    const v = pickVoice();
    if (v) u.voice = v;
    synth.speak(u);
  } catch (err) {
    console.warn('[A-SOUL] 语音播放失败:', err && err.message);
  }
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { voiceCache = null; };
}

// ───────── 拖拽 / 点击 ─────────
let origin = null;
let startX = 0, startY = 0, moved = false;

elBall.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  startX = e.screenX; startY = e.screenY; moved = false;
  origin = await api.dragStart();
  try { elBall.setPointerCapture(e.pointerId); } catch (_) {}
});

elBall.addEventListener('pointermove', (e) => {
  if (!origin) return;
  const dx = e.screenX - startX, dy = e.screenY - startY;
  if (!moved && Math.hypot(dx, dy) > 4) { moved = true; elBall.classList.add('dragging'); }
  if (moved) api.dragMove(dx, dy);
});

async function endPointer(e) {
  if (!origin) return;
  origin = null;
  const wasMoved = moved;
  moved = false;
  elBall.classList.remove('dragging');
  try { elBall.releasePointerCapture(e.pointerId); } catch (_) {}
  if (wasMoved) {
    await api.dragEnd();
  } else {
    setEmote(CLICK_EMOTES[Math.floor(Math.random() * CLICK_EMOTES.length)], 1400);
    api.ballClick();
  }
}
elBall.addEventListener('pointerup', endPointer);
elBall.addEventListener('pointercancel', endPointer);

elBall.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.ballContext();
});

// ───────── 事件订阅 ─────────
api.on('state:changed', (s) => { state = s; render(); });
api.on('timer:tick', (t) => { timer = t; render(); });
api.on('ball:emote', ({ emote, hold }) => setEmote(emote, hold || 1600));
api.on('speak', ({ text }) => speak(text));
api.on('timer:done', (d) => {
  const name = (characters[state.character] || {}).name || 'A-SOUL';
  if (d.message) showToast(`${name}：${d.message}`, 4200);
  else showToast(d.fromKind === 'focus' ? `${name}：专注完成！休息一下 🍅` : `${name}：休息结束，继续加油！`, 3200);
  beep(d.sound && !d.message);
  setEmote(d.emote || 'done', 4500);
});
setInterval(render, 500); // 让临时表情到期后自动回到状态表情

(async () => {
  const boot = await api.bootstrap();
  state = boot.state;
  timer = boot.timer;
  characters = boot.characters;
  render();
})();
