const { app, Tray, Menu, shell, nativeImage, Notification, clipboard, BrowserWindow, ipcMain, powerSaveBlocker, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Store = require('electron-store');

let tray = null;
let qrWindow = null;
let backupWindow = null;
let serverProcess = null;
let serverPath = null;
let uploadsPath = null;
let dbPath = null;
let cloudUsersPath = null;
let logFilePath = null;
let updateAvailable = false;
let latestVersion = null;
let updateStatus = 'Updates: GitHub Releases';
let startOnBoot = false;
let backupPowerSaveBlockerId = null;

const store = new Store({ name: 'photolynk-tray' });

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      updateTrayMenu();
    } catch (e) {
      // ignore
    }
  });
}

function startBackupPowerSaveBlocker() {
  try {
    if (backupPowerSaveBlockerId && powerSaveBlocker.isStarted(backupPowerSaveBlockerId)) return;
    backupPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } catch (e) {
    backupPowerSaveBlockerId = null;
  }
}

function stopBackupPowerSaveBlocker() {
  try {
    if (!backupPowerSaveBlockerId) return;
    if (powerSaveBlocker.isStarted(backupPowerSaveBlockerId)) {
      powerSaveBlocker.stop(backupPowerSaveBlockerId);
    }
  } catch (e) {
    // ignore
  } finally {
    backupPowerSaveBlockerId = null;
  }
}

function appendLog(line) {
  try {
    if (!logFilePath) return;
    fs.appendFileSync(logFilePath, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8' });
  } catch (e) {
    // ignore
  }
}

function safeConsole(method, ...args) {
  try {
    if (console && typeof console[method] === 'function') {
      console[method](...args);
    }
  } catch (e) {
    if (e && e.code === 'EPIPE') return;
  }
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendLog(`[${method}] ${msg}`);
  } catch (e) {
    // ignore
  }
}

process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  safeConsole('error', 'Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  safeConsole('error', 'Unhandled Rejection:', reason);
});

function getBundledServerPath() {
  if (app && app.isPackaged) return path.join(process.resourcesPath, 'server');
  return path.join(__dirname, '..', 'server');
}

function getDataRoot() {
  return app.getPath('userData');
}

function initPaths() {
  serverPath = getBundledServerPath();
  uploadsPath = path.join(getDataRoot(), 'uploads');
  dbPath = path.join(getDataRoot(), 'backup.db');
  cloudUsersPath = path.join(getDataRoot(), 'cloud', 'users');
  logFilePath = path.join(getDataRoot(), 'server-tray.log');

  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }

  if (!fs.existsSync(cloudUsersPath)) {
    fs.mkdirSync(cloudUsersPath, { recursive: true });
  }

  safeConsole('log', 'Server path:', serverPath);
  safeConsole('log', 'Uploads path:', uploadsPath);
  safeConsole('log', 'Tray log path:', logFilePath);
}

function setAutostart(enabled) {
  startOnBoot = enabled;
  store.set('startOnBoot', enabled);

  // macOS & Windows: use built-in login item settings
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true
      });
      safeConsole('log', 'Login item settings updated. openAtLogin =', enabled);
    } catch (err) {
      safeConsole('error', 'Failed to update login item settings:', err);
    }
    return;
  }

  // Linux: create/remove autostart .desktop entry
  if (process.platform === 'linux') {
    try {
      const autostartDir = path.join(os.homedir(), '.config', 'autostart');
      const desktopFile = path.join(autostartDir, 'photosync-server.desktop');

      if (!fs.existsSync(autostartDir)) {
        fs.mkdirSync(autostartDir, { recursive: true });
      }

      if (enabled) {
        const execPath = process.execPath; // points to the built app binary
        const desktopContent = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=PhotoLynk Server',
          `Exec="${execPath}"`,
          'X-GNOME-Autostart-enabled=true',
          'NoDisplay=false',
          'Terminal=false',
          ''
        ].join('\n');
        fs.writeFileSync(desktopFile, desktopContent, { encoding: 'utf8' });
        safeConsole('log', 'Created autostart entry at', desktopFile);
      } else {
        if (fs.existsSync(desktopFile)) {
          fs.unlinkSync(desktopFile);
          safeConsole('log', 'Removed autostart entry at', desktopFile);
        }
      }
    } catch (err) {
      safeConsole('error', 'Failed to configure Linux autostart:', err);
    }
  }
}

function startServer() {
  if (serverProcess) {
    safeConsole('log', 'Server already running');
    return;
  }

  if (!serverPath || !uploadsPath || !dbPath) {
    initPaths();
  }

  stopLegacyService();
  const portIsFree = freePort3000ForPhotoSync();
  if (!portIsFree) {
    try {
      new Notification({
        title: 'PhotoLynk Server',
        body: 'Port 3000 is already in use by another app. Close it and try again.',
        silent: true
      }).show();
    } catch (e) {
      // ignore
    }
    updateTrayMenu();
    return;
  }

  safeConsole('log', 'Starting server from:', serverPath);
  
  const serverEntry = path.join(serverPath, 'server.js');
  const nodeModulesPaths = [
    ...(app && app.isPackaged
      ? [
          path.join(process.resourcesPath, 'app.asar', 'node_modules'),
          path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        ]
      : [path.join(__dirname, 'node_modules')]),
    path.join(serverPath, 'node_modules')
  ];

  const nodePath = [...nodeModulesPaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    NODE_PATH: nodePath,
    UPLOAD_DIR: uploadsPath,
    DB_PATH: dbPath,
    CLOUD_DIR: path.join(getDataRoot(), 'cloud'),
    ELECTRON_RUN_AS_NODE: '1'
  };

  // Use Electron's embedded Node runtime so system Node is not required.
  // `--runAsNode` makes Electron behave like Node.js.
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  // Log server output
  serverProcess.stdout.on('data', (data) => {
    safeConsole('log', `[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    safeConsole('error', `[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    safeConsole('error', 'Failed to start server:', err);
    serverProcess = null;
    updateTrayMenu();
  });

  serverProcess.on('close', (code) => {
    safeConsole('log', `Server process exited with code ${code}`);
    serverProcess = null;
    updateTrayMenu();
  });

  // Update menu after a delay to ensure server is fully started
  setTimeout(() => {
    updateTrayMenu();
  }, 2000);
}

function stopServer() {
  safeConsole('log', 'Stopping server...');
  
  // Kill the server process
  if (serverProcess) {
    try {
      serverProcess.kill('SIGKILL');
      serverProcess = null;
    } catch (e) {
      safeConsole('error', 'Error killing server process:', e);
    }
  }
  
  freePort3000ForPhotoSync();
  
  // Update menu after a delay to ensure port is released
  setTimeout(() => {
    updateTrayMenu();
  }, 1000);
}

function restartServer() {
  safeConsole('log', 'Restarting server...');
  stopServer();
  setTimeout(() => {
    startServer();
  }, 1000);
}

function openUploadsFolder() {
  shell.openPath(uploadsPath);
}

function getLocalIpAddresses() {
  const nets = os.networkInterfaces ? os.networkInterfaces() : {};

  const isRfc1918 = (ip) => {
    if (typeof ip !== 'string') return false;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    const m = ip.match(/^172\.(\d+)\./);
    if (m) {
      const n = Number(m[1]);
      return n >= 16 && n <= 31;
    }
    return false;
  };

  const isBlockedInterface = (name) => {
    const n = String(name || '').toLowerCase();
    return (
      n === 'lo0' ||
      n.startsWith('lo') ||
      n.startsWith('utun') ||
      n.startsWith('tun') ||
      n.startsWith('tap') ||
      n.startsWith('bridge') ||
      n.startsWith('vmnet') ||
      n.startsWith('vboxnet') ||
      n.startsWith('docker') ||
      n.startsWith('br-') ||
      n.startsWith('awdl') ||
      n.startsWith('llw')
    );
  };

  const preferredInterfaces = process.platform === 'darwin'
    ? ['en0', 'en1']
    : process.platform === 'win32'
      ? ['wi-fi', 'wlan', 'ethernet']
      : ['eth0', 'wlan0'];

  const candidates = [];
  Object.keys(nets || {}).forEach((name) => {
    if (isBlockedInterface(name)) return;
    const entries = nets[name] || [];
    entries.forEach((net) => {
      if (!net) return;
      if (net.family !== 'IPv4') return;
      if (net.internal) return;
      if (!net.address) return;
      if (net.address.startsWith('169.254.')) return;
      if (!isRfc1918(net.address)) return;

      const key = String(name || '').toLowerCase();
      const isPreferred = preferredInterfaces.some((p) => key === p || key.includes(p));
      candidates.push({ name, address: net.address, preferred: isPreferred });
    });
  });

  candidates.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.address.localeCompare(b.address);
  });

  const chosen = candidates.length > 0 ? candidates[0].address : null;
  return chosen ? [chosen] : [];
}

function stopLegacyService() {
  if (process.platform !== 'darwin') return;
  try {
    const agentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.photosync.server.plist');
    if (!fs.existsSync(agentPath)) return;

    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
    try {
      if (uid) execSync(`launchctl bootout gui/${uid} "${agentPath}"`, { stdio: 'ignore' });
    } catch (e) {
      // ignore
    }
    try {
      execSync(`launchctl unload "${agentPath}"`, { stdio: 'ignore' });
    } catch (e) {
      // ignore
    }
    try {
      execSync('launchctl remove com.photosync.server', { stdio: 'ignore' });
    } catch (e) {
      // ignore
    }

    // Prevent respawn by removing the legacy plist.
    try {
      fs.unlinkSync(agentPath);
      safeConsole('log', 'Removed legacy launch agent:', agentPath);
    } catch (e) {
      // ignore
    }
  } catch (e) {
    // ignore
  }
}

function getPort3000Listeners() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano | findstr :3000', { encoding: 'utf8' }).toString();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pids = new Set();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      return Array.from(pids);
    }

    try {
      const out = execSync('lsof -ti:3000 -sTCP:LISTEN', { encoding: 'utf8' }).toString();
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
    } catch (e) {
      // ignore
    }

    try {
      const out = execSync('ss -ltnp 2>/dev/null | grep ":3000" || true', { encoding: 'utf8' }).toString();
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/pid=(\d+)/);
        if (m && m[1]) pids.add(m[1]);
      }
      return Array.from(pids);
    } catch (e) {
      // ignore
    }

    try {
      const out = execSync('netstat -ltnp 2>/dev/null | grep ":3000" || true', { encoding: 'utf8' }).toString();
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/\s(\d+)\//);
        if (m && m[1]) pids.add(m[1]);
      }
      return Array.from(pids);
    } catch (e) {
      // ignore
    }

    return [];
  } catch (e) {
    return [];
  }
}

function isPort3000InUse() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano | findstr :3000', { encoding: 'utf8' }).toString();
      return out.trim().length > 0;
    }

    try {
      const out = execSync('lsof -nP -iTCP:3000 -sTCP:LISTEN || true', { encoding: 'utf8' }).toString();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return lines.length > 1;
    } catch (e) {
      // ignore
    }

    try {
      const out = execSync('ss -ltn 2>/dev/null | grep ":3000" || true', { encoding: 'utf8' }).toString();
      return out.trim().length > 0;
    } catch (e) {
      // ignore
    }

    try {
      const out = execSync('netstat -ltn 2>/dev/null | grep ":3000" || true', { encoding: 'utf8' }).toString();
      return out.trim().length > 0;
    } catch (e) {
      // ignore
    }

    return false;
  } catch (e) {
    return false;
  }
}

function isPhotoSyncOwnedPid(pid) {
  try {
    const pidStr = String(pid);
    if (!/^\d+$/.test(pidStr)) return false;

    if (process.platform === 'win32') {
      const ps = `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pidStr}').CommandLine"`;
      const cmd = execSync(ps, { encoding: 'utf8' }).toString();
      const hay = String(cmd || '').toLowerCase();
      if (hay.includes('photosync') && hay.includes('server')) return true;
      if (hay.includes('server.js') && hay.includes('photosync')) return true;
      return false;
    }

    const cmd = execSync(`ps -p ${pidStr} -o command=`, { encoding: 'utf8' }).toString();
    const hay = String(cmd || '');
    if (hay.includes('PhotoSync Server.app/Contents/Resources/server/server.js')) return true;
    if (hay.includes('PhotoLynk Server.app/Contents/Resources/server/server.js')) return true;
    if (hay.includes('/PhotoSync/server/server.js')) return true;
    if (hay.includes('/PhotoLynk/server/server.js')) return true;
    if (hay.includes('com.photosync.server')) return true;
    if (hay.toLowerCase().includes('photosync') && hay.includes('server.js')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function freePort3000ForPhotoSync() {
  const pids = getPort3000Listeners();

  // If the port is in use but we cannot discover any PID (common on Linux without
  // permission to see process info), do NOT attempt to start a second server.
  if (pids.length === 0) return !isPort3000InUse();

  let killedAny = false;
  for (const pid of pids) {
    if (!isPhotoSyncOwnedPid(pid)) continue;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
      killedAny = true;
      safeConsole('log', 'Stopped PhotoLynk listener on port 3000 (PID:', pid, ')');
    } catch (e) {
      // ignore
    }
  }

  if (!killedAny) return false;

  const remaining = getPort3000Listeners();
  if (remaining.length > 0) return false;
  return !isPort3000InUse();
}

function notifyCopied(text) {
  try {
    new Notification({
      title: 'Copied',
      body: text,
      silent: true
    }).show();
  } catch (e) {
    // ignore
  }
}

function checkForUpdates() {
  // Packaged apps should update as an app (not via git/npm scripts).
  // Open GitHub Releases so the user can download the latest installer.
  try {
    shell.openExternal('https://github.com/viktorvishyn369/PhotoLynk/releases');
  } catch (e) {
    // ignore
  }
}

function installUpdate() {
  // Packaged apps should update as an app (not via git/npm scripts).
  // Open GitHub Releases so the user can download the latest installer.
  try {
    shell.openExternal('https://github.com/viktorvishyn369/PhotoLynk/releases');
  } catch (e) {
    // ignore
  }
}

// ============================================================================
// QR CODE PAIRING SYSTEM
// ============================================================================

function generatePairingToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getPairingData() {
  const ips = getLocalIpAddresses();
  const ip = ips.length > 0 ? ips[0] : '127.0.0.1';
  
  // Get or create a persistent pairing token
  let pairingToken = store.get('pairingToken');
  if (!pairingToken) {
    pairingToken = generatePairingToken();
    store.set('pairingToken', pairingToken);
  }
  
  return {
    type: 'photolynk-local',
    ip: ip,
    port: 3000,
    token: pairingToken,
    name: os.hostname() || 'PhotoLynk Server'
  };
}

function showQRCodeWindow() {
  if (qrWindow && !qrWindow.isDestroyed()) {
    qrWindow.focus();
    return;
  }
  
  const pairingData = getPairingData();
  const qrDataString = JSON.stringify(pairingData);
  
  qrWindow = new BrowserWindow({
    width: 360,
    height: 480,
    minWidth: 320,
    minHeight: 420,
    resizable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'Connect Mobile',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  // Generate QR code HTML
  const QRCode = require('qrcode');
  QRCode.toDataURL(qrDataString, { width: 280, margin: 2 }, (err, url) => {
    if (err) {
      safeConsole('error', 'Failed to generate QR code:', err);
      qrWindow.close();
      return;
    }
    
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg-primary: #0A0A0A;
      --bg-card: rgba(30, 30, 30, 0.85);
      --accent: #4A9FE8;
      --accent-secondary: #03DAC6;
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --glow-white: 0 2px 12px rgba(255, 255, 255, 0.08);
      --glow-accent: 0 2px 10px rgba(74, 159, 232, 0.25);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      padding: clamp(12px, 4vw, 24px);
    }
    .header {
      text-align: center;
      margin-bottom: clamp(12px, 3vw, 20px);
    }
    .title {
      font-size: clamp(16px, 5vw, 20px);
      font-weight: 600;
    }
    .subtitle {
      font-size: clamp(11px, 3vw, 13px);
      color: var(--text-secondary);
      margin-top: 4px;
    }
    .qr-container {
      background: #fff;
      padding: clamp(10px, 3vw, 16px);
      border-radius: clamp(10px, 3vw, 14px);
      box-shadow: 0 4px 24px rgba(74, 159, 232, 0.3), 0 0 40px rgba(74, 159, 232, 0.15);
      border: 2px solid rgba(74, 159, 232, 0.4);
    }
    .qr-code {
      display: block;
      width: clamp(160px, 50vw, 220px);
      height: clamp(160px, 50vw, 220px);
    }
    .steps {
      margin-top: clamp(12px, 3vw, 20px);
      width: 100%;
      max-width: 300px;
    }
    .step {
      display: flex;
      align-items: center;
      margin-bottom: clamp(6px, 1.5vw, 10px);
    }
    .step-num {
      background: rgba(74, 159, 232, 0.2);
      border: 1px solid rgba(74, 159, 232, 0.6);
      color: var(--accent);
      width: clamp(18px, 5vw, 22px);
      height: clamp(18px, 5vw, 22px);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: clamp(10px, 2.5vw, 11px);
      font-weight: 600;
      margin-right: clamp(8px, 2vw, 10px);
      flex-shrink: 0;
    }
    .step-text {
      font-size: clamp(11px, 3vw, 12px);
      color: var(--text-secondary);
    }
    .ip-badge {
      margin-top: clamp(10px, 2.5vw, 16px);
      padding: clamp(8px, 2vw, 10px) clamp(12px, 3vw, 16px);
      background: rgba(74, 159, 232, 0.1);
      border: 1px solid rgba(74, 159, 232, 0.3);
      border-radius: 8px;
      font-size: clamp(11px, 3vw, 12px);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .ip-badge span { color: var(--accent-secondary); font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">📱 Connect Mobile</div>
    <div class="subtitle">Scan with PhotoLynk app</div>
  </div>
  
  <div class="qr-container">
    <img class="qr-code" src="${url}" alt="QR Code">
  </div>
  
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Open PhotoLynk on your phone</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Select "Local" server type</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Tap "Scan QR" and point here</div>
    </div>
  </div>
  
  <div class="ip-badge">
    Server: <span>${pairingData.ip}:${pairingData.port}</span>
  </div>
</body>
</html>`;
    
    qrWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
  
  qrWindow.on('closed', () => {
    qrWindow = null;
  });
  
  // Hide menu bar
  qrWindow.setMenuBarVisibility(false);
}

// ============================================================================
// DESKTOP BACKUP CLIENT
// ============================================================================

function getPhotoFolders() {
  // Return user's custom folders if set, otherwise return empty array
  const customFolders = store.get('backupFolders') || [];
  return customFolders.filter(f => {
    try {
      return fs.existsSync(f) && fs.statSync(f).isDirectory();
    } catch (e) {
      return false;
    }
  });
}

// IPC handler for adding folders via dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(backupWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select Folders to Backup'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

ipcMain.on('save-backup-folders', (event, folders) => {
  store.set('backupFolders', folders);
});

ipcMain.on('get-backup-folders', (event) => {
  const folders = store.get('backupFolders') || [];
  event.reply('backup-folders', folders);
});

function showBackupWindow() {
  if (backupWindow && !backupWindow.isDestroyed()) {
    backupWindow.focus();
    return;
  }
  
  const credentials = store.get('backupCredentials') || {};
  const photoFolders = getPhotoFolders();
  
  backupWindow = new BrowserWindow({
    width: 400,
    height: 580,
    minWidth: 360,
    minHeight: 480,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: 'Desktop Backup',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg-primary: #0A0A0A;
      --bg-card: rgba(30, 30, 30, 0.85);
      --bg-input: rgba(26, 26, 26, 0.9);
      --accent: #4A9FE8;
      --accent-hover: #3B8BD4;
      --accent-secondary: #03DAC6;
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --success: #03DAC6;
      --error: #CF6679;
      --glow-white: 0 2px 12px rgba(255, 255, 255, 0.08);
      --glow-accent: 0 2px 10px rgba(74, 159, 232, 0.25);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: clamp(8px, 2vw, 12px);
    }
    .header {
      text-align: center;
      padding: clamp(6px, 1.5vw, 8px) clamp(8px, 2vw, 10px) clamp(4px, 1vw, 6px);
      flex-shrink: 0;
    }
    .header h1 {
      font-size: clamp(12px, 3vw, 16px);
      margin: 0;
      color: var(--text-primary);
    }
    .subtitle {
      font-size: clamp(8px, 2vw, 10px);
      color: var(--text-secondary);
      margin-top: 1px;
    }
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: clamp(6px, 1.5vw, 8px);
      padding: 0 clamp(8px, 2vw, 12px);
      min-height: 0;
      overflow-y: auto;
      padding-bottom: clamp(6px, 1.5vw, 8px);
    }
    .section {
      background: var(--bg-card);
      border-radius: 8px;
      padding: clamp(8px, 2vw, 12px);
      flex-shrink: 0;
      border: 1px solid var(--border);
      box-shadow: var(--glow-white);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .section-title {
      font-size: clamp(11px, 2.8vw, 13px);
      font-weight: 600;
      margin-bottom: clamp(6px, 1.5vw, 8px);
      color: var(--accent);
    }
    .radio-group {
      display: flex;
      gap: clamp(6px, 2vw, 10px);
    }
    .radio-option {
      flex: 1;
      display: flex;
      align-items: center;
      padding: clamp(8px, 2vw, 10px) clamp(10px, 2.5vw, 12px);
      background: var(--bg-input);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .radio-option:hover { background: rgba(255,255,255,0.12); border-color: rgba(255, 255, 255, 0.2); }
    .radio-option.selected {
      background: rgba(74, 159, 232, 0.15);
      border-color: rgba(74, 159, 232, 0.6);
      box-shadow: var(--glow-accent);
    }
    .radio-option input { display: none; }
    .radio-dot {
      width: 16px;
      height: 16px;
      border: 2px solid var(--text-secondary);
      border-radius: 50%;
      margin-right: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .radio-option.selected .radio-dot {
      border-color: var(--accent);
    }
    .radio-option.selected .radio-dot::after {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
    }
    .radio-label { font-size: clamp(11px, 2.8vw, 13px); font-weight: 500; }
    .radio-sublabel { font-size: clamp(9px, 2.2vw, 10px); color: var(--text-muted); margin-top: 1px; }
    .form-row {
      display: flex;
      gap: clamp(6px, 2vw, 10px);
      margin-bottom: clamp(6px, 1.5vw, 8px);
    }
    .form-row:last-child { margin-bottom: 0; }
    .form-group { flex: 1; }
    .form-group label {
      display: block;
      font-size: clamp(10px, 2.5vw, 11px);
      color: var(--text-secondary);
      margin-bottom: 4px;
    }
    .form-group input {
      width: 100%;
      padding: clamp(8px, 2vw, 10px) clamp(10px, 2.5vw, 12px);
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: clamp(12px, 3vw, 13px);
      transition: all 0.2s;
    }
    .form-group input:focus {
      outline: none;
      border-color: rgba(74, 159, 232, 0.6);
      box-shadow: 0 0 8px rgba(74, 159, 232, 0.2);
    }
    .form-group input::placeholder { color: var(--text-muted); }
    .note {
      font-size: clamp(9px, 2.2vw, 10px);
      color: var(--text-muted);
      margin-top: 6px;
    }
    .folders-section {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .folder-list {
      flex: 1;
      overflow-y: auto;
      max-height: clamp(60px, 15vh, 100px);
    }
    .folder-buttons {
      margin-top: auto;
      padding-top: 8px;
    }
    .folder-item {
      display: flex;
      align-items: center;
      padding: clamp(6px, 1.5vw, 8px) clamp(8px, 2vw, 10px);
      background: var(--bg-input);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      margin-bottom: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .folder-item:hover { background: rgba(255,255,255,0.12); border-color: rgba(255, 255, 255, 0.15); }
    .folder-item input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin-right: 8px;
      accent-color: var(--accent);
      flex-shrink: 0;
    }
    .folder-path {
      font-size: clamp(10px, 2.5vw, 11px);
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .footer {
      display: flex;
      gap: clamp(6px, 1.5vw, 8px);
      padding: clamp(8px, 2vw, 10px) clamp(10px, 2.5vw, 14px);
      flex-shrink: 0;
      margin-top: auto;
    }
    .btn {
      flex: 1;
      padding: clamp(8px, 2vw, 10px);
      border: none;
      border-radius: 6px;
      font-size: clamp(11px, 2.8vw, 13px);
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-primary);
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); border-color: rgba(255, 255, 255, 0.3); }
    .btn-primary {
      background: rgba(74, 159, 232, 0.2);
      color: #fff;
      border: 1px solid rgba(74, 159, 232, 0.6);
      box-shadow: var(--glow-accent);
    }
    .btn-primary:hover { background: rgba(74, 159, 232, 0.3); border-color: rgba(74, 159, 232, 0.8); }
    .btn-primary:disabled {
      background: #444;
      cursor: not-allowed;
    }
    .btn-success {
      background: var(--success);
    }
    .status {
      background: rgba(74, 159, 232, 0.1);
      border: 1px solid rgba(74, 159, 232, 0.3);
      border-radius: 6px;
      padding: 6px 8px;
      margin: 0 clamp(8px, 2vw, 12px) 6px;
      display: none;
      flex-shrink: 0;
    }
    .status.visible { display: block; }
    .status-text {
      font-size: 10px;
      color: var(--text-primary);
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    .progress-bar {
      height: 4px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      width: 0%;
      transition: width 0.3s;
    }
    .status.error .status-text { color: var(--error); }
    .status.success .progress-fill { background: var(--success); }
    #remote-config { display: none; }
    #remote-config.visible { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🖥️ Desktop Backup</h1>
    <p class="subtitle">Backup photos & videos from this computer</p>
  </div>
  
  <div class="content">
    <div class="section">
      <div class="section-title">Destination</div>
      <div class="radio-group">
        <label class="radio-option" id="opt-remote">
          <input type="radio" name="destination" value="remote">
          <div class="radio-dot"></div>
          <div>
            <div class="radio-label">Remote Server</div>
            <div class="radio-sublabel">Your own server</div>
          </div>
        </label>
        <label class="radio-option selected" id="opt-stealthcloud">
          <input type="radio" name="destination" value="stealthcloud" checked>
          <div class="radio-dot"></div>
          <div>
            <div class="radio-label">StealthCloud</div>
            <div class="radio-sublabel">Managed cloud</div>
          </div>
        </label>
      </div>
    </div>
    
    <div class="section" id="remote-config">
      <div class="section-title">Remote Server</div>
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>Address</label>
          <input type="text" id="remote-address" placeholder="192.168.1.100" value="${credentials.remoteAddress || ''}">
        </div>
        <div class="form-group" style="flex:1">
          <label>Port</label>
          <input type="text" id="remote-port" placeholder="3000" value="${credentials.remotePort || '3000'}">
        </div>
      </div>
    </div>
    
    <div class="section">
      <div class="section-title">Credentials</div>
      <div class="form-row">
        <div class="form-group">
          <label>Email</label>
          <input type="email" id="email" placeholder="your@email.com" value="${credentials.email || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="password" placeholder="Password" value="${credentials.password || ''}">
        </div>
      </div>
      <p class="note">Use same credentials as mobile app to sync across devices.</p>
    </div>
    
    <div class="section folders-section">
      <div class="section-title">Folders to Backup</div>
      <div style="background: rgba(255, 180, 0, 0.08); border: 1px solid rgba(255, 180, 0, 0.25); border-radius: 4px; padding: 6px 8px; margin-bottom: 8px; font-size: 10px; color: #d4a000; line-height: 1.4;">
        <strong>⚠️</strong> Avoid system folders (Photos Library, Pictures). Export to a dedicated folder instead.
      </div>
      <div class="folder-list" id="folder-list">
        <!-- Folders will be populated dynamically -->
      </div>
      <div class="folder-buttons" style="display: flex; gap: 8px;">
        <button class="btn btn-secondary" style="flex: 1; padding: 8px;" onclick="addFolder()">+ Add Folder</button>
        <button class="btn btn-secondary" style="padding: 8px; min-width: 80px;" onclick="clearFolders()">Clear All</button>
      </div>
    </div>
    
  </div>
  
  <div class="status" id="status">
    <div class="status-text" id="status-text">Preparing...</div>
    <div class="progress-bar">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
  </div>
  
  <div class="footer">
    <button class="btn btn-secondary" id="cancel-btn" onclick="handleCancel()">Cancel</button>
    <button class="btn btn-primary" id="backup-btn" onclick="startBackup()">Start Backup</button>
  </div>
  
  <script>
    const { ipcRenderer } = require('electron');
    let isBackingUp = false;
    let selectedFolders = ${JSON.stringify(photoFolders)};
    
    // Initialize folder list on load
    renderFolders();
    
    function renderFolders() {
      const list = document.getElementById('folder-list');
      if (selectedFolders.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); padding: 12px; text-align: center;">No folders selected. Click "Add Folder" to choose folders to backup.</div>';
      } else {
        list.innerHTML = selectedFolders.map((f, i) => \`
          <div class="folder-item" style="display: flex; align-items: center; justify-content: space-between;">
            <span class="folder-path" title="\${f}" style="flex: 1; overflow: hidden; text-overflow: ellipsis;">\${f}</span>
            <button onclick="removeFolder(\${i})" style="background: none; border: none; color: var(--error); cursor: pointer; padding: 4px 8px; font-size: 14px;">✕</button>
          </div>
        \`).join('');
      }
    }
    
    async function addFolder() {
      const paths = await ipcRenderer.invoke('select-folder');
      if (paths && paths.length > 0) {
        paths.forEach(p => {
          if (!selectedFolders.includes(p)) {
            selectedFolders.push(p);
          }
        });
        ipcRenderer.send('save-backup-folders', selectedFolders);
        renderFolders();
      }
    }
    
    function removeFolder(index) {
      selectedFolders.splice(index, 1);
      ipcRenderer.send('save-backup-folders', selectedFolders);
      renderFolders();
    }
    
    function clearFolders() {
      selectedFolders = [];
      ipcRenderer.send('save-backup-folders', selectedFolders);
      renderFolders();
    }
    
    document.querySelectorAll('input[name="destination"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        document.querySelectorAll('.radio-option').forEach(opt => opt.classList.remove('selected'));
        e.target.closest('.radio-option').classList.add('selected');
        const remoteConfig = document.getElementById('remote-config');
        if (e.target.value === 'remote') {
          remoteConfig.classList.add('visible');
        } else {
          remoteConfig.classList.remove('visible');
        }
      });
    });
    
    function handleCancel() {
      if (isBackingUp) {
        ipcRenderer.send('cancel-desktop-backup');
        document.getElementById('status-text').textContent = 'Cancelling...';
      } else {
        window.close();
      }
    }
    
    function startBackup() {
      const destination = document.querySelector('input[name="destination"]:checked').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      
      if (!email || !password) {
        showError('Please enter email and password');
        return;
      }
      
      if (selectedFolders.length === 0) {
        showError('Add at least one folder to backup');
        return;
      }
      
      const folders = selectedFolders;
      
      const config = {
        destination,
        email,
        password,
        folders,
        remoteAddress: document.getElementById('remote-address').value,
        remotePort: document.getElementById('remote-port').value || '3000'
      };
      
      isBackingUp = true;
      document.getElementById('backup-btn').disabled = true;
      document.getElementById('backup-btn').textContent = 'Backing up...';
      document.getElementById('cancel-btn').textContent = 'Stop';
      document.getElementById('status').classList.add('visible');
      document.getElementById('status').classList.remove('error', 'success');
      
      ipcRenderer.send('start-desktop-backup', config);
    }
    
    function showError(msg) {
      const status = document.getElementById('status');
      status.classList.add('visible', 'error');
      document.getElementById('status-text').textContent = msg;
      setTimeout(() => {
        status.classList.remove('visible', 'error');
      }, 3000);
    }
    
    ipcRenderer.on('backup-progress', (event, data) => {
      document.getElementById('status-text').textContent = data.message;
      document.getElementById('progress-fill').style.width = (data.progress * 100) + '%';
    });
    
    ipcRenderer.on('backup-complete', (event, data) => {
      isBackingUp = false;
      document.getElementById('status').classList.add('success');
      document.getElementById('status-text').textContent = data.message;
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('backup-btn').disabled = true;
      document.getElementById('backup-btn').textContent = 'Done';
      document.getElementById('cancel-btn').textContent = 'Close';
    });
    
    ipcRenderer.on('backup-error', (event, data) => {
      isBackingUp = false;
      document.getElementById('status').classList.add('error');
      document.getElementById('status-text').textContent = data.message;
      document.getElementById('backup-btn').disabled = false;
      document.getElementById('backup-btn').textContent = 'Retry';
      document.getElementById('cancel-btn').textContent = 'Close';
    });
  </script>
</body>
</html>`;
  
  backupWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  
  backupWindow.on('closed', () => {
    backupWindow = null;
  });
  
  backupWindow.setMenuBarVisibility(false);
}

// IPC handlers for backup
let activeBackupClient = null;

ipcMain.on('start-desktop-backup', async (event, config) => {
  try {
    // Save credentials for next time
    store.set('backupCredentials', {
      email: config.email,
      password: config.password,
      remoteAddress: config.remoteAddress,
      remotePort: config.remotePort
    });
    
    // For StealthCloud, check subscription first
    if (config.destination === 'stealthcloud') {
      const { DesktopBackupClient } = require('./backup-client');
      const checkClient = new DesktopBackupClient(config, (progress) => {
        event.reply('backup-progress', progress);
      });
      
      // Login first to get token
      await checkClient.login();
      
      // Check subscription status
      const subStatus = await checkClient.checkSubscription();
      
      if (!subStatus.allowed) {
        // Show branded notification about subscription
        try {
          new Notification({
            title: 'PhotoLynk Subscription Required',
            body: subStatus.reason || 'Open PhotoLynk on your mobile device to subscribe.',
            silent: false
          }).show();
        } catch (e) {
          // Notification may fail on some systems
        }
        
        event.reply('backup-error', { 
          message: subStatus.reason || 'Subscription required. Open PhotoLynk on your mobile device to subscribe.',
          code: 'SUBSCRIPTION_REQUIRED'
        });
        return;
      }
      
      // Store subscription info for space check later
      config._subscriptionStatus = subStatus;
      
      // Show subscription info
      const planLabel = subStatus.planGb === 1000 ? '1 TB' : (subStatus.planGb + ' GB');
      event.reply('backup-progress', { 
        message: `Subscription active (${planLabel} plan)`, 
        progress: 0.04 
      });
    }
    
    event.reply('backup-progress', { message: 'Scanning for photos and videos...', progress: 0.05 });
    
    // Scan folders for media files
    const mediaFiles = [];
    const extensions = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf',
                        '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.webm'];
    
    for (const folder of config.folders) {
      try {
        scanFolder(folder, mediaFiles, extensions);
      } catch (e) {
        safeConsole('error', 'Error scanning folder:', folder, e);
      }
    }
    
    event.reply('backup-progress', { 
      message: 'Found ' + mediaFiles.length + ' files to backup...', 
      progress: 0.1 
    });
    
    if (mediaFiles.length === 0) {
      event.reply('backup-complete', { message: 'No media files found in selected folders.' });
      return;
    }
    
    // Start actual backup with encryption and chunking
    const { DesktopBackupClient } = require('./backup-client');
    
    activeBackupClient = new DesktopBackupClient(config, (progress) => {
      event.reply('backup-progress', progress);
    });

    if (config.destination === 'stealthcloud') {
      startBackupPowerSaveBlocker();
      event.reply('backup-progress', {
        message: 'Keeping this computer awake while backing up to StealthCloud (screen may turn off as usual)...',
        progress: 0.11
      });
    }
    
    const result = await activeBackupClient.backup(mediaFiles);
    activeBackupClient = null;

    stopBackupPowerSaveBlocker();
    
    event.reply('backup-complete', { 
      message: `Backup Complete\nUploaded: ${result.uploaded}\nSkipped: ${result.skipped}\nFailed: ${result.failed}`
    });
    
  } catch (error) {
    safeConsole('error', 'Backup error:', error);
    activeBackupClient = null;

    stopBackupPowerSaveBlocker();

    const code = error && (error.code || error.errorCode);
    if (code === 'INSUFFICIENT_SPACE') {
      const formatBytes = (bytes) => {
        const n = Number(bytes || 0);
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        if (n < 1000) return `${n} B`;
        if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
        if (n < 1000 * 1000 * 1000) return `${(n / (1000 * 1000)).toFixed(1)} MB`;
        return `${(n / (1000 * 1000 * 1000)).toFixed(2)} GB`;
      };

      const requiredStr = formatBytes(error.requiredSpace);
      const remainingStr = formatBytes(error.remainingBytes);

      try {
        new Notification({
          title: 'PhotoLynk - Not Enough Space',
          body: `Need ${requiredStr}, only ${remainingStr} available. Upgrade your plan in the mobile app.`,
          silent: false
        }).show();
      } catch (e) {
        // ignore
      }

      event.reply('backup-error', {
        message: `Not enough cloud storage. Need ${requiredStr}, but only ${remainingStr} available. Upgrade your plan in the PhotoLynk mobile app.`,
        code: 'INSUFFICIENT_SPACE'
      });
      return;
    }

    event.reply('backup-error', { message: (error && error.message) ? error.message : 'Unknown error' });
  }
});

ipcMain.on('cancel-desktop-backup', () => {
  if (activeBackupClient) {
    activeBackupClient.cancel();
  }
  stopBackupPowerSaveBlocker();
});

function scanFolder(folderPath, results, extensions, depth = 0) {
  if (depth > 5) return; // Limit recursion depth
  
  try {
    const items = fs.readdirSync(folderPath);
    for (const item of items) {
      if (item.startsWith('.')) continue; // Skip hidden files
      
      const fullPath = path.join(folderPath, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanFolder(fullPath, results, extensions, depth + 1);
        } else if (stat.isFile()) {
          const ext = path.extname(item).toLowerCase();
          if (extensions.includes(ext)) {
            results.push({
              path: fullPath,
              name: item,
              size: stat.size,
              modified: stat.mtime
            });
          }
        }
      } catch (e) {
        // Skip files we can't access
      }
    }
  } catch (e) {
    // Skip folders we can't read
  }
}

function checkServerRunning(callback) {
  const net = require('net');
  const client = new net.Socket();
  
  client.setTimeout(1000);
  
  client.on('connect', () => {
    client.destroy();
    callback(true);
  });
  
  client.on('error', () => {
    callback(false);
  });
  
  client.on('timeout', () => {
    client.destroy();
    callback(false);
  });
  
  client.connect(3000, '127.0.0.1');
}

function updateTrayMenu() {
  checkServerRunning((isRunning) => {
    const currentVersion = (app && typeof app.getVersion === 'function' ? app.getVersion() : '').trim();
    const ips = getLocalIpAddresses();

    // Build IP submenu
    const ipSubmenu = ips.length > 0
      ? [
          { label: 'Click to copy', enabled: false },
          { type: 'separator' },
          ...ips.map((ip) => ({
            label: ip,
            click: () => {
              clipboard.writeText(ip);
              notifyCopied(ip);
            }
          }))
        ]
      : [{ label: 'No network detected', enabled: false }];

    // Local Server submenu
    const localServerSubmenu = [
      {
        label: isRunning ? '● Running' : '○ Stopped',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Pair Mobile Device (QR)',
        click: showQRCodeWindow
      },
      {
        label: 'View Received Files',
        click: openUploadsFolder
      },
      { type: 'separator' },
      {
        label: 'Network Address',
        submenu: ipSubmenu
      },
      { type: 'separator' },
      {
        label: 'Start',
        click: startServer,
        enabled: !isRunning
      },
      {
        label: 'Restart',
        click: restartServer,
        enabled: isRunning
      },
      {
        label: 'Stop',
        click: stopServer,
        enabled: isRunning
      }
    ];

    // Main menu - clearly separated sections
    const menuTemplate = [
      {
        label: currentVersion ? `PhotoLynk v${currentVersion}` : 'PhotoLynk',
        enabled: false
      },
      { type: 'separator' },
      // Cloud Backup section
      {
        label: 'Backup This PC to StealthCloud',
        click: showBackupWindow
      },
      { type: 'separator' },
      // Local Server section
      {
        label: 'Local Server',
        submenu: localServerSubmenu
      },
      { type: 'separator' },
      // Preferences
      {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: !!startOnBoot,
        click: (menuItem) => {
          setAutostart(!!menuItem.checked);
          updateTrayMenu();
        }
      },
    ];
    
    // Add update menu items
    if (updateAvailable) {
      menuTemplate.push({
        label: `Update Available (v${latestVersion})`,
        click: installUpdate
      });
    } else {
      menuTemplate.push({
        label: 'Check for Updates',
        click: checkForUpdates
      });
    }
    
    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({
      label: 'Quit PhotoLynk',
      click: () => {
        stopServer();
        app.quit();
      }
    });

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    tray.setContextMenu(contextMenu);
    
    // Update tooltip
    let tooltip = currentVersion ? `PhotoLynk Server v${currentVersion}` : 'PhotoLynk Server';
    tooltip += isRunning ? ' — Running' : ' — Stopped';
    if (updateAvailable) {
      tooltip += ` (Update available: v${latestVersion})`;
    }
    tray.setToolTip(tooltip);
  });
}

app.whenReady().then(() => {
  initPaths();
  // Create tray icon
  let trayIcon;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  const macVersion = isMac ? parseInt(require('os').release().split('.')[0], 10) : 0;
  const supportsDarkMode = isMac && macVersion >= 18; // macOS 10.14 Mojave = Darwin 18
  
  if (supportsDarkMode) {
    // Template icon - macOS will auto-invert for dark/light mode
    const templatePath = path.join(__dirname, 'iconTemplate.png');
    const templateIcon = nativeImage.createFromPath(templatePath);
    trayIcon = templateIcon.resize({ width: 22, height: 22 });
    trayIcon.setTemplateImage(true);
  } else if (isWin) {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    trayIcon = icon.resize({ width: 16, height: 16 });
  } else if (isLinux) {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    trayIcon = icon.resize({ width: 24, height: 24 });
  } else {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    trayIcon = icon.resize({ width: 22, height: 22 });
  }
  
  tray = new Tray(trayIcon);
  tray.setToolTip('PhotoLynk Server');
  
  // Update menu when clicked
  tray.on('click', () => {
    updateTrayMenu();
  });
  
  tray.on('right-click', () => {
    updateTrayMenu();
  });
  
  // Load startOnBoot setting and apply autostart configuration once
  startOnBoot = store.get('startOnBoot', false);
  setAutostart(startOnBoot);

  updateTrayMenu();
  
  // Auto-refresh menu every 3 seconds
  setInterval(() => {
    updateTrayMenu();
  }, 3000);
  
  // Start server automatically
  startServer();
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when windows are closed
  e.preventDefault();
});

app.on('before-quit', () => {
  stopBackupPowerSaveBlocker();
  stopServer();
});

// Hide dock icon on macOS
if (process.platform === 'darwin' && app.dock) {
  try {
    app.dock.hide();
  } catch (e) {
    // Ignore - dock may not be available
  }
}
