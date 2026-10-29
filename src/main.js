// BauView Desktop – Electron-Hauptprozess (Etappe 1)
// Verpackt die bestehende Web-App unverändert als installierbares Windows-Programm.
// Noch OHNE Plan-Ordner-Anbindung (kommt in Etappe 2) - Ziel dieser Etappe ist ausschliesslich,
// dass Installation, Start und automatische Updates zuverlässig funktionieren.

const { app, BrowserWindow, Menu, shell, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;

// Verhindert, dass mehrmaliges Starten (z.B. Doppelklick auf das Icon, waehrend die App noch
// laedt und "gefuehlt" nichts passiert) mehrere Electron-Prozesse gleichzeitig oeffnet. Mehrere
// Instanzen hielten bisher alle dieselbe lokale Datenbank (IndexedDB) gleichzeitig offen und
// blockierten sich gegenseitig - Ursache der gemeldeten durchgehenden Haenger/langen Ladezeiten
// ("Datenbank reagiert nicht"), reproduziert und bestaetigt im Task-Manager (zwei parallele
// BauView-Prozessgruppen). Ein zweiter Startversuch holt jetzt nur noch das bestehende Fenster
// in den Vordergrund, statt eine zweite Instanz zu starten.
const _gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!_gotSingleInstanceLock) {
  // Sofort abbrechen - alles danach (app.whenReady()-Kette, Fenstererstellung) darf in dieser
  // zweiten, abgewiesenen Instanz nicht mehr laufen, sonst koennte trotz quit() kurz ein zweites
  // Fenster aufgebaut werden, bevor der Prozess wirklich beendet ist.
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BauView',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Preload braucht Zugriff auf Node-APIs (contextBridge) - läuft trotzdem isoliert vom Web-Inhalt
    },
    autoHideMenuBar: true, // Menüleiste standardmässig ausgeblendet (Alt zeigt sie kurz) - schlankere Optik
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'app', 'index.html'));

  // Diagnose: Fehler aus der geladenen Web-Oberfläche selbst (app.js) im Terminal sichtbar machen -
  // hilft beim Testen, ob die eingebettete App fehlerfrei lädt, nicht nur die Electron-Hülle selbst.
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[Renderer ${level===2?'WARN':'ERROR'}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error('[Renderer] Laden fehlgeschlagen:', code, desc);
  });

  // Links, die sich normalerweise in einem neuen Browser-Tab öffnen würden (z.B. "In SharePoint
  // öffnen"), im STANDARD-Browser des Systems öffnen statt in einem neuen App-Fenster.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Schlanke Menüleiste (die Standard-Electron-Menüs enthalten viele für diese App irrelevante
// Einträge wie "Node DevTools" etc. - hier bewusst reduziert auf das Nötigste).
function buildMenu() {
  const template = [
    {
      label: 'BauView',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggledevtools', label: 'Entwicklertools (Diagnose)' },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'zoomIn', label: 'Vergrössern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { role: 'resetZoom', label: 'Normale Grösse' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  // Automatische Update-Prüfung: kurz nach dem Start, danach alle 4 Stunden im Hintergrund,
  // solange die App läuft. Ergebnis wird an die Web-Oberfläche gemeldet (siehe unten), die den
  // Fortschritt anzeigt statt nur einer stillen System-Benachrichtigung.
  setTimeout(() => { _checkForUpdates(); }, 5000);
  setInterval(() => { _checkForUpdates(); }, 4 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Einfache IPC-Handler für Phase 1 - liefert Versionsinformationen an die Web-Oberfläche,
// damit sie z.B. in den Einstellungen "Desktop-App vX.X" anzeigen kann.
ipcMain.handle('bauview:getAppVersion', () => app.getVersion());
ipcMain.handle('bauview:isElectron', () => true);

// --- Etappe 2: Plan-Ordner-Anbindung ---
// Entfernt Zeichen, die in Windows-Dateipfaden nicht erlaubt sind bzw. Ausbrüche aus dem
// gewählten Ordner ermöglichen würden ("..", führende Slashes). Angewendet auf JEDES Segment
// eines vom Renderer übergebenen relativen Pfads - der Renderer schickt Projekt-/Plannamen,
// die frei vom Nutzer vergeben wurden und daher nicht vertrauenswürdig sind.
function _sanitizeRelPath(relPath) {
  return relPath
    .split(/[\\/]+/)
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .map(seg => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_'))
    .join(path.sep);
}

// Öffnet den nativen "Ordner wählen"-Dialog. Gibt den gewählten Pfad zurück, oder null bei Abbruch.
ipcMain.handle('bauview:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Plan-Ordner wählen',
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// Legt eine Plan-PDF im gewählten Ordner ab (zusätzlich zur Cloud-Kopie). "rootFolder" kommt vom
// Renderer (aus den lokalen App-Einstellungen), "relPath" ist ein rein logischer Unterpfad
// (z.B. "Projektname/Planname_v2.pdf") und wird hier sanitisiert, bevor er mit dem Root verbunden
// wird - so kann relPath den gewählten Ordner nie verlassen.
ipcMain.handle('bauview:writeLocalFile', async (event, rootFolder, relPath, base64Data) => {
  if (!rootFolder || !relPath) throw new Error('Ordner oder Pfad fehlt');
  const safeRel = _sanitizeRelPath(relPath);
  if (!safeRel) throw new Error('Ungültiger Dateiname');
  const fullPath = path.join(rootFolder, safeRel);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  const buffer = Buffer.from(base64Data.includes(',') ? base64Data.split(',')[1] : base64Data, 'base64');
  await fs.promises.writeFile(fullPath, buffer);
  _markSelfWrite(fullPath); // Server-Ordner-Beobachtung: eigene ausgehende Kopie nicht als "von aussen erkannt" melden
  return fullPath;
});

// Liest eine zuvor lokal abgelegte Plan-PDF zurück (für die Anzeige im Plan-Editor). Gibt bei
// fehlender/verschobener Datei null zurück (kein Fehler) - die Web-Oberfläche fällt dann selbst
// auf die Cloud-Kopie zurück.
ipcMain.handle('bauview:readLocalFile', async (event, absPath) => {
  try {
    const buffer = await fs.promises.readFile(absPath);
    return buffer.toString('base64');
  } catch (e) {
    return null;
  }
});

// --- Server-Ordner-Beobachtung (neu) ---
// Erkennt, wenn im Plan-Ordner (z.B. direkt vom SharePoint/OneDrive-Server oder aus einer
// CAD-Software exportiert) eine neue oder geaenderte PDF-Datei abgelegt wird - unabhaengig davon,
// ob das ueber BauViews eigenen Upload-Dialog oder von aussen (Kollege/CAD-Export direkt in den
// synchronisierten Ordner) geschieht. Meldet erkannte, STABILE Dateien per IPC an die Web-
// Oberflaeche (app.js), die die eigentliche Namens-Zuordnung zu einem bestehenden Plan sowie die
// Bestaetigung/Uebernahme durch den Nutzer uebernimmt - hier in main.js passiert nur die reine
// Dateisystem-Beobachtung.
let _planWatcher = null;
let _watchedPlanRoot = null;
// Pfade, die BauView selbst gerade geschrieben hat (_saveLocalPlanCopy -> writeLocalFile oben) -
// werden fuer kurze Zeit ignoriert, damit der Watcher nicht auf die eigenen ausgehenden Kopien aus
// Etappe 2 anspringt (sonst wuerde jeder normale manuelle Upload sich selbst als "vom Server
// erkannt" melden).
const _recentSelfWrites = new Map(); // absPath (lowercase) -> Zeitstempel
const _SELF_WRITE_IGNORE_MS = 20000;
function _markSelfWrite(absPath) {
  _recentSelfWrites.set(absPath.toLowerCase(), Date.now());
}
function _isRecentSelfWrite(absPath) {
  const t = _recentSelfWrites.get(absPath.toLowerCase());
  if (!t) return false;
  if (Date.now() - t > _SELF_WRITE_IGNORE_MS) { _recentSelfWrites.delete(absPath.toLowerCase()); return false; }
  return true;
}

// Generationszaehler pro Pfad statt reinem Timer-Handle: ein Timer-Handle allein reicht NICHT,
// um ein bereits laufendes Stabilitaets-Pruefungspaar (erster stat() -> 1.2s warten -> zweiter
// stat()) sauber abzubrechen, wenn WAEHREND dieser Wartezeit ein weiteres fs.watch-Ereignis fuer
// denselben Pfad eintrifft (typisch bei mehrschuebigem OneDrive-Sync) - der schon gefeuerte
// aeussere Timer laesst sich nicht mehr per clearTimeout stoppen. Jede _awaitStableFile()-
// Anfrage erhoeht die Generation fuer den Pfad; jeder Zwischenschritt prueft vor dem Weitermachen,
// ob seine Generation noch die aktuelle ist - sonst wurde er von einem neueren Ereignis ueberholt
// und bricht still ab, ohne selbst noch zu melden. So kann fuer eine Datei nie mehr als eine
// Meldung aus zwei sich ueberschneidenden Pruefketten entstehen (gefunden und behoben beim Testen,
// siehe test_server_watch.js, Szenario C).
const _stabilityGeneration = new Map(); // absPath -> aktuelle Generation (Zahl)

function _runStabilityCheck(absPath, cb, myGen, attempt) {
  if (_stabilityGeneration.get(absPath) !== myGen) return; // ueberholt - abbrechen
  if (attempt > 30) { _stabilityGeneration.delete(absPath); return; } // aendert sich dauerhaft - naechstes echtes Ereignis stoesst neu an
  setTimeout(() => {
    if (_stabilityGeneration.get(absPath) !== myGen) return;
    fs.stat(absPath, (err, st1) => {
      if (_stabilityGeneration.get(absPath) !== myGen) return;
      if (err) { _stabilityGeneration.delete(absPath); return; } // geloescht/umbenannt - kein Fehler
      setTimeout(() => {
        if (_stabilityGeneration.get(absPath) !== myGen) return;
        fs.stat(absPath, (err2, st2) => {
          if (_stabilityGeneration.get(absPath) !== myGen) return;
          if (err2) { _stabilityGeneration.delete(absPath); return; }
          if (st1.size === st2.size && st1.mtimeMs === st2.mtimeMs && st1.size > 0) {
            _stabilityGeneration.delete(absPath);
            cb(st2);
          } else {
            _runStabilityCheck(absPath, cb, myGen, attempt + 1); // aendert sich noch - erneut warten
          }
        });
      }, 1200);
    });
  }, attempt === 0 ? 1500 : 1200);
}

// Wartet, bis sich eine Datei nicht mehr aendert (Dateigroesse UND Aenderungszeit ueber zwei
// Messungen im Abstand von ca. 1.2s identisch) - wichtig, weil OneDrive/SharePoint eine Datei
// haeufig in mehreren Schueben synchronisiert (Platzhalter -> Teildownload -> vollstaendig).
// Ohne diese Pruefung wuerde der Watcher eine noch unvollstaendige Datei melden. Jeder Aufruf
// startet eine frische Generation fuer den Pfad (siehe oben) - ein noch laufender aelterer Check
// fuer denselben Pfad wird dadurch automatisch entwertet, egal in welcher Phase er gerade ist.
function _awaitStableFile(absPath, cb) {
  const myGen = (_stabilityGeneration.get(absPath) || 0) + 1;
  _stabilityGeneration.set(absPath, myGen);
  _runStabilityCheck(absPath, cb, myGen, 0);
}

function _stopPlanFolderWatch() {
  if (_planWatcher) { try { _planWatcher.close(); } catch (e) { /* bereits geschlossen */ } _planWatcher = null; }
  _watchedPlanRoot = null;
  _stabilityGeneration.clear();
}

function _startPlanFolderWatch(rootFolder) {
  if (!rootFolder) { _stopPlanFolderWatch(); return; }
  if (_watchedPlanRoot === rootFolder && _planWatcher) return; // schon aktiv fuer denselben Ordner
  _stopPlanFolderWatch();
  try {
    _planWatcher = fs.watch(rootFolder, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (!/\.pdf$/i.test(filename)) return;
      const base = path.basename(filename);
      if (base.startsWith('~$') || base.startsWith('.')) return; // Office-/OneDrive-Temporaerdateien
      const absPath = path.join(rootFolder, filename);
      if (_isRecentSelfWrite(absPath)) return;
      _awaitStableFile(absPath, (st) => {
        if (_isRecentSelfWrite(absPath)) return; // koennte inzwischen selbst geschrieben worden sein
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bauview:planFileDetected', {
            fullPath: absPath,
            relPath: path.relative(rootFolder, absPath),
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      });
    });
    _watchedPlanRoot = rootFolder;
    console.log('[Server-Ordner-Beobachtung] aktiv fuer', rootFolder);
  } catch (e) {
    console.error('[Server-Ordner-Beobachtung] konnte Ordner nicht beobachten:', e.message);
    _planWatcher = null; _watchedPlanRoot = null;
  }
}

// Von der Web-Oberflaeche aufgerufen, sobald der Plan-Ordner (Etappe 2, Einstellungen ->
// Desktop-App) bekannt/geaendert ist - typischerweise direkt nach Login sowie beim Waehlen/
// Entfernen des Ordners. Erneuter Aufruf mit demselben Ordner ist ein no-op (kein Neustart noetig).
ipcMain.handle('bauview:watchPlanFolder', async (event, rootFolder) => {
  _startPlanFolderWatch(rootFolder);
  return true;
});
ipcMain.handle('bauview:unwatchPlanFolder', async () => {
  _stopPlanFolderWatch();
  return true;
});

// --- Offline-Dokumentenspeicher (neu) ---
// Rein lokaler Cache für Fotos, Unterschriften, Planausschnitte und weitere aus Supabase Storage
// geladene Dateien - UNABHÄNGIG vom oben gewählten Plan-Ordner (der ist für den SharePoint/
// OneDrive-Abgleich gedacht). Liegt im Electron-eigenen Nutzerdaten-Verzeichnis, erfordert keine
// Ordnerauswahl durch den Nutzer. Zweck: auch Dateien, die dieses Gerät nur aus der Cloud
// übernommen (nicht selbst erstellt/hochgeladen) hat, sollen offline verfügbar sein.
const CACHE_ROOT = path.join(app.getPath('userData'), 'OfflineCache');
function _ensureCacheRoot() {
  try { fs.mkdirSync(CACHE_ROOT, { recursive: true }); } catch (e) { /* existiert bereits */ }
}

ipcMain.handle('bauview:cacheWriteFile', async (event, relPath, dataUrlOrBase64) => {
  if (!relPath) throw new Error('Pfad fehlt');
  const safeRel = _sanitizeRelPath(relPath);
  if (!safeRel) throw new Error('Ungültiger Pfad');
  _ensureCacheRoot();
  const fullPath = path.join(CACHE_ROOT, safeRel);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  const buffer = Buffer.from(dataUrlOrBase64.includes(',') ? dataUrlOrBase64.split(',')[1] : dataUrlOrBase64, 'base64');
  await fs.promises.writeFile(fullPath, buffer);
  return true;
});

ipcMain.handle('bauview:cacheReadFile', async (event, relPath) => {
  try {
    const safeRel = _sanitizeRelPath(relPath);
    const buffer = await fs.promises.readFile(path.join(CACHE_ROOT, safeRel));
    return buffer.toString('base64');
  } catch (e) {
    return null; // nicht (mehr) im Cache - Aufrufer fällt auf Netzwerk/Cloud zurück
  }
});

ipcMain.handle('bauview:cacheDeleteFile', async (event, relPath) => {
  try {
    const safeRel = _sanitizeRelPath(relPath);
    await fs.promises.unlink(path.join(CACHE_ROOT, safeRel));
  } catch (e) { /* war ohnehin nicht vorhanden */ }
  return true;
});

// Kurze System-Benachrichtigung nach einer automatischen Hintergrund-Synchronisierung (z.B. beim
// Wiederherstellen der Internetverbindung). Schlägt lautlos fehl, falls der Nutzer System-
// Benachrichtigungen deaktiviert hat - kein Fehler in der App.
ipcMain.handle('bauview:notify', async (event, title, body) => {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) { /* keine Benachrichtigungen verfügbar - kein Problem */ }
  return true;
});

// --- Automatische Updates ---
// Update-Dateien liegen im öffentlichen Supabase-Storage-Bucket "files" (derselbe Cloud-Speicher,
// den BauView ohnehin für Fotos/Plan-PDFs nutzt), im Unterordner "app-updates/" - siehe
// package.json > build.publish. electron-updater lädt dort bei jeder Prüfung "latest.yml", und bei
// verfügbarer neuer Version die passende .exe + .blockmap automatisch herunter (generic-Provider,
// reines HTTPS GET, keine Zugangsdaten nötig).
autoUpdater.autoDownload = true;       // neue Version im Hintergrund automatisch herunterladen
autoUpdater.autoInstallOnAppQuit = true; // falls der Nutzer die App schliesst, bevor er "Installieren" klickt

let _updateCheckInFlight = false;

// Letzter Update-Stand: die Oberfläche fragt ihn beim Start ab (sie hört erst nach Anmeldung/Sync zu
// und verpasste sonst die Meldungen der ersten Prüfung - Ursache für fehlende Update-Hinweise bis 1.7.1).
let _lastUpdateStatus = null;
// Kleines Protokoll im Benutzerordner (%APPDATA%\BauView\update-log.txt) zur Fehlersuche.
function _updLog(line) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update-log.txt'), new Date().toISOString() + ' ' + line + '\n'); } catch (e) {}
}
function _sendUpdateStatus(payload) {
  if (payload.state !== 'downloading') _updLog(`[${app.getVersion()}] ${payload.state}${payload.version ? ' ' + payload.version : ''}${payload.message ? ' ' + payload.message : ''}`);
  if (payload.state !== 'checking' || !_lastUpdateStatus || _lastUpdateStatus.state !== 'downloaded') _lastUpdateStatus = payload;
  if (payload.state === 'downloaded') {
    try { if (Notification.isSupported()) new Notification({ title: 'BauView-Update bereit', body: `Version ${payload.version || ''} ist geladen. Wird beim Beenden installiert - oder in BauView unten links "Jetzt installieren".` }).show(); } catch (e) {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bauview:updateStatus', payload);
  }
}
ipcMain.handle('bauview:getUpdateStatus', () => _lastUpdateStatus);

function _checkForUpdates() {
  if (_updateCheckInFlight) return;
  _updateCheckInFlight = true;
  autoUpdater.checkForUpdates().catch(err => {
    _updateCheckInFlight = false;
    // Kein Internet, Update-Speicher nicht erreichbar o.ä. - kein Absturz, einfach normal
    // weiterarbeiten. Wird trotzdem an die Oberfläche gemeldet, damit "Nach Updates suchen"
    // (manueller Button) dem Nutzer eine Rückmeldung geben kann statt endlos zu laden.
    _sendUpdateStatus({ state: 'error', message: String(err && err.message || err) });
  });
}

autoUpdater.on('checking-for-update', () => {
  _sendUpdateStatus({ state: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  _updateCheckInFlight = false;
  _sendUpdateStatus({ state: 'available', version: info.version });
});
autoUpdater.on('update-not-available', () => {
  _updateCheckInFlight = false;
  _sendUpdateStatus({ state: 'not-available' });
});
autoUpdater.on('download-progress', (progress) => {
  _sendUpdateStatus({
    state: 'downloading',
    percent: Math.round(progress.percent || 0),
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  });
});
autoUpdater.on('update-downloaded', (info) => {
  _updateCheckInFlight = false;
  _sendUpdateStatus({ state: 'downloaded', version: info.version });
});
autoUpdater.on('error', (err) => {
  _updateCheckInFlight = false;
  _sendUpdateStatus({ state: 'error', message: String(err && err.message || err) });
});

// Manuelle Prüfung (Button "Nach Updates suchen" in den Einstellungen).
ipcMain.handle('bauview:checkForUpdates', async () => {
  _checkForUpdates();
  return true;
});

// "Jetzt installieren & neu starten" - nur sinnvoll aufrufbar, nachdem 'update-downloaded'
// gemeldet wurde. Beendet die App und startet den Installer (NSIS, kein Nutzereingriff nötig).
ipcMain.handle('bauview:installUpdate', async () => {
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});
