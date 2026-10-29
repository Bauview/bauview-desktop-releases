// BauView Desktop – Preload-Skript
// Läuft in einem eigenen, isolierten Kontext zwischen dem Electron-Hauptprozess und der Web-Seite.
// Stellt der Web-App (app.js) NUR gezielt freigegebene Funktionen zur Verfügung - kein direkter,
// unkontrollierter Zugriff auf Node.js/Dateisystem aus dem Web-Inhalt heraus (Sicherheitsprinzip
// von Electron: "Context Isolation").

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getAppVersion: () => ipcRenderer.invoke('bauview:getAppVersion'),
  // Etappe 2: Plan-Ordner-Anbindung
  chooseFolder: () => ipcRenderer.invoke('bauview:chooseFolder'),
  writeLocalFile: (rootFolder, relPath, base64Data) => ipcRenderer.invoke('bauview:writeLocalFile', rootFolder, relPath, base64Data),
  readLocalFile: (absPath) => ipcRenderer.invoke('bauview:readLocalFile', absPath),
  // Server-Ordner-Beobachtung (neu): meldet erkannte neue/geaenderte PDF-Dateien im Plan-Ordner
  watchPlanFolder: (rootFolder) => ipcRenderer.invoke('bauview:watchPlanFolder', rootFolder),
  unwatchPlanFolder: () => ipcRenderer.invoke('bauview:unwatchPlanFolder'),
  onPlanFileDetected: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('bauview:planFileDetected', handler);
    return () => ipcRenderer.removeListener('bauview:planFileDetected', handler);
  },
  // Offline-Dokumentenspeicher (neu): rein lokaler Cache, unabhängig vom Plan-Ordner
  cacheWriteFile: (relPath, dataUrlOrBase64) => ipcRenderer.invoke('bauview:cacheWriteFile', relPath, dataUrlOrBase64),
  cacheReadFile: (relPath) => ipcRenderer.invoke('bauview:cacheReadFile', relPath),
  cacheDeleteFile: (relPath) => ipcRenderer.invoke('bauview:cacheDeleteFile', relPath),
  notify: (title, body) => ipcRenderer.invoke('bauview:notify', title, body),
  // Automatische Updates (neu)
  checkForUpdates: () => ipcRenderer.invoke('bauview:checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('bauview:installUpdate'),
  getUpdateStatus: () => ipcRenderer.invoke('bauview:getUpdateStatus'),
  onUpdateStatus: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('bauview:updateStatus', handler);
    return () => ipcRenderer.removeListener('bauview:updateStatus', handler);
  },
});
