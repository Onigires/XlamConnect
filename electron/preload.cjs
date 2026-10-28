const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('xlam', {
  invoke: (method, args) => ipcRenderer.invoke('xlam', method, args || {}),
  on: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('xlam:event', h); return () => ipcRenderer.removeListener('xlam:event', h); },
  win: {
    minimize: () => ipcRenderer.send('win', 'minimize'),
    maximize: () => ipcRenderer.send('win', 'maximize'),
    close: () => ipcRenderer.send('win', 'close'),
  },
});
