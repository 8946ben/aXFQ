'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const CHANNELS = ['state:changed', 'timer:tick', 'timer:done', 'ball:emote', 'panel:tab', 'speak'];

contextBridge.exposeInMainWorld('asoul', {
  // 素材：返回 file:// 绝对 URL，避免相对路径在不同窗口里指错
  stickerUrl: (who, emote) => pathToFileURL(
    path.join(__dirname, 'assets', 'stickers', who, `${emote}.png`)
  ).href,

  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  panelReady: () => ipcRenderer.invoke('panel:ready'),
  patchState: (patch) => ipcRenderer.invoke('state:patch', patch),
  setCharacter: (who) => ipcRenderer.invoke('character:set', who),

  dragStart: () => ipcRenderer.invoke('ball:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('ball:drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.invoke('ball:drag-end'),
  ballClick: () => ipcRenderer.invoke('ball:click'),
  ballContext: () => ipcRenderer.invoke('ball:context'),
  toggleTimer: () => ipcRenderer.invoke('ball:toggle-timer'),

  openPanel: (tab) => ipcRenderer.invoke('panel:open', tab),
  closePanel: () => ipcRenderer.invoke('panel:close'),
  timerAction: (action, payload) => ipcRenderer.invoke('timer:action', action, payload),
  setDuration: (minutes) => ipcRenderer.invoke('timer:set-duration', minutes),
  savePresets: (list) => ipcRenderer.invoke('presets:save', list),
  getStats: () => ipcRenderer.invoke('stats:get'),

  saveNotes: (notes) => ipcRenderer.invoke('notes:save', notes),
  listRecent: () => ipcRenderer.invoke('recent:list'),
  openPath: (p) => ipcRenderer.invoke('file:open', p),
  revealPath: (p) => ipcRenderer.invoke('file:reveal', p),
  openRecentFolder: () => ipcRenderer.invoke('recent:open-folder'),

  debugStatus: () => ipcRenderer.invoke('debug:status'),
  quit: () => ipcRenderer.invoke('app:quit'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('app:set-always-on-top', v),
  setAutoStart: (v) => ipcRenderer.invoke('app:set-auto-start', v),
  autoStartState: () => ipcRenderer.invoke('app:auto-start-state'),

  on: (channel, cb) => {
    if (!CHANNELS.includes(channel)) return () => {};
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
