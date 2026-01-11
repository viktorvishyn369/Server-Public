const { app, Tray, Menu, shell, nativeImage, Notification, clipboard, BrowserWindow, ipcMain, powerSaveBlocker, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Store = require('electron-store');

let tray = null;
let mainWindow = null;
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

// Disable sandbox on Linux to prevent SIGTRAP crashes on Ubuntu 24.04+ / newer kernels
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

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
      const desktopFile = path.join(autostartDir, 'photolynk-server.desktop');
      // Also remove old legacy desktop file if exists
      const oldDesktopFile = path.join(autostartDir, 'photosync-server.desktop');
      if (fs.existsSync(oldDesktopFile)) {
        fs.unlinkSync(oldDesktopFile);
      }

      if (!fs.existsSync(autostartDir)) {
        fs.mkdirSync(autostartDir, { recursive: true });
      }

      if (enabled) {
        const execPath = process.execPath; // points to the built app binary
        const desktopContent = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=PhotoLynk Server',
          `Exec="${execPath}" --no-sandbox`,
          'X-GNOME-Autostart-enabled=true',
          'NoDisplay=false',
          'Terminal=false',
          'Comment=PhotoLynk Desktop Server for photo backup',
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
  const portIsFree = freePort3000ForPhotoLynk();
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

function stopServer(callback) {
  safeConsole('log', 'Stopping server...');
  
  // Kill the server process
  if (serverProcess) {
    try {
      const pid = serverProcess.pid;
      if (process.platform === 'win32' && pid) {
        // Windows: use taskkill to forcefully terminate the process tree
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          safeConsole('log', 'Server process killed via taskkill');
        } catch (e) {
          // taskkill may fail if process already exited
          safeConsole('log', 'taskkill failed (process may have already exited)');
        }
      } else {
        // Unix: use SIGKILL
        serverProcess.kill('SIGKILL');
        safeConsole('log', 'Server process killed via SIGKILL');
      }
      serverProcess = null;
    } catch (e) {
      safeConsole('error', 'Error killing server process:', e);
      serverProcess = null;
    }
  } else {
    safeConsole('log', 'No server process to kill');
  }
  
  freePort3000ForPhotoLynk();
  
  // Update menu after a delay to ensure port is released
  setTimeout(() => {
    updateTrayMenu();
    safeConsole('log', 'Server stopped, port released');
    if (typeof callback === 'function') callback();
  }, 1500);
}

function restartServer() {
  safeConsole('log', 'Restarting server...');
  stopServer(() => {
    safeConsole('log', 'Starting server after stop...');
    setTimeout(() => {
      startServer();
    }, 500);
  });
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
    const agentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.photolynk.server.plist');
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
      execSync('launchctl remove com.photolynk.server', { stdio: 'ignore' });
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

function isPhotoLynkOwnedPid(pid) {
  try {
    const pidStr = String(pid);
    if (!/^\d+$/.test(pidStr)) return false;

    if (process.platform === 'win32') {
      const ps = `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pidStr}').CommandLine"`;
      const cmd = execSync(ps, { encoding: 'utf8' }).toString();
      const hay = String(cmd || '').toLowerCase();
      if (hay.includes('photolynk') && hay.includes('server')) return true;
      if (hay.includes('server.js') && hay.includes('photolynk')) return true;
      return false;
    }

    const cmd = execSync(`ps -p ${pidStr} -o command=`, { encoding: 'utf8' }).toString();
    const hay = String(cmd || '');
    if (hay.includes('PhotoLynk Server.app/Contents/Resources/server/server.js')) return true;
    if (hay.includes('PhotoLynk Server.app/Contents/Resources/server/server.js')) return true;
    if (hay.includes('/PhotoLynk/server/server.js')) return true;
    if (hay.includes('/PhotoLynk/server/server.js')) return true;
    if (hay.includes('com.photolynk.server')) return true;
    if (hay.toLowerCase().includes('photolynk') && hay.includes('server.js')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function freePort3000ForPhotoLynk() {
  const pids = getPort3000Listeners();

  // If the port is in use but we cannot discover any PID (common on Linux without
  // permission to see process info), do NOT attempt to start a second server.
  if (pids.length === 0) return !isPort3000InUse();

  let killedAny = false;
  let foundNonOwnedProcess = false;
  for (const pid of pids) {
    if (!isPhotoLynkOwnedPid(pid)) {
      foundNonOwnedProcess = true;
      continue;
    }
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

  // If we found processes but none were PhotoLynk-owned, port is blocked by another app
  if (!killedAny && foundNonOwnedProcess) return false;
  
  // If no processes were found at all, or we killed them, check if port is now free
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

// ============================================================================
// UNIFIED MAIN WINDOW - Album-style desktop app (replaces dropdown menu)
// ============================================================================

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    return;
  }
  
  const pairingData = getPairingData();
  const credentials = store.get('backupCredentials') || {};
  const photoFolders = store.get('backupFolders') || [];
  const defaultDownloadPath = path.join(os.homedir(), 'Pictures', 'PhotoLynk Sync');
  const savedDownloadPath = store.get('syncDownloadPath') || defaultDownloadPath;
  const currentVersion = (app && typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0').trim();
  
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 420,
    minHeight: 600,
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    title: 'PhotoLynk',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  
  // Generate QR code and build HTML
  const QRCode = require('qrcode');
  const qrDataString = JSON.stringify(pairingData);
  
  // Read icon as base64 for embedding in HTML
  const fs = require('fs');
  const iconPath = path.join(__dirname, 'icon.png');
  const iconBase64 = fs.existsSync(iconPath) ? fs.readFileSync(iconPath).toString('base64') : '';
  const iconDataUrl = iconBase64 ? `data:image/png;base64,${iconBase64}` : '';
  
  QRCode.toDataURL(qrDataString, { width: 180, margin: 2 }, (err, qrUrl) => {
    const qrImage = err ? '' : qrUrl;
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg-primary: #0A0A0A;
      --bg-card: rgba(30, 30, 30, 0.85);
      --bg-input: rgba(26, 26, 26, 0.9);
      --accent: #03E1FF;           /* Solana ocean blue */
      --accent-secondary: #00FFA3; /* Solana bright mint/green */
      --accent-cyan: #03E1FF;      /* Solana ocean blue/cyan */
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --success: #00FFA3;          /* Solana mint green */
      --error: #CF6679;
      --warning: #FFB74D;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); display: flex; flex-direction: column; height: 100vh; }
    .header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-icon { font-size: 24px; }
    .logo-text { font-size: 18px; font-weight: 600; }
    .version { font-size: 11px; color: var(--text-muted); }
    .header-actions { display: flex; gap: 8px; }
    .header-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-secondary); font-size: 11px; cursor: pointer; transition: all 0.2s; }
    .header-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    .content { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; backdrop-filter: blur(10px); }
    .card-title { font-size: 13px; font-weight: 600; color: var(--accent); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .server-status { display: flex; align-items: center; justify-content: space-between; }
    .status-indicator { display: flex; align-items: center; gap: 8px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--error); }
    .status-dot.running { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-text { font-size: 13px; }
    .server-controls { display: flex; gap: 6px; }
    .server-btn { padding: 6px 12px; border: none; border-radius: 6px; font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
    .server-btn.start { background: rgba(3, 218, 198, 0.2); color: var(--success); border: 1px solid rgba(3, 218, 198, 0.4); }
    .server-btn.stop { background: rgba(207, 102, 121, 0.2); color: var(--error); border: 1px solid rgba(207, 102, 121, 0.4); }
    .server-btn.restart { background: rgba(255, 183, 77, 0.2); color: var(--warning); border: 1px solid rgba(255, 183, 77, 0.4); }
    .server-btn:hover { filter: brightness(1.2); }
    .server-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .qr-section { display: flex; gap: 16px; align-items: center; }
    .qr-container { background: #fff; padding: 8px; border-radius: 10px; flex-shrink: 0; }
    .qr-code { width: 120px; height: 120px; display: block; }
    .qr-info { flex: 1; }
    .qr-info h3 { font-size: 14px; margin-bottom: 6px; }
    .qr-info p { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
    .ip-badge { margin-top: 8px; padding: 6px 10px; background: rgba(74, 159, 232, 0.1); border: 1px solid rgba(74, 159, 232, 0.3); border-radius: 6px; font-size: 11px; display: inline-block; }
    .ip-badge span { color: var(--accent-secondary); font-weight: 600; }
    .main-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .action-btn { padding: 20px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card); cursor: pointer; transition: all 0.2s; text-align: center; }
    .action-btn:hover { border-color: var(--accent); background: rgba(74, 159, 232, 0.1); }
    .action-btn.backup { border-color: rgba(74, 159, 232, 0.4); }
    .action-btn.backup:hover { border-color: var(--accent); box-shadow: 0 0 20px rgba(74, 159, 232, 0.2); }
    .action-btn.sync { border-color: rgba(3, 218, 198, 0.4); }
    .action-btn.sync:hover { border-color: var(--accent-secondary); box-shadow: 0 0 20px rgba(3, 218, 198, 0.2); }
    .action-icon { font-size: 28px; margin-bottom: 8px; }
    .action-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .action-subtitle { font-size: 11px; color: var(--text-secondary); }
    .form-row { display: flex; gap: 10px; margin-bottom: 10px; }
    .form-row:last-child { margin-bottom: 0; }
    .form-group { flex: 1; }
    .form-group label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
    .form-group input, .form-group select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--text-primary); font-size: 13px; }
    .form-group input:focus, .form-group select:focus { outline: none; border-color: rgba(74, 159, 232, 0.6); }
    .form-group input::placeholder { color: var(--text-muted); }
    .folder-list { max-height: 80px; overflow-y: auto; margin-bottom: 8px; }
    .folder-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--bg-input); border-radius: 4px; margin-bottom: 4px; font-size: 11px; color: var(--text-secondary); }
    .folder-item button { background: none; border: none; color: var(--error); cursor: pointer; padding: 2px 6px; }
    .folder-actions { display: flex; gap: 6px; }
    .folder-btn { flex: 1; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
    .folder-btn:hover { background: rgba(255,255,255,0.1); }
    .status-bar { padding: 8px 20px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-muted); display: flex; justify-content: space-between; flex-shrink: 0; }
    .progress-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 100; align-items: center; justify-content: center; }
    .progress-overlay.visible { display: flex; }
    .progress-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; width: 300px; text-align: center; }
    .progress-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    .progress-text { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
    .progress-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width 0.3s; }
    .progress-cancel { margin-top: 16px; padding: 8px 20px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; }
    #remote-config { display: none; }
    #remote-config.visible { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <img class="logo-icon" src="${iconDataUrl}" width="24" height="24" style="border-radius: 4px;">
      <span class="logo-text">PhotoLynk</span>
      <span class="version">v${currentVersion || '1.0.0'}</span>
    </div>
    <div class="header-actions">
      <button class="header-btn" onclick="checkUpdates()">Check Updates</button>
      <button class="header-btn" onclick="toggleAutostart()">
        <span id="autostart-label">${startOnBoot ? '✓ Launch at Login' : 'Launch at Login'}</span>
      </button>
    </div>
  </div>
  
  <div class="content">
    <div class="card">
      <div class="card-title">🖥️ Local Server</div>
      <div class="server-status">
        <div class="status-indicator">
          <div class="status-dot" id="server-dot"></div>
          <span class="status-text" id="server-status">Checking...</span>
        </div>
        <div class="server-controls">
          <button class="server-btn start" id="btn-start" onclick="serverControl('start')">Start</button>
          <button class="server-btn restart" id="btn-restart" onclick="serverControl('restart')">Restart</button>
          <button class="server-btn stop" id="btn-stop" onclick="serverControl('stop')">Stop</button>
        </div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-title">📱 Pair Mobile Device</div>
      <div class="qr-section">
        <div class="qr-container">
          <img class="qr-code" src="${qrImage}" alt="QR Code">
        </div>
        <div class="qr-info">
          <h3>Scan to Connect</h3>
          <p>Open PhotoLynk on your phone, select "Local" server, and scan this QR code.</p>
          <div class="ip-badge">Server: <span>${pairingData.ip}:${pairingData.port}</span></div>
        </div>
      </div>
    </div>
    
    <div class="main-actions">
      <div class="action-btn backup" onclick="startBackup()">
        <div class="action-icon">⬆️</div>
        <div class="action-title">Backup</div>
        <div class="action-subtitle">Upload to Cloud</div>
      </div>
      <div class="action-btn sync" onclick="startSync()">
        <div class="action-icon">⬇️</div>
        <div class="action-title">Sync</div>
        <div class="action-subtitle">Download from Cloud</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-title">🔐 Cloud Credentials</div>
      <div class="form-row">
        <div class="form-group">
          <label>Destination</label>
          <select id="destination" onchange="toggleRemoteConfig()">
            <option value="stealthcloud" selected>StealthCloud</option>
            <option value="remote">Remote Server</option>
          </select>
        </div>
      </div>
      <div id="remote-config">
        <div class="form-row">
          <div class="form-group" style="flex:2"><label>Address</label><input type="text" id="remote-address" placeholder="192.168.1.100" value="${credentials.remoteAddress || ''}"></div>
          <div class="form-group" style="flex:1"><label>Port</label><input type="text" id="remote-port" placeholder="3000" value="${credentials.remotePort || '3000'}"></div>
        </div>
      </div>
      <div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="email" placeholder="your@email.com" value="${credentials.email || ''}"></div></div>
      <div class="form-row"><div class="form-group"><label>Password</label><input type="password" id="password" placeholder="Password" value="${credentials.password || ''}"></div></div>
    </div>
    
    <div class="card">
      <div class="card-title">📤 Source Folders (Upload FROM)</div>
      <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 8px;">Photos & videos from these folders will be uploaded to cloud</div>
      <div class="folder-list" id="folder-list">${photoFolders.length === 0 ? '<div style="color: var(--text-muted); padding: 8px; text-align: center;">No folders selected - click "Add Folder" below</div>' : photoFolders.map((f, i) => '<div class="folder-item"><span title="' + f + '">' + f.split('/').pop() + '</span><button onclick="removeFolder(' + i + ')">✕</button></div>').join('')}</div>
      <div class="folder-actions">
        <button class="folder-btn" onclick="addFolder()">+ Add Folder</button>
        <button class="folder-btn" onclick="clearFolders()">Clear All</button>
      </div>
    </div>
    
    <div class="card">
      <div class="card-title">💾 Local Server Storage (Sync TO)</div>
      <div style="color: var(--text-muted); font-size: 11px; margin-bottom: 8px;">Files backed up from mobile devices are stored here (enter email & password to see your folder)</div>
      <div class="form-row">
        <div class="form-group" style="flex: 1;"><input type="text" id="uploads-path" value="${uploadsPath}" readonly style="font-size: 11px; cursor: text; user-select: all;"></div>
        <button class="folder-btn" style="flex: 0; padding: 10px 16px;" onclick="copyUploadsPath()" title="Copy path">Copy</button>
        <button class="folder-btn" style="flex: 0; padding: 6px 12px; line-height: 1.2; text-align: center;" onclick="addUploadsToSources()">Add to<br>Sources</button>
        <button class="folder-btn" style="flex: 0; padding: 10px 16px;" onclick="openUploadsFolder()">Open</button>
      </div>
    </div>
  </div>
  
  <div class="status-bar">
    <span id="status-message">Ready</span>
    <span id="update-status">${updateAvailable ? 'Update available: v' + latestVersion : ''}</span>
  </div>
  
  <div class="progress-overlay" id="progress-overlay">
    <div class="progress-box">
      <div class="progress-title" id="progress-title">Processing...</div>
      <div class="progress-text" id="progress-text">Preparing...</div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <button class="progress-cancel" onclick="cancelOperation()">Cancel</button>
    </div>
  </div>
  
  <script>
    const { ipcRenderer } = require('electron');
    let selectedFolders = ${JSON.stringify(photoFolders)};
    let serverBusy = false;
    
    function updateServerStatus(running) {
      document.getElementById('server-dot').classList.toggle('running', running);
      document.getElementById('server-status').textContent = running ? 'Running' : 'Stopped';
      // Re-enable buttons based on state
      serverBusy = false;
      document.getElementById('btn-start').disabled = running;
      document.getElementById('btn-restart').disabled = !running;
      document.getElementById('btn-stop').disabled = !running;
    }
    
    function setButtonsBusy(busy, statusText) {
      serverBusy = busy;
      document.getElementById('btn-start').disabled = busy;
      document.getElementById('btn-restart').disabled = busy;
      document.getElementById('btn-stop').disabled = busy;
      if (statusText) document.getElementById('server-status').textContent = statusText;
    }
    
    function serverControl(action) {
      if (serverBusy) return;
      if (action === 'start') setButtonsBusy(true, 'Starting...');
      else if (action === 'stop') setButtonsBusy(true, 'Stopping...');
      else if (action === 'restart') setButtonsBusy(true, 'Restarting...');
      ipcRenderer.send('server-control', action);
    }
    function checkUpdates() { ipcRenderer.send('check-updates'); }
    function toggleAutostart() { ipcRenderer.send('toggle-autostart'); }
    function toggleRemoteConfig() { document.getElementById('remote-config').classList.toggle('visible', document.getElementById('destination').value === 'remote'); }
    
    ipcRenderer.on('server-status', (e, running) => updateServerStatus(running));
    ipcRenderer.on('autostart-changed', (e, enabled) => { document.getElementById('autostart-label').textContent = enabled ? '✓ Launch at Login' : 'Launch at Login'; });
    ipcRenderer.on('update-available', (e, version) => { document.getElementById('update-status').textContent = 'Update available: v' + version; });
    ipcRenderer.send('get-server-status');
    
    function renderFolders() {
      const list = document.getElementById('folder-list');
      list.innerHTML = selectedFolders.length === 0 ? '<div style="color: var(--text-muted); padding: 8px; text-align: center;">No folders selected</div>' : selectedFolders.map((f, i) => '<div class="folder-item"><span title="' + f + '">' + f.split('/').pop() + '</span><button onclick="removeFolder(' + i + ')">✕</button></div>').join('');
    }
    
    async function addFolder() {
      const paths = await ipcRenderer.invoke('select-folder');
      if (paths && paths.length > 0) { paths.forEach(p => { if (!selectedFolders.includes(p)) selectedFolders.push(p); }); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    }
    function removeFolder(i) { selectedFolders.splice(i, 1); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    function clearFolders() { selectedFolders = []; ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    const baseUploadsPath = "${uploadsPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
    
    // Compute UUID v5 from email:password (same algorithm as mobile apps and sync)
    function computeUserUuid(email, password) {
      if (!email || !password) return null;
      const normalizedEmail = email.trim().toLowerCase();
      const input = normalizedEmail + ':' + password;
      // Simple SHA-1 based UUID v5 computation (matches server-side)
      const crypto = require('crypto');
      const namespaceBytes = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
      const hash = crypto.createHash('sha1');
      hash.update(namespaceBytes);
      hash.update(input);
      const bytes = hash.digest();
      bytes[6] = (bytes[6] & 0x0f) | 0x50;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.slice(0, 16).toString('hex');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    }
    
    function getUserUploadsPath() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const uuid = computeUserUuid(email, password);
      if (uuid) {
        return baseUploadsPath + (baseUploadsPath.includes('\\\\') ? '\\\\' : '/') + uuid;
      }
      return baseUploadsPath;
    }
    
    function updateUploadsPathDisplay() {
      const pathEl = document.getElementById('uploads-path');
      pathEl.value = getUserUploadsPath();
    }
    
    // Update path when email or password changes
    document.getElementById('email').addEventListener('input', updateUploadsPathDisplay);
    document.getElementById('password').addEventListener('input', updateUploadsPathDisplay);
    updateUploadsPathDisplay(); // Initial update
    
    function openUploadsFolder() { ipcRenderer.send('open-folder', getUserUploadsPath()); }
    function copyUploadsPath() { 
      const pathToCopy = getUserUploadsPath();
      const btn = event.target;
      const originalText = btn.textContent;
      
      const showCopied = () => {
        btn.textContent = 'Copied!';
        btn.style.backgroundColor = 'var(--success)';
        btn.style.color = '#000';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.backgroundColor = '';
          btn.style.color = '';
        }, 1500);
      };
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pathToCopy).then(showCopied).catch(e => console.error('Copy failed:', e));
      } else {
        const ta = document.createElement('textarea');
        ta.value = pathToCopy;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showCopied();
      }
    }
    function addUploadsToSources() { const p = getUserUploadsPath(); if (p && !selectedFolders.includes(p)) { selectedFolders.push(p); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); } }
    
    function getConfig() {
      const downloadPath = getUserUploadsPath(); // Use computed path with UUID, not input value
      console.log('[getConfig] downloadPath:', downloadPath);
      return { destination: document.getElementById('destination').value, source: document.getElementById('destination').value, email: document.getElementById('email').value, password: document.getElementById('password').value, remoteAddress: document.getElementById('remote-address').value, remotePort: document.getElementById('remote-port').value || '3000', folders: selectedFolders, downloadPath: downloadPath };
    }
    
    function startBackup() {
      const config = getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      if (selectedFolders.length === 0) { alert('Please add at least one folder to backup'); return; }
      currentOperation = 'backup';
      document.getElementById('progress-title').textContent = 'Backing Up...';
      document.getElementById('progress-overlay').classList.add('visible');
      ipcRenderer.send('start-desktop-backup', config);
    }
    
    function startSync() {
      const config = getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      currentOperation = 'sync';
      document.getElementById('progress-title').textContent = 'Syncing...';
      document.getElementById('progress-overlay').classList.add('visible');
      ipcRenderer.send('start-desktop-sync', config);
    }
    
    function cancelOperation() {
      ipcRenderer.send(currentOperation === 'backup' ? 'cancel-desktop-backup' : 'cancel-desktop-sync');
      document.getElementById('progress-text').textContent = 'Cancelling...';
    }
    
    ipcRenderer.on('backup-progress', (e, d) => { document.getElementById('progress-text').textContent = d.message; document.getElementById('progress-fill').style.width = (d.progress * 100) + '%'; });
    ipcRenderer.on('backup-complete', (e, d) => { document.getElementById('progress-text').textContent = d.message; document.getElementById('progress-fill').style.width = '100%'; setTimeout(() => document.getElementById('progress-overlay').classList.remove('visible'), 2000); });
    ipcRenderer.on('backup-error', (e, d) => { document.getElementById('progress-text').textContent = 'Error: ' + d.message; document.getElementById('progress-fill').style.background = 'var(--error)'; setTimeout(() => { document.getElementById('progress-overlay').classList.remove('visible'); document.getElementById('progress-fill').style.background = 'var(--accent)'; }, 3000); });
    ipcRenderer.on('sync-progress', (e, d) => { document.getElementById('progress-text').textContent = d.message; document.getElementById('progress-fill').style.width = (d.progress * 100) + '%'; });
    ipcRenderer.on('sync-complete', (e, d) => { document.getElementById('progress-text').textContent = d.message; document.getElementById('progress-fill').style.width = '100%'; setTimeout(() => document.getElementById('progress-overlay').classList.remove('visible'), 2000); });
    ipcRenderer.on('sync-error', (e, d) => { document.getElementById('progress-text').textContent = 'Error: ' + d.message; document.getElementById('progress-fill').style.background = 'var(--error)'; setTimeout(() => { document.getElementById('progress-overlay').classList.remove('visible'); document.getElementById('progress-fill').style.background = 'var(--accent)'; }, 3000); });
  </script>
</body>
</html>`;
    
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
  
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('ready-to-show', () => { mainWindow.show(); });
  mainWindow.setMenuBarVisibility(false);
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
      --accent: #03E1FF;           /* Solana ocean blue */
      --accent-secondary: #00FFA3; /* Solana bright mint/green */
      --accent-cyan: #03E1FF;      /* Solana ocean blue/cyan */
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --glow-white: 0 2px 12px rgba(255, 255, 255, 0.08);
      --glow-accent: 0 2px 10px rgba(3, 225, 255, 0.25);
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
  const parentWindow = mainWindow || backupWindow;
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select Folders to Backup'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

// IPC handler for sync folder selection
ipcMain.handle('select-sync-folder', async () => {
  const parentWindow = mainWindow || null;
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Download Location'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = result.filePaths[0];
  store.set('syncDownloadPath', selectedPath);
  return selectedPath;
});

ipcMain.on('save-backup-folders', (event, folders) => {
  store.set('backupFolders', folders);
});

ipcMain.on('open-folder', (event, folderPath) => {
  if (folderPath && typeof folderPath === 'string') {
    shell.openPath(folderPath);
  }
});

ipcMain.on('get-backup-folders', (event) => {
  const folders = store.get('backupFolders') || [];
  event.reply('backup-folders', folders);
});

// IPC handlers for server control from main window
ipcMain.on('server-control', (event, action) => {
  safeConsole('log', 'Server control action:', action);
  if (action === 'start') {
    startServer();
    setTimeout(() => {
      checkServerRunning((running) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server-status', running);
        }
      });
    }, 2500);
  } else if (action === 'stop') {
    stopServer(() => {
      checkServerRunning((running) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server-status', running);
        }
      });
    });
  } else if (action === 'restart') {
    stopServer(() => {
      safeConsole('log', 'Restart: starting server after stop...');
      setTimeout(() => {
        startServer();
        setTimeout(() => {
          checkServerRunning((running) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('server-status', running);
            }
          });
        }, 2500);
      }, 500);
    });
  }
});

ipcMain.on('get-server-status', (event) => {
  checkServerRunning((running) => {
    event.reply('server-status', running);
  });
});

ipcMain.on('check-updates', () => {
  checkForUpdates();
});

ipcMain.on('toggle-autostart', (event) => {
  startOnBoot = !startOnBoot;
  setAutostart(startOnBoot);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('autostart-changed', startOnBoot);
  }
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
      --accent: #03E1FF;           /* Solana ocean blue */
      --accent-hover: #02C4E0;
      --accent-secondary: #00FFA3; /* Solana bright mint/green */
      --accent-cyan: #03E1FF;      /* Solana ocean blue/cyan */
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --success: #00FFA3;          /* Solana mint green */
      --error: #CF6679;
      --glow-white: 0 2px 12px rgba(255, 255, 255, 0.08);
      --glow-accent: 0 2px 10px rgba(3, 225, 255, 0.25);
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
    
    // Combine skipped + failed into single "Skipped" count for cleaner UI
    const totalSkipped = (result.skipped || 0) + (result.failed || 0);
    event.reply('backup-complete', { 
      message: `Backup Complete\nUploaded: ${result.uploaded}\nSkipped: ${totalSkipped}`
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

// IPC handlers for sync
let activeSyncClient = null;

ipcMain.on('start-desktop-sync', async (event, config) => {
  try {
    store.set('backupCredentials', {
      email: config.email,
      password: config.password,
      remoteAddress: config.remoteAddress,
      remotePort: config.remotePort
    });
    
    // downloadPath already contains user UUID from UI (getUserUploadsPath)
    safeConsole('log', `[SYNC] Saving to: ${config.downloadPath}`);
    store.set('syncDownloadPath', config.downloadPath);
    
    event.reply('sync-progress', { message: 'Connecting...', progress: 0.02 });
    
    if (!fs.existsSync(config.downloadPath)) {
      fs.mkdirSync(config.downloadPath, { recursive: true });
    }
    
    const { DesktopSyncClient } = require('./sync-client');
    activeSyncClient = new DesktopSyncClient(config, (progress) => {
      event.reply('sync-progress', progress);
    });
    
    startBackupPowerSaveBlocker();
    
    const result = await activeSyncClient.sync();
    activeSyncClient = null;
    
    stopBackupPowerSaveBlocker();
    
    event.reply('sync-complete', {
      message: `Sync Complete\nDownloaded: ${result.downloaded}\nSkipped: ${result.skipped}`
    });
    
  } catch (error) {
    safeConsole('error', 'Sync error:', error);
    activeSyncClient = null;
    stopBackupPowerSaveBlocker();
    event.reply('sync-error', { message: (error && error.message) ? error.message : 'Unknown error' });
  }
});

ipcMain.on('cancel-desktop-sync', () => {
  if (activeSyncClient) {
    activeSyncClient.cancel();
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

// Old dropdown menu removed - now using unified main window
// This function is kept as a no-op for backward compatibility with existing calls
function updateTrayMenu() {
  // No-op: dropdown menu replaced by unified main window
  // Tooltip is updated separately in the periodic interval
}

app.whenReady().then(() => {
  initPaths();
  
  // Check if this is the first run
  const isFirstRun = !store.get('hasRunBefore');
  if (isFirstRun) {
    store.set('hasRunBefore', true);
  }
  
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
  
  // Left-click opens the main window (unified app UI)
  tray.on('click', () => {
    showMainWindow();
  });
  
  // Right-click shows a minimal context menu with Quit option
  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open PhotoLynk', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; stopServer(); app.quit(); } }
    ]);
    tray.popUpContextMenu(contextMenu);
  });
  
  // Load startOnBoot setting and apply autostart configuration once
  startOnBoot = store.get('startOnBoot', false);
  setAutostart(startOnBoot);

  // Update tray tooltip periodically
  setInterval(() => {
    checkServerRunning((isRunning) => {
      const ver = (app && typeof app.getVersion === 'function' ? app.getVersion() : '').trim();
      let tooltip = ver ? `PhotoLynk v${ver}` : 'PhotoLynk';
      tooltip += isRunning ? ' — Running' : ' — Stopped';
      if (updateAvailable) tooltip += ` (Update: v${latestVersion})`;
      tray.setToolTip(tooltip);
    });
  }, 5000);
  
  // Start server automatically
  startServer();
  
  // On first run, open the main window and show system tray info
  if (isFirstRun) {
    setTimeout(() => {
      showMainWindow();
      
      // Show platform-specific system tray info dialog
      let trayLocation = '';
      if (isMac) {
        trayLocation = 'the menu bar (top-right of your screen)';
      } else if (isWin) {
        trayLocation = 'the system tray (bottom-right, near the clock)';
      } else {
        trayLocation = 'the system tray';
      }
      
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Welcome to PhotoLynk',
        message: 'PhotoLynk runs in the background',
        detail: `When you close this window, PhotoLynk will continue running in ${trayLocation}.\n\nClick the PhotoLynk icon there anytime to open this window again.`,
        buttons: ['Got it'],
        defaultId: 0
      });
    }, 500);
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when windows are closed
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackupPowerSaveBlocker();
  
  // Synchronously kill server process on quit to ensure cleanup
  if (serverProcess) {
    try {
      const pid = serverProcess.pid;
      if (process.platform === 'win32' && pid) {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else if (pid) {
        process.kill(pid, 'SIGKILL');
      }
    } catch (e) {
      // Ignore - process may have already exited
    }
    serverProcess = null;
  }
  
  // Also free port 3000 synchronously
  freePort3000ForPhotoLynk();
});

// Hide dock icon on macOS
if (process.platform === 'darwin' && app.dock) {
  try {
    app.dock.hide();
  } catch (e) {
    // Ignore - dock may not be available
  }
}
