const { app, Tray, Menu, shell, nativeImage, Notification, clipboard, BrowserWindow, ipcMain, powerSaveBlocker, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const Store = require('electron-store');
const nftDesktop = require('./nftDesktop');

let tray = null;
let mainWindow = null;
let qrWindow = null;
let backupWindow = null;
let serverProcess = null;
let pairingServer = null;
const PAIRING_PORT = 3001;
let stoppingServer = false;
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
  if (serverProcess || stoppingServer) {
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
  
  // Verify server.js exists
  if (!fs.existsSync(serverEntry)) {
    safeConsole('error', 'Server entry not found:', serverEntry);
    return;
  }
  safeConsole('log', 'Server entry found:', serverEntry);
  
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
    CLOUD_DIR: path.join(getDataRoot(), 'cloud')
  };

  // Always use Electron's bundled Node - all dependencies are bundled in app
  const nodeExecutable = process.execPath;
  env.ELECTRON_RUN_AS_NODE = '1';
  safeConsole('log', 'Using bundled Electron Node:', nodeExecutable);
  
  safeConsole('log', 'Spawning server with:', nodeExecutable, serverEntry);
  
  serverProcess = spawn(nodeExecutable, [serverEntry], {
    cwd: serverPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true // Hide console window on Windows
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
    // Auto-restart on error after delay
    if (!stoppingServer && !app.isQuitting) {
      safeConsole('log', 'Auto-restarting server after error in 3 seconds...');
      setTimeout(() => {
        if (!serverProcess && !stoppingServer && !app.isQuitting) {
          startServer();
        }
      }, 3000);
    }
  });

  serverProcess.on('close', (code) => {
    safeConsole('log', `Server process exited with code ${code}`);
    serverProcess = null;
    updateTrayMenu();
    // Auto-restart on unexpected exit (code !== 0 or null means crash/error)
    if (!stoppingServer && !app.isQuitting) {
      safeConsole('log', 'Auto-restarting server after exit in 3 seconds...');
      setTimeout(() => {
        if (!serverProcess && !stoppingServer && !app.isQuitting) {
          startServer();
        }
      }, 3000);
    }
  });

  // Update menu after a delay to ensure server is fully started
  setTimeout(() => {
    updateTrayMenu();
  }, 2000);
}

function stopServer(callback) {
  if (stoppingServer) {
    safeConsole('log', 'Stop already in progress');
    return;
  }

  stoppingServer = true;
  safeConsole('log', 'Stopping server...');

  const waitForExit = () => new Promise((resolve) => {
    if (!serverProcess) return resolve();
    const proc = serverProcess;
    const timer = setTimeout(() => {
      try {
        const pid = proc.pid;
        if (pid) {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        }
      } catch (e) {
        safeConsole('log', 'Force kill after timeout');
      }
      resolve();
    }, 1500);

    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const killProcess = () => {
    if (!serverProcess) {
      safeConsole('log', 'No server process to kill');
      return;
    }
    try {
      const pid = serverProcess.pid;
      if (process.platform === 'win32' && pid) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          safeConsole('log', 'Server process killed via taskkill');
        } catch (e) {
          safeConsole('log', 'taskkill failed (process may have already exited)');
        }
      } else {
        serverProcess.kill('SIGKILL');
        safeConsole('log', 'Server process killed via SIGKILL');
      }
    } catch (e) {
      safeConsole('error', 'Error killing server process:', e);
    }
  };

  killProcess();

  waitForExit().then(() => {
    serverProcess = null;
    freePort3000ForPhotoLynk();
    updateTrayMenu();
    safeConsole('log', 'Server stopped, port released');
    stoppingServer = false;
    if (typeof callback === 'function') callback();
  }).catch(() => {
    serverProcess = null;
    stoppingServer = false;
    freePort3000ForPhotoLynk();
    updateTrayMenu();
    if (typeof callback === 'function') callback();
  });
}

function restartServer() {
  safeConsole('log', 'Restarting server...');
  stopServer(() => {
    safeConsole('log', 'Starting server after stop...');
    startServer();
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
      // Use wmic which is faster and more reliable than PowerShell
      try {
        const cmd = execSync(`wmic process where "ProcessId=${pidStr}" get CommandLine,ExecutablePath /format:list`, { encoding: 'utf8', timeout: 3000 }).toString();
        const hay = String(cmd || '').toLowerCase();
        // Check for PhotoLynk Desktop executable or server.js in command line
        if (hay.includes('photolynk desktop')) return true;
        if (hay.includes('photolynk-server-tray')) return true;
        if (hay.includes('server.js') && hay.includes('photolynk')) return true;
        if (hay.includes('server.js') && hay.includes('resources\\server')) return true;
        return false;
      } catch (e) {
        // wmic failed, try tasklist
        try {
          const out = execSync(`tasklist /FI "PID eq ${pidStr}" /FO CSV /NH`, { encoding: 'utf8', timeout: 3000 }).toString();
          const hay = String(out || '').toLowerCase();
          if (hay.includes('photolynk')) return true;
          return false;
        } catch (e2) {
          return false;
        }
      }
    }

    const cmd = execSync(`ps -p ${pidStr} -o command=`, { encoding: 'utf8' }).toString();
    const hay = String(cmd || '');
    if (hay.includes('PhotoLynk Server.app/Contents/Resources/server/server.js')) return true;
    if (hay.includes('PhotoLynk Desktop.app/Contents/Resources/server/server.js')) return true;
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
  safeConsole('log', 'Port 3000 listeners found:', pids.length > 0 ? pids.join(', ') : 'none');

  // If the port is in use but we cannot discover any PID (common on Linux without
  // permission to see process info), do NOT attempt to start a second server.
  if (pids.length === 0) {
    const inUse = isPort3000InUse();
    safeConsole('log', 'No PIDs found, port 3000 in use:', inUse);
    return !inUse;
  }

  let killedAny = false;
  let foundNonOwnedProcess = false;
  for (const pid of pids) {
    const isOwned = isPhotoLynkOwnedPid(pid);
    safeConsole('log', 'PID', pid, 'is PhotoLynk owned:', isOwned);
    if (!isOwned) {
      foundNonOwnedProcess = true;
      continue;
    }
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
      killedAny = true;
      safeConsole('log', 'Stopped PhotoLynk listener on port 3000 (PID:', pid, ')');
    } catch (e) {
      safeConsole('log', 'Failed to kill PID', pid, ':', e.message);
    }
  }

  // If we found processes but none were PhotoLynk-owned, port is blocked by another app
  if (!killedAny && foundNonOwnedProcess) {
    safeConsole('log', 'Port 3000 blocked by non-PhotoLynk process');
    return false;
  }
  
  // If no processes were found at all, or we killed them, check if port is now free
  const remaining = getPort3000Listeners();
  safeConsole('log', 'Remaining listeners after cleanup:', remaining.length > 0 ? remaining.join(', ') : 'none');
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

// Compute UUID v5 from email:password (matches mobile app's uuid library)
// UUID v5 = SHA-1(namespace + name) with version/variant bits set
function computeUserUuidSync(email, password) {
  if (!email || !password) return null;
  const normalizedEmail = email.trim().toLowerCase();
  const name = normalizedEmail + ':' + password;
  
  // DNS namespace UUID: 6ba7b810-9dad-11d1-80b4-00c04fd430c8 (same as mobile)
  const namespaceBytes = Buffer.from([
    0x6b, 0xa7, 0xb8, 0x10,
    0x9d, 0xad,
    0x11, 0xd1,
    0x80, 0xb4,
    0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8
  ]);
  
  // UUID v5: SHA-1(namespace + name)
  const hash = crypto.createHash('sha1')
    .update(namespaceBytes)
    .update(name)
    .digest();
  
  // Apply UUID v5 version (0101xxxx) and variant (10xxxxxx) bits
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  
  const hex = hash.slice(0, 16).toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
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
    pairingPort: PAIRING_PORT,
    token: pairingToken,
    name: os.hostname() || 'PhotoLynk Server'
  };
}

// ============================================================================
// REFRESH QR CODE IN MAIN WINDOW - Called after pairing to update with new token
// ============================================================================

function refreshQRCodeInMainWindow() {
  const QRCode = require('qrcode');
  const pairingData = getPairingData();
  const qrDataString = JSON.stringify(pairingData);
  
  // Refresh in main window (small QR) - preload new image before swapping
  if (mainWindow && !mainWindow.isDestroyed()) {
    QRCode.toDataURL(qrDataString, { width: 180, margin: 2 }, (err, qrUrl) => {
      if (err) {
        safeConsole('error', '[Pairing] Failed to regenerate QR code:', err);
        return;
      }
      
      // Preload image then swap instantly - no flicker
      mainWindow.webContents.executeJavaScript(`
        (function() {
          var newImg = new Image();
          newImg.onload = function() {
            var qrImg = document.querySelector('.qr-code');
            if (qrImg) qrImg.src = '${qrUrl}';
          };
          newImg.src = '${qrUrl}';
        })();
      `);
      
      safeConsole('log', '[Pairing] QR code refreshed in main window');
    });
  }
  
  // Also refresh in separate QR window if open (large QR)
  if (qrWindow && !qrWindow.isDestroyed()) {
    QRCode.toDataURL(qrDataString, { width: 280, margin: 2 }, (err, qrUrl) => {
      if (err) return;
      
      qrWindow.webContents.executeJavaScript(`
        (function() {
          var newImg = new Image();
          newImg.onload = function() {
            var qrImg = document.querySelector('.qr-code');
            if (qrImg) qrImg.src = '${qrUrl}';
          };
          newImg.src = '${qrUrl}';
        })();
      `);
      
      safeConsole('log', '[Pairing] QR code refreshed in QR window');
    });
  }
}

// ============================================================================
// PAIRING HTTP SERVER - Receives credentials from mobile during QR pairing
// ============================================================================

function startPairingServer() {
  if (pairingServer) return;
  
  pairingServer = http.createServer((req, res) => {
    // CORS headers for mobile app
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method === 'POST' && req.url === '/api/pair') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { email, password, token } = data;
          
          // Validate pairing token
          const storedToken = store.get('pairingToken');
          if (!token || token !== storedToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid pairing token' }));
            return;
          }
          
          if (!email || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Email and password required' }));
            return;
          }
          
          // Store credentials securely
          store.set('backupCredentials', {
            email: email,
            password: password,
            remoteAddress: '',
            remotePort: '3000'
          });
          
          // Generate new pairing token for security (one-time use)
          const newToken = generatePairingToken();
          store.set('pairingToken', newToken);
          
          // Refresh QR code in main window with new token
          refreshQRCodeInMainWindow();
          
          safeConsole('log', '[Pairing] Credentials received from mobile for:', email);
          
          // Compute UUID v5 and create user folder
          const userUuid = computeUserUuidSync(email, password);
          if (userUuid && uploadsPath) {
            const userFolderPath = path.join(uploadsPath, userUuid);
            
            // Create UUID folder if it doesn't exist
            try {
              if (!fs.existsSync(userFolderPath)) {
                fs.mkdirSync(userFolderPath, { recursive: true });
                safeConsole('log', '[Pairing] Created user folder:', userFolderPath);
              }
            } catch (mkdirErr) {
              safeConsole('error', '[Pairing] Failed to create user folder:', mkdirErr.message);
            }
            
            // Add UUID folder to source folders if not already there
            const currentFolders = store.get('backupFolders') || [];
            if (!currentFolders.includes(userFolderPath)) {
              currentFolders.push(userFolderPath);
              store.set('backupFolders', currentFolders);
              safeConsole('log', '[Pairing] Added user folder to sources:', userFolderPath);
            }
            
            // Update LOCAL STORAGE path in UI immediately with the UUID
            if (mainWindow && !mainWindow.isDestroyed()) {
              const escapedPath = userFolderPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
              mainWindow.webContents.executeJavaScript(`
                (function() {
                  var uploadsPathEl = document.getElementById('uploads-path');
                  if (uploadsPathEl) {
                    uploadsPathEl.value = '${escapedPath}';
                  }
                  if (typeof cachedUuid !== 'undefined') {
                    cachedUuid = '${userUuid}';
                  }
                })();
              `);
            }
          }
          
          // Register user on local server so login works with these credentials
          (async () => {
            try {
              const localServerUrl = 'http://127.0.0.1:3000';
              const deviceUuid = userUuid || crypto.randomUUID();
              
              // Try to register user on local server
              const registerRes = await fetch(`${localServerUrl}/api/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: email,
                  password: password,
                  device_uuid: deviceUuid
                })
              });
              
              if (registerRes.ok) {
                safeConsole('log', '[Pairing] User registered on local server:', email);
              } else if (registerRes.status === 409) {
                // User already exists - that's fine, try login instead
                safeConsole('log', '[Pairing] User already registered on local server:', email);
              } else {
                const errData = await registerRes.json().catch(() => ({}));
                safeConsole('log', '[Pairing] Local server register response:', registerRes.status, errData.error || '');
              }
            } catch (regErr) {
              safeConsole('log', '[Pairing] Could not register on local server (server may not be running):', regErr.message);
            }
          })();
          
          // Authenticate with StealthCloud to get token for NFT uploads
          (async () => {
            try {
              const stealthCloudBaseUrl = 'https://api.stealthlynk.com';
              const { DesktopBackupClient } = require('./backup-client');
              const authClient = new DesktopBackupClient({
                destination: 'stealthcloud',
                email: email,
                password: password,
                serverUrl: stealthCloudBaseUrl,
              });
              await authClient.login();
              if (authClient.token) {
                store.set('backupCredentials', {
                  ...store.get('backupCredentials'),
                  baseUrl: stealthCloudBaseUrl,
                  token: authClient.token,
                  deviceUuid: authClient.deviceUuid,
                });
                safeConsole('log', '[Pairing] StealthCloud authenticated - NFT cloud storage ready');
              }
            } catch (authErr) {
              safeConsole('log', '[Pairing] StealthCloud auth failed (NFT will use IPFS):', authErr.message);
            }
          })();
          
          // Show success popup in main window instead of closing it
          if (mainWindow && !mainWindow.isDestroyed()) {
            // Send the updated folders to the renderer
            const updatedFolders = store.get('backupFolders') || [];
            mainWindow.webContents.send('backup-folders', updatedFolders);
            
            // Update the email/password fields in the UI
            mainWindow.webContents.executeJavaScript(`
              (function() {
                // Update credentials fields
                var emailEl = document.getElementById('email');
                var passwordEl = document.getElementById('password');
                if (emailEl) emailEl.value = '${email.replace(/'/g, "\\'")}';
                if (passwordEl) passwordEl.value = '${password.replace(/'/g, "\\'")}';
                
                // Update selectedFolders and re-render
                if (typeof selectedFolders !== 'undefined') {
                  selectedFolders = ${JSON.stringify(store.get('backupFolders') || [])};
                  if (typeof renderFolders === 'function') {
                    renderFolders();
                  }
                }
                
                // Create success popup overlay
                var overlay = document.createElement('div');
                overlay.id = 'pairing-success-overlay';
                overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;';
                
                var popup = document.createElement('div');
                popup.style.cssText = 'background:#1a1a2e;border:1px solid #03E1FF;border-radius:16px;padding:32px;text-align:center;max-width:300px;box-shadow:0 0 40px rgba(3,225,255,0.3);';
                
                popup.innerHTML = '<div style="font-size:48px;margin-bottom:16px;">✓</div>' +
                  '<div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:8px;">Paired Successfully</div>' +
                  '<div style="font-size:14px;color:#888;margin-bottom:20px;">${email.replace(/'/g, "\\'")}</div>' +
                  '<div style="font-size:12px;color:#03E1FF;">Credentials saved. Ready to sync!</div>';
                
                overlay.appendChild(popup);
                document.body.appendChild(overlay);
                
                // Auto-hide after 3 seconds
                setTimeout(function() {
                  var el = document.getElementById('pairing-success-overlay');
                  if (el) el.remove();
                }, 3000);
                
                // Click to dismiss
                overlay.onclick = function() { overlay.remove(); };
              })();
            `);
          } else {
            // Fallback to system notification if window not open
            try {
              new Notification({
                title: 'PhotoLynk Paired',
                body: 'Successfully paired with ' + email,
                icon: path.join(__dirname, 'icon.png')
              }).show();
            } catch (e) {
              // ignore notification errors
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Paired successfully' }));
          
        } catch (e) {
          safeConsole('error', '[Pairing] Error:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  
  pairingServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      safeConsole('log', '[Pairing] Port', PAIRING_PORT, 'in use, trying next...');
      // Try next port
      pairingServer.listen(PAIRING_PORT + 1, '0.0.0.0');
    } else {
      safeConsole('error', '[Pairing] Server error:', err);
    }
  });
  
  pairingServer.listen(PAIRING_PORT, '0.0.0.0', () => {
    safeConsole('log', '[Pairing] Server listening on port', PAIRING_PORT);
  });
}

function stopPairingServer() {
  if (pairingServer) {
    pairingServer.close();
    pairingServer = null;
    safeConsole('log', '[Pairing] Server stopped');
  }
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
  
  // Ensure paths are initialized
  if (!uploadsPath) {
    initPaths();
  }
  
  const pairingData = getPairingData();
  const credentials = store.get('backupCredentials') || {};
  const photoFolders = store.get('backupFolders') || [];
  const defaultDownloadPath = path.join(os.homedir(), 'Pictures', 'PhotoLynk Sync');
  const savedDownloadPath = store.get('syncDownloadPath') || defaultDownloadPath;
  
  // Compute initial uploads path with UUID if credentials exist
  let initialUploadsPath = uploadsPath;
  if (credentials.email && credentials.password) {
    const userUuid = computeUserUuidSync(credentials.email, credentials.password);
    if (userUuid) {
      initialUploadsPath = path.join(uploadsPath, userUuid);
    }
  }
  const currentVersion = (app && typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0').trim();
  
  mainWindow = new BrowserWindow({
    width: 380,
    height: 680,
    minWidth: 320,
    minHeight: 500,
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    title: 'PhotoLynk',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
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
      --bg-primary: #000000;
      --bg-card: rgba(20, 20, 20, 0.95);
      --bg-input: rgba(30, 30, 30, 0.9);
      --accent: #03E1FF;
      --accent-green: #4ADE80;
      --text-primary: #FFFFFF;
      --text-secondary: #888888;
      --text-muted: #555555;
      --border: rgba(255, 255, 255, 0.1);
      --success: #4ADE80;
      --error: #F87171;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); display: flex; flex-direction: column; height: 100vh; }
    
    /* Views */
    .view { display: none; flex-direction: column; height: 100%; }
    .view.active { display: flex; }
    
    /* Header */
    .header { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .header-left { display: flex; flex-direction: column; }
    .header-back { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--accent); font-size: 14px; }
    .header-back:hover { opacity: 0.8; }
    .app-title { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; display: flex; align-items: baseline; gap: 8px; }
    .version-badge { font-size: 11px; font-weight: 500; color: var(--text-muted); letter-spacing: 0; }
    .header-title { font-size: 18px; font-weight: 600; }
    .server-badge { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
    .server-badge-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .server-badge-dot.stopped { background: var(--error); }
    .server-badge-text { font-size: 12px; color: var(--text-secondary); }
    .header-actions { display: flex; gap: 12px; }
    .header-btn { width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--text-secondary); font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .header-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary); }
    
    /* Status Hero - Fixed height to prevent layout shift - Dark green theme matching mobile */
    .status-hero { height: 160px; padding: 16px; text-align: center; background: linear-gradient(180deg, rgba(16,185,129,0.08) 0%, rgba(6,78,59,0.15) 100%); transition: all 0.3s; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .status-hero.backing-up { height: 160px; background: linear-gradient(180deg, rgba(3,225,255,0.08) 0%, transparent 100%); }
    .status-hero.syncing { height: 160px; background: linear-gradient(180deg, rgba(74,222,128,0.08) 0%, transparent 100%); }
    .status-hero.creating-nft { height: 70px; padding: 8px 16px; flex-direction: row; gap: 12px; background: linear-gradient(180deg, rgba(168,85,247,0.08) 0%, rgba(168,85,247,0.15) 100%); }
    .status-hero.creating-nft .status-icon { width: 44px; height: 44px; min-width: 44px; min-height: 44px; margin: 0; border-color: rgba(168,85,247,0.4); animation: pulse 1.5s infinite; }
    .status-hero.creating-nft .status-icon-inner { width: 34px; height: 34px; min-width: 34px; min-height: 34px; background: rgba(168,85,247,0.2); }
    .status-hero.creating-nft .status-icon-inner svg { width: 18px; height: 18px; stroke: #A855F7; }
    .status-hero.creating-nft .status-title { font-size: 14px; margin-bottom: 0; color: #A855F7; }
    .status-hero.creating-nft .status-subtitle { font-size: 11px; padding: 0; }
    .status-icon { width: 80px; height: 80px; min-width: 80px; min-height: 80px; aspect-ratio: 1 / 1; margin: 0 auto 12px; border-radius: 50%; background: transparent; border: 2px solid rgba(16,185,129,0.25); display: flex; align-items: center; justify-content: center; transition: all 0.3s; flex-shrink: 0; }
    .status-icon-inner { width: 64px; height: 64px; min-width: 64px; min-height: 64px; aspect-ratio: 1 / 1; border-radius: 50%; background: rgba(16,185,129,0.125); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .status-icon.running { border-color: rgba(16,185,129,0.25); }
    .status-icon.running .status-icon-inner { background: rgba(16,185,129,0.125); }
    .status-icon.backing-up, .status-icon.syncing { width: 80px; height: 80px; min-width: 80px; min-height: 80px; aspect-ratio: 1 / 1; margin-bottom: 12px; animation: pulse 2s infinite; }
    .status-icon.backing-up { border-color: rgba(3,225,255,0.25); }
    .status-icon.backing-up .status-icon-inner { width: 64px; height: 64px; min-width: 64px; min-height: 64px; background: rgba(3,225,255,0.125); }
    .status-icon.syncing { border-color: rgba(74,222,128,0.25); }
    .status-icon.syncing .status-icon-inner { width: 64px; height: 64px; min-width: 64px; min-height: 64px; background: rgba(74,222,128,0.125); }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.8; } }
    .status-icon-inner svg { width: 32px; height: 32px; transition: all 0.3s; }
    .status-icon.backing-up .status-icon-inner svg, .status-icon.syncing .status-icon-inner svg { width: 32px; height: 32px; }
    .status-title { font-size: 22px; font-weight: 600; margin-bottom: 6px; transition: all 0.3s; color: #10B981; }
    .status-title.running { color: #10B981; }
    .status-title.stopped { color: var(--error); }
    .status-title.backing-up, .status-title.syncing { font-size: 22px; margin-bottom: 6px; }
    .status-title.backing-up { color: var(--accent); }
    .status-title.syncing { color: var(--success); }
    .status-subtitle { font-size: 13px; color: var(--text-secondary); padding: 8px 16px; background: transparent; border-radius: 20px; display: inline-block; }
    
    /* Inline Progress */
    .inline-progress { display: none; align-items: center; gap: 10px; margin-top: 8px; width: 100%; max-width: 280px; }
    .inline-progress.visible { display: flex; }
    .inline-progress-bar { flex: 1; height: 6px; background: rgba(255,255,255,0.15); border-radius: 3px; overflow: hidden; }
    .inline-progress-fill { height: 100%; background: linear-gradient(90deg, #03E1FF, #4ADE80); min-width: 3%; width: 0%; transition: width 0.3s; border-radius: 3px; }
    .inline-progress-fill.syncing { background: linear-gradient(90deg, #4ADE80, #22C55E); }
    .inline-progress-text { font-size: 13px; font-weight: 600; color: var(--accent); min-width: 40px; text-align: right; }
    .inline-progress-text.syncing { color: var(--success); }
    .inline-status-message { display: none; margin-top: 6px; font-size: 11px; color: var(--text-secondary); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
    .inline-status-message.visible { display: block; }
    
    /* Content */
    .content { flex: 1; overflow-y: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
    
    /* Action Buttons */
    .action-row { display: flex; gap: 10px; }
    .action-btn { flex: 1; display: flex; align-items: center; padding: 12px; border-radius: 12px; cursor: pointer; transition: all 0.2s; }
    .action-btn.primary { background: linear-gradient(135deg, #03E1FF 0%, #00B4D8 100%); border: none; }
    .action-btn.secondary { background: linear-gradient(135deg, #4ADE80 0%, #22C55E 100%); border: none; }
    .action-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(3,225,255,0.3); }
    .action-btn.secondary:hover { box-shadow: 0 8px 24px rgba(74,222,128,0.3); }
    .action-btn-icon { width: 40px; height: 40px; border-radius: 10px; background: rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; margin-right: 10px; }
    .action-btn-icon svg { width: 20px; height: 20px; stroke: #000; fill: none; }
    .action-btn-text { flex: 1; text-align: left; }
    .action-btn-title { font-size: 14px; font-weight: 600; color: #000; }
    .action-btn-subtitle { font-size: 11px; color: rgba(0,0,0,0.6); margin-top: 2px; }
    .action-btn-arrow { font-size: 18px; color: rgba(0,0,0,0.4); }
    
    /* Cards */
    .card { background: var(--bg-card); border-radius: 14px; padding: 12px; }
    
    /* Server Option */
    .server-option { display: flex; align-items: center; padding: 14px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .server-option:last-child { margin-bottom: 0; }
    .server-option.selected { border-color: var(--accent); background: rgba(3,225,255,0.08); }
    .server-option:hover { border-color: rgba(255,255,255,0.3); }
    .server-option-icon { width: 40px; height: 40px; border-radius: 10px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; margin-right: 12px; color: var(--accent); font-size: 18px; }
    .server-option-text { flex: 1; }
    .server-option-title { font-size: 14px; font-weight: 500; }
    .server-option-subtitle { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
    
    /* QR Section */
    .qr-section { display: flex; gap: 12px; align-items: center; padding: 12px; background: var(--bg-card); border-radius: 14px; }
    .qr-container { background: #fff; padding: 10px; border-radius: 12px; flex-shrink: 0; }
    .qr-code { width: 90px; height: 90px; display: block; }
    .qr-info { flex: 1; }
    .qr-info h3 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
    .qr-info p { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
    .ip-badge { margin-top: 10px; padding: 8px 12px; background: rgba(3,225,255,0.1); border: 1px solid rgba(3,225,255,0.3); border-radius: 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
    .ip-badge span { color: var(--accent); font-weight: 600; font-family: monospace; }
    
    /* Form inputs */
    .form-group { margin-bottom: 12px; }
    .form-group:last-child { margin-bottom: 0; }
    .form-input { width: 100%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-input); color: var(--text-primary); font-size: 13px; transition: border-color 0.2s; }
    .form-input:focus { outline: none; border-color: var(--accent); }
    .form-input::placeholder { color: var(--text-muted); }
    .form-row { display: flex; gap: 10px; }
    .form-row .form-group { flex: 1; margin-bottom: 0; }
    
    /* Folder list */
    .folder-list { max-height: 120px; overflow-y: auto; margin-bottom: 12px; }
    .folder-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-input); border-radius: 8px; margin-bottom: 6px; }
    .folder-item span { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-item button { background: none; border: none; color: var(--error); cursor: pointer; padding: 4px 8px; font-size: 14px; }
    .folder-actions { display: flex; gap: 8px; }
    .folder-btn { flex: 1; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 11px; cursor: pointer; transition: all 0.2s; }
    .folder-btn:hover { background: rgba(255,255,255,0.05); border-color: var(--accent); color: var(--accent); }
    
    /* Section title */
    .section-title { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px 4px; }
    .section-title.centered { text-align: center; margin-left: 0; margin-right: 0; }
    
    /* Progress overlay */
    .progress-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 100; align-items: center; justify-content: center; }
    .progress-overlay.visible { display: flex; }
    .progress-box { background: var(--bg-card); border-radius: 20px; padding: 32px; width: 320px; text-align: center; }
    .progress-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
    .progress-text { font-size: 13px; color: var(--text-secondary); margin-bottom: 20px; }
    .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #03E1FF, #4ADE80); width: 0%; transition: width 0.3s; }
    .progress-cancel { margin-top: 20px; padding: 12px 24px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    
    #remote-config { display: none; }
    #remote-config.visible { display: block; margin-top: 12px; }
    
    /* NFT Styles */
    .action-btn.nft { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); }
    .action-btn.nft:hover { box-shadow: 0 8px 24px rgba(153,69,255,0.4); }
    .action-btn-icon.nft-icon { background: rgba(255,255,255,0.2); }
    .action-btn-icon.nft-icon svg { fill: none; stroke: #fff; }
    .action-btn-title.nft-title { color: #fff; }
    .action-btn-subtitle.nft-subtitle { color: rgba(255,255,255,0.7); }
    .action-btn-arrow.nft-arrow { color: rgba(255,255,255,0.5); }
    .action-btn-side.nft-side { border-color: rgba(153,69,255,0.4); }
    .action-btn-side.nft-side:hover { border-color: #9945FF; background: rgba(153,69,255,0.1); }
    .action-btn-side.nft-side svg { stroke: #9945FF; }
    .action-btn-side.nft-side span { color: #9945FF; }
    .action-btn-side { width: 52px; min-height: 56px; border-radius: 12px; background: var(--bg-card); border: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; margin-left: 8px; flex-shrink: 0; }
    .action-btn-side:hover { border-color: var(--accent); }
    .action-btn-side svg { width: 18px; height: 18px; margin-bottom: 2px; }
    .action-btn-side span { font-size: 9px; }
    
    /* NFT Album Overlay */
    .nft-album-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg-primary); z-index: 1000; display: none; flex-direction: column; overflow: hidden; }
    .nft-album-overlay.active { display: flex; }
    .nft-album-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .nft-album-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .nft-album-content { flex: 1; overflow: hidden; padding: 12px 16px; }
    .nft-refresh-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 16px; }
    .nft-refresh-btn:hover { background: rgba(255,255,255,0.05); color: #9945FF; border-color: #9945FF; }
    .nft-close-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
    .nft-close-btn:hover { background: rgba(255,255,255,0.05); color: #ff4444; border-color: #ff4444; }
    .nft-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .nft-item { aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--bg-card); border: 1px solid var(--border); cursor: pointer; position: relative; transition: all 0.2s; }
    .nft-item.standard { box-shadow: 0 4px 12px rgba(153,69,255,0.3), 0 0 0 1px rgba(153,69,255,0.2); } /* Purple shadow for standard NFTs */
    .nft-item.compressed { box-shadow: 0 4px 12px rgba(20,241,149,0.2), 0 0 0 1px rgba(20,241,149,0.15); } /* Green shadow for compressed NFTs */
    .nft-item:hover { transform: scale(1.02); }
    .nft-item.standard:hover { box-shadow: 0 6px 16px rgba(153,69,255,0.4), 0 0 0 1px rgba(153,69,255,0.4); }
    .nft-item.compressed:hover { box-shadow: 0 6px 16px rgba(20,241,149,0.3), 0 0 0 1px rgba(20,241,149,0.3); }
    .nft-item img { width: 100%; height: 100%; object-fit: cover; }
    .nft-item-overlay { position: absolute; bottom: 0; left: 0; right: 0; padding: 8px 10px; background: linear-gradient(transparent, rgba(0,0,0,0.9)); }
    .nft-item-name { font-size: 11px; font-weight: 500; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-item-date { font-size: 9px; color: rgba(255,255,255,0.5); margin-top: 2px; }
    .nft-badge { position: absolute; bottom: 8px; right: 8px; width: 24px; height: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .nft-badge-cnft { background: #1a5c2a; border-radius: 50%; } /* Dark green circle */
    .nft-badge-cnft .badge-text { color: #5ddb6e; font-size: 8px; font-weight: 700; line-height: 1; } /* Light green "cN" */
    .nft-badge-cnft .badge-sub { color: #5ddb6e; font-size: 5px; line-height: 1; margin-top: -1px; } /* Light green "compressed" */
    .nft-badge-standard { background: #2a1a4a; border-radius: 4px; } /* Dark purple background */
    .nft-badge-standard .badge-hex { color: #9945FF; font-size: 16px; line-height: 1; } /* Light purple hexagon outline */
    
    /* NFT Detail View Overlay */
    .nft-detail-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.95); z-index: 1100; display: none; flex-direction: column; overflow: hidden; }
    .nft-detail-overlay.active { display: flex; }
    .nft-detail-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; background: rgba(20, 20, 30, 0.98); }
    .nft-detail-header-left { flex: 1; min-width: 0; padding-right: 10px; }
    .nft-detail-title-name { font-size: 16px; font-weight: 700; color: #fff; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-detail-badge-row { display: flex; gap: 6px; margin-top: 6px; }
    .nft-chip { padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; line-height: 1; }
    .nft-chip.cnft { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .nft-chip.standard { background: rgba(153, 69, 255, 0.2); color: #9945FF; }
    .nft-chip.storage { background: rgba(153, 69, 255, 0.2); color: #9945FF; }
    .nft-detail-close { width: 32px; height: 32px; border-radius: 10px; border: none; background: transparent; color: rgba(255,255,255,0.85); cursor: pointer; font-size: 18px; line-height: 1; }
    .nft-detail-close:hover { color: #fff; }
    .nft-detail-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 12px 16px 18px; -webkit-overflow-scrolling: touch; background: rgba(0,0,0,0.95); }
    .nft-detail-image { width: 100%; aspect-ratio: 1; border-radius: 16px; overflow: hidden; margin-bottom: 16px; position: relative; }
    .nft-detail-image.standard { box-shadow: 0 8px 24px rgba(153,69,255,0.4); }
    .nft-detail-image.compressed { box-shadow: 0 8px 24px rgba(20,241,149,0.3); }
    .nft-detail-image img { width: 100%; height: 100%; object-fit: cover; }
    .nft-detail-badge { display: none; }
    .nft-detail-badge.cnft { display: none; }
    .nft-detail-badge.standard { display: none; }
    .nft-detail-name { display: none; }
    .nft-detail-badges { display: none; }
    .nft-pill { display: none; }
    .nft-pill.cnft { display: none; }
    .nft-pill.standard { display: none; }
    .nft-pill.storage-cloud { display: none; }
    .nft-pill.storage-ipfs { display: none; }
    .nft-detail-collection { display: none; }
    .nft-detail-description { display: none; }
    .nft-detail-info { display: none; }
    .nft-detail-row { display: none; }
    .nft-detail-label { display: none; }
    .nft-detail-value { display: none; }
    .nft-detail-value.address { display: none; }
    .nft-detail-actions { display: none; }
    .nft-action-btn { display: none; }
    .nft-action-btn.primary { display: none; }
    .nft-action-btn.secondary { display: none; }
    .nft-action-btn.danger { display: none; }

    .nft-section { margin-top: 14px; padding: 0 2px; }
    .nft-section-label { font-size: 11px; color: rgba(255,255,255,0.5); font-weight: 700; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.4px; }
    .nft-owner-address { color: #9945FF; font-size: 12px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-divider { height: 1px; background: rgba(255,255,255,0.08); margin-top: 14px; }

    .nft-verify-box { border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .nft-verify-box.success { background: rgba(34, 197, 94, 0.18); border-color: rgba(34, 197, 94, 0.28); }
    .nft-verify-icon { width: 18px; height: 18px; flex-shrink: 0; }
    .nft-verify-text { font-size: 13px; font-weight: 700; }
    .nft-verify-text.success { color: #22c55e; }
    .nft-verify-text.pending { color: rgba(255,255,255,0.85); }
    .nft-verify-text.action { color: #9945FF; }

    .nft-action-row { display: flex; gap: 10px; margin-top: 14px; }
    .nft-mini-btn { flex: 1; border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-weight: 700; font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; }
    .nft-mini-btn:hover { border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.08); }
    .nft-mini-btn svg { width: 16px; height: 16px; }

    .nft-transfer-main { width: 100%; margin-top: 14px; border-radius: 12px; padding: 14px; background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); border: none; color: #fff; font-size: 14px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; }
    .nft-transfer-main:hover { background: linear-gradient(135deg, #a855f7 0%, #8b5cf6 100%); }
    .nft-transfer-main svg { width: 18px; height: 18px; }
     
    /* NFT Transfer Modal */
    .nft-transfer-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1200; display: none; align-items: center; justify-content: center; padding: 20px; }
    .nft-transfer-modal.active { display: flex; }
    .nft-transfer-content { background: var(--bg-primary); border-radius: 16px; width: 100%; max-width: 360px; border: 1px solid var(--border); overflow: hidden; }
    .nft-transfer-header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .nft-transfer-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }
    .nft-transfer-close { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); cursor: pointer; font-size: 12px; }
    .nft-transfer-body { padding: 16px; }
    .nft-transfer-preview { display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-card); border-radius: 10px; margin-bottom: 16px; }
    .nft-transfer-preview img { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; }
    .nft-transfer-preview-info { flex: 1; }
    .nft-transfer-preview-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .nft-transfer-preview-type { font-size: 10px; color: var(--text-muted); }
    .nft-transfer-input-group { margin-bottom: 16px; }
    .nft-transfer-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block; }
    .nft-transfer-input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); font-size: 12px; font-family: monospace; }
    .nft-transfer-input:focus { outline: none; border-color: #9945FF; }
    .nft-transfer-cost { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-card); border-radius: 10px; margin-bottom: 16px; }
    .nft-transfer-cost-label { font-size: 11px; color: var(--text-muted); }
    .nft-transfer-cost-value { font-size: 13px; color: #14F195; font-weight: 600; }
    .nft-transfer-actions { display: flex; gap: 10px; }
    .nft-transfer-actions .nft-action-btn { flex: 1; display: flex !important; align-items: center; justify-content: center; padding: 14px 16px; border-radius: 12px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
    .nft-transfer-actions .nft-action-btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .nft-transfer-actions .nft-action-btn.secondary:hover { background: rgba(255,255,255,0.05); }
    .nft-transfer-actions .nft-action-btn.primary { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .nft-transfer-actions .nft-action-btn.primary:hover { background: linear-gradient(135deg, #a855f7 0%, #8b5cf6 100%); }
    .nft-transfer-actions .nft-action-btn.primary:disabled { background: rgba(153, 69, 255, 0.3); color: rgba(255,255,255,0.4); cursor: not-allowed; }
    
    /* NFT Mint Panel (inline) */
    .nft-mint-section { margin-top: 8px; background: var(--bg-card); border-radius: 14px; padding: 16px; border: 1px solid rgba(153,69,255,0.3); }
    .nft-mint-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .nft-mint-title { font-size: 14px; font-weight: 600; color: #9945FF; display: flex; align-items: center; gap: 6px; }
    .nft-mint-close { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); cursor: pointer; font-size: 12px; }
    .nft-mint-close:hover { background: rgba(255,255,255,0.05); }
    .nft-promo-banner { background: linear-gradient(135deg, #9945FF 0%, #14F195 100%); padding: 8px 12px; border-radius: 8px; margin-bottom: 12px; text-align: center; font-size: 11px; }
    .nft-option-group { margin-bottom: 12px; }
    .nft-option-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; }
    .nft-options { display: flex; gap: 6px; }
    .nft-option { flex: 1; padding: 10px 8px; border-radius: 8px; border: 1px solid var(--border); background: transparent; cursor: pointer; text-align: center; transition: all 0.2s; }
    .nft-option:hover { border-color: #9945FF; }
    .nft-option.selected { border-color: #9945FF; background: rgba(153,69,255,0.15); }
    .nft-option-title { font-size: 11px; font-weight: 500; color: var(--text-primary); }
    .nft-option-sub { font-size: 9px; color: var(--text-muted); margin-top: 2px; }
    .nft-option-price { font-size: 11px; font-weight: 600; color: #14F195; margin-top: 4px; }
    .nft-cost-breakdown { margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.25); border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); }
    .nft-cost-row { display: flex; justify-content: space-between; gap: 12px; font-size: 10px; color: var(--text-muted); margin-top: 6px; }
    .nft-cost-row:first-child { margin-top: 0; }
    .nft-cost-row strong { color: var(--text-primary); font-weight: 600; }
    .nft-cost-meta { margin-top: 8px; font-size: 9px; color: rgba(255,255,255,0.45); }
    .nft-photo-select { border: 2px dashed var(--border); border-radius: 10px; padding: 20px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .nft-photo-select:hover { border-color: #9945FF; background: rgba(153,69,255,0.05); }
    .nft-photo-icon { font-size: 28px; margin-bottom: 4px; }
    .nft-photo-text { font-size: 11px; color: var(--text-muted); }
    .nft-photo-preview { display: none; position: relative; border-radius: 10px; overflow: hidden; }
    .nft-photo-preview img { width: 100%; max-height: 120px; object-fit: cover; border-radius: 10px; }
    .nft-photo-remove { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.7); border: none; color: #fff; cursor: pointer; font-size: 11px; }
    .nft-input { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: rgba(0,0,0,0.3); color: var(--text-primary); font-size: 12px; margin-bottom: 8px; }
    .nft-input:focus { outline: none; border-color: #9945FF; }
    .nft-input::placeholder { color: var(--text-muted); }
    .nft-wallet-row { display: flex; align-items: center; gap: 8px; padding: 10px; background: rgba(153,69,255,0.1); border-radius: 8px; margin-bottom: 10px; font-size: 11px; }
    .nft-wallet-dot { width: 6px; height: 6px; border-radius: 50%; background: #14F195; }
    .nft-wallet-dot.disconnected { background: #f87171; }
    .nft-wallet-connect { margin-left: auto; padding: 4px 10px; border-radius: 5px; border: 1px solid #9945FF; background: transparent; color: #9945FF; cursor: pointer; font-size: 10px; }
    .nft-mint-btn { width: 100%; padding: 12px; border: none; border-radius: 10px; background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }
    .nft-mint-btn:hover { box-shadow: 0 6px 20px rgba(153,69,255,0.4); }
    .nft-mint-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
    .nft-item-name { font-size: 8px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-loading, .nft-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; color: var(--text-muted); font-size: 12px; gap: 8px; }
    .nft-spinner { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: #9945FF; border-radius: 50%; animation: spin 1s linear infinite; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <!-- MAIN VIEW -->
  <div id="main-view" class="view active">
    <div class="header">
      <div class="header-left">
        <div class="app-title">PhotoLynk <span class="version-badge">v1.5.5</span></div>
        <div class="server-badge">
          <div class="server-badge-dot" id="server-dot"></div>
          <span class="server-badge-text" id="server-status">Local Server</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="header-btn" id="autostart-btn" onclick="toggleAutoStart()" title="Start on Boot">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        </button>
        <button class="header-btn" onclick="showView('settings')" title="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1 2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>
    
    <div class="status-hero" id="status-hero">
      <div class="status-icon" id="status-icon">
        <div class="status-icon-inner">
          <svg viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
      </div>
      <div class="status-title" id="status-title">Ready</div>
      <div class="status-subtitle" id="status-subtitle">Idle</div>
      
      <!-- Inline Progress (hidden by default) -->
      <div class="inline-progress" id="inline-progress">
        <div class="inline-progress-bar">
          <div class="inline-progress-fill" id="inline-progress-fill"></div>
        </div>
        <div class="inline-progress-text" id="inline-progress-text">0%</div>
      </div>
      <div class="inline-status-message" id="inline-status-message"></div>
    </div>
    
    <div class="content">
      <div class="action-row">
        <div class="action-btn primary" onclick="startBackup()">
          <div class="action-btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg></div>
          <div class="action-btn-text">
            <div class="action-btn-title">Backup All</div>
            <div class="action-btn-subtitle">Upload to cloud</div>
          </div>
          <div class="action-btn-arrow">›</div>
        </div>
      </div>
      
      <div class="action-row">
        <div class="action-btn secondary" onclick="startSync()">
          <div class="action-btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 21v-9"/><path d="m8 17 4 4 4-4"/></svg></div>
          <div class="action-btn-text">
            <div class="action-btn-title">Sync All</div>
            <div class="action-btn-subtitle">Download from cloud</div>
          </div>
          <div class="action-btn-arrow">›</div>
        </div>
      </div>
      
      <div class="qr-section">
        <div class="qr-container">
          <img class="qr-code" src="${qrImage}" alt="QR Code">
        </div>
        <div class="qr-info">
          <h3>📱 Pair Mobile</h3>
          <p>Scan with PhotoLynk app to connect and sync credentials</p>
          <div class="ip-badge">🔗 <span>${pairingData.ip}:${pairingData.port}</span></div>
        </div>
      </div>
      
      <!-- NFT Section -->
      <div class="action-row">
        <div class="action-btn nft" onclick="openNFTMint()">
          <div class="action-btn-icon nft-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div>
          <div class="action-btn-text">
            <div class="action-btn-title nft-title">NFT Memories</div>
            <div class="action-btn-subtitle nft-subtitle">Own photos forever</div>
          </div>
          <div class="action-btn-arrow nft-arrow">›</div>
        </div>
        <div class="action-btn-side nft-side" onclick="openNFTAlbum()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
          <span>Album</span>
        </div>
      </div>
      <div class="section-title centered">SOLANA NFT</div>
      
      <!-- NFT Album Overlay (separate window on top) -->
      <div id="nft-album-overlay" class="nft-album-overlay">
        <div class="nft-album-header">
          <button class="nft-close-btn" onclick="closeNFTAlbum()">✕</button>
          <span class="nft-album-title">Your NFT Album</span>
          <button class="nft-refresh-btn" onclick="refreshNFTAlbum()">↻</button>
        </div>
        <div class="nft-album-content">
          <div id="nft-grid" class="nft-grid"></div>
          <div id="nft-loading" class="nft-loading" style="display: none;">
            <div class="nft-spinner"></div>
            <span>Loading NFTs...</span>
          </div>
          <div id="nft-empty" class="nft-empty" style="display: none;">
            <span>No NFTs yet. Mint your first memory!</span>
          </div>
          <div id="nft-nav" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px;padding-bottom:20px;"></div>
        </div>
      </div>
      
      <!-- NFT Detail View Overlay -->
      <div id="nft-detail-overlay" class="nft-detail-overlay">
        <div class="nft-detail-header">
          <div class="nft-detail-header-left">
            <div id="nft-detail-title" class="nft-detail-title-name"></div>
            <div class="nft-detail-badge-row">
              <div id="nft-detail-type-chip" class="nft-chip"></div>
              <div id="nft-detail-storage-chip" class="nft-chip storage"></div>
            </div>
          </div>
          <button class="nft-detail-close" onclick="closeNFTDetail()">✕</button>
        </div>
        <div class="nft-detail-content">
          <div id="nft-detail-image" class="nft-detail-image">
            <img id="nft-detail-img" src="" alt="">
          </div>

          <div class="nft-section">
            <div class="nft-section-label">NFT OWNER</div>
            <div id="nft-detail-owner-full" class="nft-owner-address"></div>
          </div>

          <div class="nft-divider"></div>

          <div class="nft-section">
            <div class="nft-section-label">BLOCKCHAIN VERIFICATION</div>
            <div id="nft-verify-box" class="nft-verify-box" onclick="handleNFTVerifyClick()">
              <svg class="nft-verify-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 12l2 2 4-4"></path>
                <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z"></path>
              </svg>
              <div id="nft-verify-text" class="nft-verify-text pending">Checking...</div>
            </div>
          </div>

          <div class="nft-action-row">
            <button id="nft-action-left" class="nft-mini-btn" onclick="openNFTTokenView()"></button>
            <button id="nft-action-right" class="nft-mini-btn" onclick="openNFTStorageView()"></button>
          </div>

          <button class="nft-transfer-main" onclick="openNFTTransfer()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            Transfer NFT
          </button>
        </div>
      </div>
      
      <!-- NFT Transfer Modal -->
      <div id="nft-transfer-modal" class="nft-transfer-modal">
        <div class="nft-transfer-content">
          <div class="nft-transfer-header">
            <span class="nft-transfer-title">Transfer NFT</span>
            <button class="nft-transfer-close" onclick="closeNFTTransfer()">✕</button>
          </div>
          <div class="nft-transfer-body">
            <div class="nft-transfer-preview">
              <img id="nft-transfer-img" src="" alt="">
              <div class="nft-transfer-preview-info">
                <div id="nft-transfer-name" class="nft-transfer-preview-name"></div>
                <div id="nft-transfer-type" class="nft-transfer-preview-type"></div>
              </div>
            </div>
            <div class="nft-transfer-input-group">
              <label class="nft-transfer-label">Recipient Wallet Address</label>
              <input type="text" id="nft-transfer-recipient" class="nft-transfer-input" placeholder="Enter Solana wallet address...">
            </div>
            <div class="nft-transfer-cost">
              <span class="nft-transfer-cost-label">Estimated Cost</span>
              <span id="nft-transfer-cost" class="nft-transfer-cost-value">~0.00001 SOL</span>
            </div>
            <div class="nft-transfer-actions">
              <button class="nft-action-btn secondary" onclick="closeNFTTransfer()">Cancel</button>
              <button class="nft-action-btn primary" onclick="confirmNFTTransfer()">Confirm Transfer</button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- NFT Mint Panel (inline) -->
      <div id="nft-mint-section" class="nft-mint-section" style="display: none;">
        <div class="nft-mint-header">
          <div class="nft-mint-title"><span>⬡</span> NFT Memories</div>
          <button class="nft-mint-close" onclick="closeNFTMint()">✕</button>
        </div>
        
        <div id="nft-promo-banner" class="nft-promo-banner" style="display: none;">
          🎉 Launch Special - <span id="promo-days">30</span> Days Left! Up to 90% off!
        </div>
        
        <div class="nft-option-group">
          <div class="nft-option-label">NFT Type</div>
          <div class="nft-options">
            <div class="nft-option selected" onclick="selectNFTType('compressed', this)">
              <div class="nft-option-title">Compressed (cNFT)</div>
              <div class="nft-option-sub">99.99% cheaper</div>
              <div class="nft-option-price" id="cnft-price">$0.02</div>
            </div>
            <div class="nft-option" onclick="selectNFTType('standard', this)">
              <div class="nft-option-title">Standard NFT</div>
              <div class="nft-option-sub">Traditional</div>
              <div class="nft-option-price" id="nft-price">$0.20</div>
            </div>
          </div>
        </div>
        
        <div class="nft-option-group">
          <div class="nft-option-label">Image Storage</div>
          <div class="nft-options">
            <div class="nft-option selected" onclick="selectNFTStorage('cloud', this)">
              <div class="nft-option-title">StealthCloud</div>
              <div class="nft-option-sub">Free storage • <span id="cloud-fee">$0.02</span> fee</div>
            </div>
            <div class="nft-option" onclick="selectNFTStorage('ipfs', this)">
              <div class="nft-option-title">IPFS</div>
              <div class="nft-option-sub">Decentralized • <span id="ipfs-fee">$0.05</span> fee</div>
            </div>
          </div>

          <div class="nft-cost-breakdown" id="nft-cost-breakdown" style="display:none;">
            <div class="nft-cost-row"><span>App fee (you pay)</span><strong id="nft-cost-fee">—</strong></div>
            <div class="nft-cost-row"><span>Network (est.)</span><strong id="nft-cost-network">—</strong></div>
            <div class="nft-cost-row"><span>Storage (est.)</span><strong id="nft-cost-storage">—</strong></div>
            <div class="nft-cost-row"><span>SOL/USD</span><strong id="nft-cost-sol">—</strong></div>
            <div class="nft-cost-meta" id="nft-cost-updated">—</div>
          </div>
        </div>
        
        <div class="nft-option-group">
          <div class="nft-option-label">Select Photo</div>
          <div class="nft-photo-select" id="nft-photo-select" onclick="selectNFTPhoto()">
            <div class="nft-photo-icon">📷</div>
            <div class="nft-photo-text">Click to select</div>
          </div>
          <div class="nft-photo-preview" id="nft-photo-preview">
            <img id="nft-preview-img" src="">
            <button class="nft-photo-remove" onclick="removeNFTPhoto()">✕</button>
          </div>
        </div>
        
        <div class="nft-option-group">
          <div class="nft-option-label">NFT Details</div>
          <input type="text" class="nft-input" id="nft-name-input" placeholder="Name (e.g., My Memory)">
          <input type="text" class="nft-input" id="nft-desc-input" placeholder="Description (optional)">
        </div>
        
        <div class="nft-wallet-row">
          <div class="nft-wallet-dot disconnected" id="mint-wallet-dot"></div>
          <span id="mint-wallet-text">No wallet connected</span>
          <button class="nft-wallet-connect" onclick="connectNFTWallet()">Connect</button>
        </div>
        
        <button class="nft-mint-btn" id="nft-mint-btn" disabled onclick="doMintNFT()">
          <span>⬡</span> Mint NFT
        </button>
      </div>
    </div>
  </div>
  
  <!-- SETTINGS VIEW -->
  <div id="settings-view" class="view">
    <div class="header">
      <div class="header-back" onclick="showView('main')">← Back</div>
      <div class="header-title">Settings</div>
      <div style="width: 60px;"></div>
    </div>
    
    <div class="content">
      <div class="section-title">BACKUP DESTINATION</div>
      <div class="card">
        <div class="server-option selected" onclick="selectDestination('stealthcloud', this)">
          <div class="server-option-icon">☁️</div>
          <div class="server-option-text">
            <div class="server-option-title">StealthCloud</div>
            <div class="server-option-subtitle">Secure cloud backup</div>
          </div>
        </div>
        <div class="server-option" onclick="selectDestination('remote', this)">
          <div class="server-option-icon">🌐</div>
          <div class="server-option-text">
            <div class="server-option-title">Remote Server</div>
            <div class="server-option-subtitle">Internet connection</div>
          </div>
        </div>
        <div id="remote-config">
          <div class="form-row" style="margin-top: 12px;">
            <div class="form-group"><input class="form-input" type="text" id="remote-address" placeholder="Server address" value="${credentials.remoteAddress || ''}"></div>
            <div class="form-group" style="flex: 0.4;"><input class="form-input" type="text" id="remote-port" placeholder="3000" value="${credentials.remotePort || '3000'}"></div>
          </div>
        </div>
      </div>
      
      <div class="section-title">CREDENTIALS</div>
      <div class="card">
        <div class="form-group">
          <input class="form-input" type="text" id="email" placeholder="Email, nickname, or name.skr" value="${credentials.email || ''}">
        </div>
        <div class="form-group">
          <input class="form-input" type="password" id="password" placeholder="Password" value="${credentials.password || ''}">
        </div>
        <input type="hidden" id="destination" value="stealthcloud">
      </div>
      
      <div class="section-title">SOURCE FOLDERS</div>
      <div class="card">
        <div class="folder-list" id="folder-list">${photoFolders.length === 0 ? '<div style="color: var(--text-muted); padding: 12px; text-align: center; font-size: 12px;">No folders selected</div>' : photoFolders.map((f, i) => '<div class="folder-item"><span title="' + f + '">' + f.split(/[\\/]/).pop() + '</span><button onclick="removeFolder(' + i + ')">✕</button></div>').join('')}</div>
        <div class="folder-actions">
          <button class="folder-btn" onclick="addFolder()">+ Add Folder</button>
          <button class="folder-btn" onclick="clearFolders()">Clear All</button>
        </div>
      </div>
      
      <div class="section-title">LOCAL STORAGE</div>
      <div class="card">
        <div class="form-row">
          <div class="form-group" style="flex: 1;"><input class="form-input" type="text" id="uploads-path" value="${initialUploadsPath || uploadsPath || ''}" readonly style="font-size: 11px; cursor: text;"></div>
        </div>
        <div class="folder-actions" style="margin-top: 10px;">
          <button class="folder-btn" onclick="copyUploadsPath()">📋 Copy</button>
          <button class="folder-btn" onclick="openUploadsFolder()">📂 Open</button>
          <button class="folder-btn" onclick="addUploadsToSources()">➕ Add to Sources</button>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Progress Overlay -->
  <div class="progress-overlay" id="progress-overlay">
    <div class="progress-box">
      <div class="progress-title" id="progress-title">Processing...</div>
      <div class="progress-text" id="progress-text">Preparing...</div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <button class="progress-cancel" onclick="cancelOperation()">Cancel</button>
    </div>
  </div>
  
  <script>
    // Global error handler
    window.onerror = function(msg, url, line, col, error) {
      console.error('JS Error:', msg, 'at line', line, 'col', col);
      return false;
    };
    
    const { ipcRenderer } = require('electron');
    let selectedFolders = ${JSON.stringify(photoFolders)};
    let serverBusy = false;
    let currentDestination = 'stealthcloud';
    let currentOperation = 'backup';
    
    // View navigation
    function showView(viewName) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(viewName + '-view').classList.add('active');
    }
    window.showView = showView;
    
    // Auto-start on boot toggle
    let autoStartEnabled = true; // Default to enabled
    
    function updateAutoStartButton() {
      const btn = document.getElementById('autostart-btn');
      if (autoStartEnabled) {
        btn.style.background = 'rgba(3, 225, 255, 0.2)';
        btn.style.borderColor = 'var(--accent)';
        btn.title = 'Start on Boot: ON (click to disable)';
      } else {
        btn.style.background = 'transparent';
        btn.style.borderColor = 'var(--border)';
        btn.title = 'Start on Boot: OFF (click to enable)';
      }
    }
    
    function toggleAutoStart() {
      autoStartEnabled = !autoStartEnabled;
      ipcRenderer.send('set-auto-start', autoStartEnabled);
      updateAutoStartButton();
    }
    window.toggleAutoStart = toggleAutoStart;
    
    // Get initial auto-start state
    ipcRenderer.send('get-auto-start');
    ipcRenderer.on('auto-start-status', (e, enabled) => {
      autoStartEnabled = enabled;
      updateAutoStartButton();
    });
    
    function updateServerStatus(running) {
      const dot = document.getElementById('server-dot');
      const status = document.getElementById('server-status');
      const icon = document.getElementById('status-icon');
      const title = document.getElementById('status-title');
      
      if (running) {
        dot.classList.remove('stopped');
        status.textContent = 'Local Server';
        icon.classList.add('running');
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>';
        title.textContent = 'Ready';
        title.classList.remove('stopped');
        title.classList.add('running');
      } else {
        dot.classList.add('stopped');
        status.textContent = 'Server Stopped';
        icon.classList.remove('running');
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--error);"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>';
        title.textContent = 'Stopped';
        title.classList.remove('running');
        title.classList.add('stopped');
      }
      serverBusy = false;
    }
    
    function selectDestination(dest, el) {
      currentDestination = dest;
      document.getElementById('destination').value = dest;
      document.querySelectorAll('.server-option').forEach(opt => opt.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById('remote-config').classList.toggle('visible', dest === 'remote');
    }
    window.selectDestination = selectDestination;
    
    ipcRenderer.on('server-status', (e, running) => updateServerStatus(running));
    ipcRenderer.send('get-server-status');
    
    function renderFolders() {
      const list = document.getElementById('folder-list');
      list.innerHTML = selectedFolders.length === 0 ? '<div style="color: var(--text-muted); padding: 12px; text-align: center; font-size: 12px;">No folders selected</div>' : selectedFolders.map((f, i) => '<div class="folder-item"><span title="' + f + '">' + f + '</span><button onclick="removeFolder(' + i + ')">✕</button></div>').join('');
    }
    
    async function addFolder() {
      const paths = await ipcRenderer.invoke('select-folder');
      if (paths && paths.length > 0) { paths.forEach(p => { if (!selectedFolders.includes(p)) selectedFolders.push(p); }); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    }
    function removeFolder(i) { selectedFolders.splice(i, 1); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    window.removeFolder = removeFolder;
    function clearFolders() { selectedFolders = []; ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    window.clearFolders = clearFolders;
    window.addFolder = addFolder;
    const baseUploadsPath = "${(uploadsPath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
    
    // Compute UUID v5 from email:password using SubtleCrypto (matches mobile app's uuid library)
    // UUID v5 = SHA-1(namespace + name) with version/variant bits set
    async function computeUserUuid(email, password) {
      try {
        if (!email || !password) return null;
        const normalizedEmail = email.trim().toLowerCase();
        const name = normalizedEmail + ':' + password;
        
        // DNS namespace UUID: 6ba7b810-9dad-11d1-80b4-00c04fd430c8 (same as mobile)
        const namespaceBytes = new Uint8Array([
          0x6b, 0xa7, 0xb8, 0x10,
          0x9d, 0xad,
          0x11, 0xd1,
          0x80, 0xb4,
          0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8
        ]);
        
        // Concatenate namespace + name for SHA-1
        const encoder = new TextEncoder();
        const nameBytes = encoder.encode(name);
        const data = new Uint8Array(namespaceBytes.length + nameBytes.length);
        data.set(namespaceBytes, 0);
        data.set(nameBytes, namespaceBytes.length);
        
        const hashBuffer = await crypto.subtle.digest('SHA-1', data);
        const hashArray = new Uint8Array(hashBuffer);
        
        // Apply UUID v5 version (0101xxxx) and variant (10xxxxxx) bits
        hashArray[6] = (hashArray[6] & 0x0f) | 0x50;
        hashArray[8] = (hashArray[8] & 0x3f) | 0x80;
        
        const hex = Array.from(hashArray.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
      } catch (e) {
        console.error('computeUserUuid error:', e);
        return null;
      }
    }
    
    // Initialize cachedUuid from initialUploadsPath if it contains a UUID
    let cachedUuid = null;
    const initialPath = "${(initialUploadsPath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
    if (initialPath && initialPath !== baseUploadsPath) {
      // Extract UUID from the path (last segment)
      const pathSep = initialPath.includes('\\\\') ? '\\\\' : '/';
      const segments = initialPath.split(pathSep);
      const lastSegment = segments[segments.length - 1];
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      if (lastSegment && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastSegment)) {
        cachedUuid = lastSegment;
        console.log('[UUID] Initialized from stored credentials:', cachedUuid);
      }
    }
    
    async function getUserUploadsPath() {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      
      // If form has credentials, compute fresh UUID
      if (email && password) {
        console.log('[UUID] Computing for email:', email, 'hasPassword:', !!password);
        const uuid = await computeUserUuid(email, password);
        console.log('[UUID] Computed UUID:', uuid);
        if (uuid) {
          cachedUuid = uuid;
          return baseUploadsPath + (baseUploadsPath.includes('\\\\') ? '\\\\' : '/') + uuid;
        }
      }
      
      // Fall back to cached UUID from stored credentials
      if (cachedUuid) {
        console.log('[UUID] Using cached UUID:', cachedUuid);
        return baseUploadsPath + (baseUploadsPath.includes('\\\\') ? '\\\\' : '/') + cachedUuid;
      }
      
      return baseUploadsPath;
    }
    function getUserUploadsPathSync() {
      if (cachedUuid) {
        return baseUploadsPath + (baseUploadsPath.includes('\\\\') ? '\\\\' : '/') + cachedUuid;
      }
      return baseUploadsPath;
    }
    
    async function updateUploadsPathDisplay() {
      const pathEl = document.getElementById('uploads-path');
      const newPath = await getUserUploadsPath();
      console.log('[UI] Updating uploads path to:', newPath);
      pathEl.value = newPath;
    }
    
    // Update path when email or password changes
    try {
      document.getElementById('email').addEventListener('input', updateUploadsPathDisplay);
      document.getElementById('password').addEventListener('input', updateUploadsPathDisplay);
      // Initial update - run after a short delay to ensure form values are populated
      setTimeout(async () => {
        await updateUploadsPathDisplay();
        console.log('[UI] Initial uploads path updated');
      }, 100);
    } catch (e) {
      console.error('Event listener setup error:', e);
    }
    
    async function openUploadsFolder() { 
      // Always compute fresh path with UUID
      const pathToOpen = await getUserUploadsPath();
      ipcRenderer.send('open-folder', pathToOpen); 
    }
    window.openUploadsFolder = openUploadsFolder;
    async function copyUploadsPath() { 
      // Always compute fresh path with UUID
      const pathToCopy = await getUserUploadsPath();
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
    async function addUploadsToSources() { const p = await getUserUploadsPath(); if (p && !selectedFolders.includes(p)) { selectedFolders.push(p); ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); } }
    window.copyUploadsPath = copyUploadsPath;
    window.addUploadsToSources = addUploadsToSources;
    
    async function getConfig() {
      const downloadPath = await getUserUploadsPath(); // Use computed path with UUID, not input value
      console.log('[getConfig] downloadPath:', downloadPath);
      return { destination: document.getElementById('destination').value, source: document.getElementById('destination').value, email: document.getElementById('email').value, password: document.getElementById('password').value, remoteAddress: document.getElementById('remote-address').value, remotePort: document.getElementById('remote-port').value || '3000', folders: selectedFolders, downloadPath: downloadPath };
    }
    
    // Inline progress helper functions
    function showInlineProgress(type) {
      const hero = document.getElementById('status-hero');
      const icon = document.getElementById('status-icon');
      const title = document.getElementById('status-title');
      const subtitle = document.getElementById('status-subtitle');
      const progress = document.getElementById('inline-progress');
      const progressFill = document.getElementById('inline-progress-fill');
      const progressText = document.getElementById('inline-progress-text');
      const statusMsg = document.getElementById('inline-status-message');
      
      // Update classes for styling
      hero.className = 'status-hero ' + type;
      icon.className = 'status-icon ' + type;
      title.className = 'status-title ' + type;
      
      // Update icon SVG
      if (type === 'backing-up') {
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>';
        title.textContent = 'Backing Up...';
        progressFill.className = 'inline-progress-fill';
        progressText.className = 'inline-progress-text';
      } else if (type === 'syncing') {
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>';
        title.textContent = 'Syncing...';
        progressFill.className = 'inline-progress-fill syncing';
        progressText.className = 'inline-progress-text syncing';
      }
      
      // Show progress elements
      subtitle.style.display = 'none';
      progress.classList.add('visible');
      progressFill.style.width = '0%';
      progressText.textContent = '0%';
      statusMsg.classList.add('visible');
      statusMsg.textContent = 'Preparing...';
    }
    
    function updateInlineProgress(percent, message) {
      document.getElementById('inline-progress-fill').style.width = percent + '%';
      document.getElementById('inline-progress-text').textContent = Math.round(percent) + '%';
      document.getElementById('inline-status-message').textContent = message;
    }
    
    function hideInlineProgress(success, message) {
      const hero = document.getElementById('status-hero');
      const icon = document.getElementById('status-icon');
      const title = document.getElementById('status-title');
      const subtitle = document.getElementById('status-subtitle');
      const progress = document.getElementById('inline-progress');
      const statusMsg = document.getElementById('inline-status-message');
      
      // Show completion message briefly
      if (success) {
        title.textContent = 'Complete!';
        title.className = 'status-title running';
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>';
        document.getElementById('inline-progress-fill').style.width = '100%';
      } else {
        title.textContent = 'Error';
        title.className = 'status-title stopped';
      }
      statusMsg.textContent = message;
      
      // Reset to idle after delay
      setTimeout(() => {
        hero.className = 'status-hero';
        icon.className = 'status-icon';
        icon.innerHTML = '<div class="status-icon-inner"><svg viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>';
        title.className = 'status-title';
        title.textContent = 'Ready';
        subtitle.style.display = 'inline-block';
        progress.classList.remove('visible');
        statusMsg.classList.remove('visible');
      }, success ? 2000 : 3000);
    }
    
    async function startBackup() {
      const config = await getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      if (selectedFolders.length === 0) { alert('Please add at least one folder to backup'); return; }
      currentOperation = 'backup';
      showInlineProgress('backing-up');
      ipcRenderer.send('start-desktop-backup', config);
    }
    window.startBackup = startBackup;
    
    async function startSync() {
      const config = await getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      currentOperation = 'sync';
      showInlineProgress('syncing');
      ipcRenderer.send('start-desktop-sync', config);
    }
    window.startSync = startSync;
    
    function cancelOperation() {
      ipcRenderer.send(currentOperation === 'backup' ? 'cancel-desktop-backup' : 'cancel-desktop-sync');
      document.getElementById('inline-status-message').textContent = 'Cancelling...';
    }
    window.cancelOperation = cancelOperation;
    
    ipcRenderer.on('backup-progress', (e, d) => { updateInlineProgress(d.progress * 100, d.message); });
    ipcRenderer.on('backup-complete', (e, d) => { hideInlineProgress(true, d.message); });
    ipcRenderer.on('backup-error', (e, d) => { hideInlineProgress(false, 'Error: ' + d.message); });
    ipcRenderer.on('sync-progress', (e, d) => { updateInlineProgress(d.progress * 100, d.message); });
    ipcRenderer.on('sync-complete', (e, d) => { hideInlineProgress(true, d.message); });
    ipcRenderer.on('sync-error', (e, d) => { hideInlineProgress(false, 'Error: ' + d.message); });
    
    // IPFS Gateways for standard NFT image loading (ipfs.io and pinata are most reliable)
    const IPFS_GATEWAYS = [
      'https://ipfs.io/ipfs/',              // Most reliable, follows redirects
      'https://gateway.pinata.cloud/ipfs/', // Pinata - where most NFT images are hosted
      'https://dweb.link/ipfs/',
      'https://w3s.link/ipfs/',
    ];
    // cNFT-optimized gateways (same order - ipfs.io and pinata first)
    const CNFT_IPFS_GATEWAYS = [
      'https://ipfs.io/ipfs/',              // Most reliable, follows redirects
      'https://gateway.pinata.cloud/ipfs/', // Pinata - where most NFT images are hosted
      'https://w3s.link/ipfs/',
      'https://nftstorage.link/ipfs/',
    ];
    const MAX_IPFS_RETRY_CYCLES = 1; // Single cycle through all gateways
    const MAX_STEALTHCLOUD_RETRIES = 3; // Retry StealthCloud 3 times
    const GATEWAY_RETRY_DELAY_MS = 10000; // 10 seconds between gateway attempts (matches mobile)
    const IMAGE_LOAD_TIMEOUT_MS = 15000; // 15 seconds timeout (matches mobile)
    
    // Extract CID from any IPFS URL
    function extractIPFSCid(url) {
      if (!url) return null;
      if (url.startsWith('ipfs://')) {
        const rest = url.slice('ipfs://'.length);
        const cid = rest.split('/')[0];
        return cid || null;
      }
      const idx = url.indexOf('/ipfs/');
      if (idx !== -1) {
        const rest = url.slice(idx + '/ipfs/'.length);
        const cid = rest.split('/')[0];
        return cid || null;
      }
      return null;
    }

    function clearNFTImageTimeout(img) {
      try {
        if (img && img._nftLoadTimeout) {
          clearTimeout(img._nftLoadTimeout);
          img._nftLoadTimeout = null;
        }
      } catch (e) {}
    }

    function scheduleNFTImageTimeout(img) {
      clearNFTImageTimeout(img);
      if (!img) return;
      img._nftLoadTimeout = setTimeout(() => {
        if (img && img.dataset && img.dataset.loaded !== '1') {
          handleNFTImageError(img, true);
        }
      }, IMAGE_LOAD_TIMEOUT_MS);
    }

    function setNFTImageSrc(img, nextUrl, immediate) {
      if (!img) return;
      img.dataset.loaded = '0';
      img.dataset.lastSetAt = String(Date.now());
      img.src = nextUrl;
      scheduleNFTImageTimeout(img);
    }
    
    // Check if URL is StealthCloud
    function isStealthCloudUrl(url) {
      if (!url) return false;
      return url.includes('stealthlynk.io') || url.includes('nft.stealthlynk.io');
    }
    
    // Handle NFT image load error with StealthCloud priority, then IPFS gateway retries
    function handleNFTImageError(img, immediate) {
      const originalUrl = img.dataset.originalUrl;
      const fallbackUrl = img.dataset.fallbackUrl || '';
      let gatewayIndex = parseInt(img.dataset.gatewayIndex) || 0;
      let retryCount = parseInt(img.dataset.retryCount) || 0;
      let source = img.dataset.source || 'primary';
      const isCompressed = img.dataset.compressed === '1';
      const wasCached = img.dataset.cached === '1';
      // Use cNFT-optimized gateways for compressed NFTs
      const gateways = isCompressed ? CNFT_IPFS_GATEWAYS : IPFS_GATEWAYS;
      
      console.log('[NFT Album] Image error, source:', source, 'retry:', retryCount, 'gateway:', gatewayIndex, isCompressed ? '(cNFT)' : '', wasCached ? '(was cached)' : '');
      
      // If cached image failed, fall back to network URL
      if (wasCached && source === 'primary') {
        console.log('[NFT Album] Cached image failed, trying network');
        img.dataset.cached = '0';
        img.dataset.source = 'fallback';
        img.dataset.gatewayIndex = 0;
        const cid = extractIPFSCid(originalUrl);
        if (cid) {
          setNFTImageSrc(img, gateways[0] + cid, true);
          return;
        } else if (originalUrl) {
          setNFTImageSrc(img, originalUrl, true);
          return;
        }
      }
      
      if (source === 'primary') {
        // Primary source failed (StealthCloud or direct URL)
        if (isStealthCloudUrl(originalUrl)) {
          if (retryCount < MAX_STEALTHCLOUD_RETRIES - 1) {
            // Retry StealthCloud with cache buster
            retryCount++;
            img.dataset.retryCount = retryCount;
            console.log('[NFT Album] StealthCloud retry', retryCount);
            setTimeout(() => {
              setNFTImageSrc(img, originalUrl + (originalUrl.includes('?') ? '&' : '?') + 'r=' + retryCount, false);
            }, 3000);
            return;
          } else {
            // StealthCloud exhausted, try IPFS fallback if available
            const cid = extractIPFSCid(fallbackUrl);
            if (cid) {
              console.log('[NFT Album] StealthCloud failed, trying IPFS fallback');
              img.dataset.source = 'fallback';
              img.dataset.retryCount = 0;
              img.dataset.gatewayIndex = 0;
              setNFTImageSrc(img, gateways[0] + cid, true);
              return;
            }
          }
        } else {
          // Primary is IPFS - try gateways
          const cid = extractIPFSCid(originalUrl);
          if (cid) {
            const delayMs = immediate ? 0 : GATEWAY_RETRY_DELAY_MS;
            setTimeout(() => {
              if (gatewayIndex < gateways.length - 1) {
                gatewayIndex++;
                img.dataset.gatewayIndex = gatewayIndex;
                setNFTImageSrc(img, gateways[gatewayIndex] + cid, immediate);
                console.log('[NFT Album] IPFS gateway', gatewayIndex + 1, 'for', cid.slice(0, 8));
              } else if (retryCount < MAX_IPFS_RETRY_CYCLES) {
                gatewayIndex = 0;
                retryCount++;
                img.dataset.gatewayIndex = 0;
                img.dataset.retryCount = retryCount;
                setNFTImageSrc(img, gateways[0] + cid, immediate);
                console.log('[NFT Album] IPFS retry cycle', retryCount + 1);
              } else {
                console.log('[NFT Album] IPFS failed for', cid.slice(0, 8));
                img.style.opacity = '0.3';
              }
            }, delayMs);
            return;
          }
        }
      } else {
        // Fallback source (IPFS gateways)
        const cid = extractIPFSCid(fallbackUrl);
        if (cid) {
          const delayMs = immediate ? 0 : GATEWAY_RETRY_DELAY_MS;
          setTimeout(() => {
            if (gatewayIndex < gateways.length - 1) {
              gatewayIndex++;
              img.dataset.gatewayIndex = gatewayIndex;
              setNFTImageSrc(img, gateways[gatewayIndex] + cid, immediate);
            } else if (retryCount < MAX_IPFS_RETRY_CYCLES) {
              gatewayIndex = 0;
              retryCount++;
              img.dataset.gatewayIndex = 0;
              img.dataset.retryCount = retryCount;
              setNFTImageSrc(img, gateways[0] + cid, immediate);
            } else {
              img.style.opacity = '0.3';
            }
          }, delayMs);
          return;
        }
      }
      
      // No valid source found - show placeholder and hide spinner
      console.log('[NFT Album] No valid image source, showing placeholder');
      const spinner = img.parentElement ? img.parentElement.querySelector('.nft-spinner') : null;
      if (spinner) spinner.style.display = 'none';
      img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#1a1a1a" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="#666" font-size="24">⬡</text></svg>');
      img.style.opacity = '0.5';
    }
    
    // NFT State
    let nftWalletAddress = null;
    let selectedNFTType = 'compressed';
    let selectedNFTStorage = 'cloud';
    let selectedNFTPhoto = null;
    let isMinting = false;
    let lastNftFees = null;
    let lastNftEstimate = null;
    let nftPriceTimer = null;
    
    // NFT Mint Panel Functions
    async function openNFTMint() {
      console.log('[NFT] openNFTMint called');
      try {
        const section = document.getElementById('nft-mint-section');
        console.log('[NFT] section found:', !!section, 'current display:', section ? section.style.display : 'N/A');
        // Always show it
        section.style.display = 'block';
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Load promo banner + start live pricing refresh
        try {
          const feesData = await ipcRenderer.invoke('get-nft-fees');
          if (feesData && feesData.isPromo) {
            document.getElementById('nft-promo-banner').style.display = 'block';
            document.getElementById('promo-days').textContent = feesData.promoDaysRemaining;
          } else {
            document.getElementById('nft-promo-banner').style.display = 'none';
          }
        } catch (e) {
          console.error('Failed to load fees:', e);
        }

        updateMintWalletUI();

        // Refresh immediately and then periodically
        refreshNFTPricesRealtime();
        if (nftPriceTimer) clearInterval(nftPriceTimer);
        nftPriceTimer = setInterval(refreshNFTPricesRealtime, 15000);
      } catch (e) {
        console.error('openNFTMint error:', e);
      }
    }

    // Ensure inline handler can access it immediately
    window.openNFTMint = openNFTMint;
    
    function closeNFTMint() {
      document.getElementById('nft-mint-section').style.display = 'none';
      if (nftPriceTimer) { clearInterval(nftPriceTimer); nftPriceTimer = null; }
      resetNFTMintForm();
    }
    
    function resetNFTMintForm() {
      selectedNFTPhoto = null;
      document.getElementById('nft-photo-select').style.display = 'block';
      document.getElementById('nft-photo-preview').style.display = 'none';
      document.getElementById('nft-name-input').value = '';
      document.getElementById('nft-desc-input').value = '';
      updateMintButton();
    }
    
    async function refreshNFTPricesRealtime() {
      try {
        const feesData = await ipcRenderer.invoke('get-nft-fees');
        if (feesData && feesData.fees) lastNftFees = feesData.fees;
        const [cnft, standard] = await Promise.all([
          ipcRenderer.invoke('estimate-nft-costs', { nftType: 'compressed', storageOption: selectedNFTStorage, filePath: selectedNFTPhoto }),
          ipcRenderer.invoke('estimate-nft-costs', { nftType: 'standard', storageOption: selectedNFTStorage, filePath: selectedNFTPhoto }),
        ]);
        if (cnft && !cnft.error && cnft.total) {
          document.getElementById('cnft-price').textContent = '~$' + (cnft.total.usd || 0).toFixed(2);
        }
        if (standard && !standard.error && standard.total) {
          document.getElementById('nft-price').textContent = '~$' + (standard.total.usd || 0).toFixed(2);
        }

        // Storage option fee labels are still based on your app commission table
        if (lastNftFees) {
          if (selectedNFTType === 'compressed') {
            document.getElementById('cloud-fee').textContent = '$' + lastNftFees.APP_COMMISSION_CNFT_CLOUD_USD.toFixed(2);
            document.getElementById('ipfs-fee').textContent = '$' + lastNftFees.APP_COMMISSION_CNFT_IPFS_USD.toFixed(2);
          } else {
            document.getElementById('cloud-fee').textContent = '$' + lastNftFees.APP_COMMISSION_STANDARD_CLOUD_USD.toFixed(2);
            document.getElementById('ipfs-fee').textContent = '$' + lastNftFees.APP_COMMISSION_STANDARD_IPFS_USD.toFixed(2);
          }
        }

        // Selected option estimate for mint button
        const selectedEstimate = await ipcRenderer.invoke('estimate-nft-costs', { nftType: selectedNFTType, storageOption: selectedNFTStorage, filePath: selectedNFTPhoto });
        if (selectedEstimate && !selectedEstimate.error) {
          lastNftEstimate = selectedEstimate;
        }

        if (lastNftEstimate && lastNftEstimate.total && lastNftEstimate.solPrice) {
          const box = document.getElementById('nft-cost-breakdown');
          if (box) box.style.display = 'block';
          const solPrice = Number(lastNftEstimate.solPrice) || 0;
          const feeUsd = Number(lastNftEstimate.fee?.usd) || 0;
          const feeSol = Number(lastNftEstimate.fee?.sol) || (solPrice > 0 ? feeUsd / solPrice : 0);
          const netSol = Number(lastNftEstimate.network?.sol) || 0;
          const storageUsd = Number(lastNftEstimate.storage?.usd) || 0;
          const storageSol = solPrice > 0 ? (storageUsd / solPrice) : 0;
          const rentLamports = Number(lastNftEstimate.network?.rentLamports) || 0;
          const priorityLamports = Number(lastNftEstimate.network?.priorityFeeLamports) || 0;

          const feeEl = document.getElementById('nft-cost-fee');
          const netEl = document.getElementById('nft-cost-network');
          const stEl = document.getElementById('nft-cost-storage');
          const solEl = document.getElementById('nft-cost-sol');
          const updEl = document.getElementById('nft-cost-updated');
          if (feeEl) feeEl.textContent = '$' + feeUsd.toFixed(2) + ' (' + feeSol.toFixed(6) + ' SOL)';
          if (netEl) netEl.textContent = netSol.toFixed(6) + ' SOL (rent ' + rentLamports + ', priority ' + priorityLamports + ' lamports)';
          if (stEl) stEl.textContent = (storageUsd > 0 ? ('$' + storageUsd.toFixed(2) + ' (' + storageSol.toFixed(6) + ' SOL)') : '$0.00');
          if (solEl) solEl.textContent = '$' + solPrice.toFixed(2);
          if (updEl) updEl.textContent = 'Updates every ~15s • ' + new Date().toLocaleTimeString();
        }

        updateMintButton();
      } catch (e) {
        console.error('refreshNFTPricesRealtime error:', e);
      }
    }
    
    function selectNFTType(type, el) {
      selectedNFTType = type;
      el.parentElement.querySelectorAll('.nft-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    function selectNFTStorage(storage, el) {
      selectedNFTStorage = storage;
      el.parentElement.querySelectorAll('.nft-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    async function selectNFTPhoto() {
      try {
        const paths = await ipcRenderer.invoke('select-photo-for-nft');
        if (paths && paths.length > 0) {
          selectedNFTPhoto = paths[0];
          document.getElementById('nft-preview-img').src = 'http://localhost:3000/local-image?path=' + encodeURIComponent(selectedNFTPhoto);
          document.getElementById('nft-photo-select').style.display = 'none';
          document.getElementById('nft-photo-preview').style.display = 'block';
          refreshNFTPricesRealtime();
          updateMintButton();
        }
      } catch (e) {
        console.error('selectNFTPhoto error:', e);
      }
    }
    
    function removeNFTPhoto() {
      selectedNFTPhoto = null;
      document.getElementById('nft-photo-select').style.display = 'block';
      document.getElementById('nft-photo-preview').style.display = 'none';
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    let walletPollInterval = null;
    
    function connectNFTWallet() {
      // Open browser directly
      ipcRenderer.send('open-wallet-connect');
      
      // Update UI to show connecting
      document.getElementById('mint-wallet-text').textContent = 'Connecting...';
      
      // Poll for wallet address
      if (walletPollInterval) clearInterval(walletPollInterval);
      walletPollInterval = setInterval(async () => {
        try {
          const res = await fetch('http://localhost:3000/wallet-address');
          const data = await res.json();
          if (data.success && data.address) {
            clearInterval(walletPollInterval);
            walletPollInterval = null;
            nftWalletAddress = data.address;
            updateMintWalletUI();
            loadNFTAlbum();
            // Bring app window to front
            if (data.bringToFront) {
              ipcRenderer.send('bring-to-front');
            }
          }
        } catch (e) { /* Server not ready */ }
      }, 500);
      
      // Stop polling after 2 minutes
      setTimeout(() => {
        if (walletPollInterval) {
          clearInterval(walletPollInterval);
          walletPollInterval = null;
          if (!nftWalletAddress) {
            document.getElementById('mint-wallet-text').textContent = 'Connection timed out';
          }
        }
      }, 120000);
    }
    
    function updateMintWalletUI() {
      const dot = document.getElementById('mint-wallet-dot');
      const text = document.getElementById('mint-wallet-text');
      if (nftWalletAddress) {
        dot.classList.remove('disconnected');
        text.textContent = nftWalletAddress.slice(0, 4) + '...' + nftWalletAddress.slice(-4);
      } else {
        dot.classList.add('disconnected');
        text.textContent = 'No wallet connected';
      }
      updateMintButton();
    }
    
    function updateMintButton() {
      const btn = document.getElementById('nft-mint-btn');
      btn.disabled = !selectedNFTPhoto || !nftWalletAddress || isMinting;
      if (!btn.disabled && lastNftEstimate && lastNftEstimate.total) {
        btn.innerHTML = '<span>⬡</span> Mint NFT (~$' + (lastNftEstimate.total.usd || 0).toFixed(2) + ')';
      } else if (!isMinting) {
        btn.innerHTML = '<span>⬡</span> Mint NFT';
      }
    }
    
    async function doMintNFT() {
      if (isMinting || !selectedNFTPhoto || !nftWalletAddress) return;
      isMinting = true;
      
      // Squeeze hero during NFT creation
      const hero = document.getElementById('status-hero');
      const title = document.getElementById('status-title');
      const subtitle = document.getElementById('status-subtitle');
      hero.classList.add('creating-nft');
      title.textContent = 'Creating NFT';
      subtitle.textContent = 'Uploading...';
      
      const btn = document.getElementById('nft-mint-btn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Minting...';
      
      const name = document.getElementById('nft-name-input').value || 'PhotoLynk Memory';
      const description = document.getElementById('nft-desc-input').value || '';
      
      try {
        const result = await ipcRenderer.invoke('mint-nft', {
          nftType: selectedNFTType,
          storageOption: selectedNFTStorage,
          filePath: selectedNFTPhoto,
          name: name,
          description: description,
          walletAddress: nftWalletAddress,
        });
        
        if (result.success) {
          btn.innerHTML = '<span>✓</span> ' + (result.message || 'Complete payment in wallet');
          btn.style.background = 'linear-gradient(135deg, #14F195 0%, #10B981 100%)';
          setTimeout(() => {
            closeNFTMint();
            btn.style.background = '';
            isMinting = false;
            // Restore hero after NFT creation
            hero.classList.remove('creating-nft');
            updateServerStatus(serverRunning);
          }, 3000);
        } else {
          throw new Error(result.error || 'Minting failed');
        }
      } catch (e) {
        btn.innerHTML = '<span>✕</span> ' + (e.message || 'Failed');
        btn.style.background = 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)';
        setTimeout(() => {
          isMinting = false;
          btn.style.background = '';
          btn.innerHTML = '<span>⬡</span> Mint NFT';
          updateMintButton();
          // Restore hero after NFT creation failure
          hero.classList.remove('creating-nft');
          updateServerStatus(serverRunning);
        }, 3000);
      }
    }
    
    ipcRenderer.on('mint-progress', (e, data) => {
      document.getElementById('nft-mint-btn').innerHTML = '<span>⏳</span> ' + data.status;
      // Update hero subtitle with progress
      const subtitle = document.getElementById('status-subtitle');
      if (subtitle) subtitle.textContent = data.status;
    });
    
    // Poll for mint success from browser
    let mintSuccessPollInterval = null;
    function startMintSuccessPoll() {
      if (mintSuccessPollInterval) clearInterval(mintSuccessPollInterval);
      mintSuccessPollInterval = setInterval(async () => {
        try {
          const res = await fetch('http://localhost:3000/nft-mint-success');
          const data = await res.json();
          if (data.success) {
            clearInterval(mintSuccessPollInterval);
            mintSuccessPollInterval = null;
            showMintSuccessPopup(data);
          }
        } catch (e) { /* Server not ready */ }
      }, 1000);
      
      // Stop polling after 5 minutes
      setTimeout(() => {
        if (mintSuccessPollInterval) {
          clearInterval(mintSuccessPollInterval);
          mintSuccessPollInterval = null;
        }
      }, 300000);
    }
    
    function showMintSuccessPopup(data) {
      // Bring window to front
      ipcRenderer.send('bring-to-front');
      
      // Create success overlay
      const overlay = document.createElement('div');
      overlay.id = 'mint-success-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
      
      const popup = document.createElement('div');
      popup.style.cssText = 'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #14F195;border-radius:20px;padding:24px;max-width:400px;width:100%;text-align:center;box-shadow:0 0 60px rgba(20,241,149,0.3);';
      
      const solAmount = data.amount ? data.amount.toFixed(6) : '0';
      const usdAmount = data.amount ? (data.amount * 200).toFixed(2) : '0'; // Approximate USD
      
      var nftTypeLabel = data.nftType === 'compressed' ? 'Compressed NFT (cNFT)' : 'Standard NFT';
      var imageHtml = data.imageUrl ? '<img src="' + data.imageUrl + '" style="width:120px;height:120px;border-radius:12px;object-fit:cover;margin-bottom:20px;border:2px solid #9945FF;">' : '';
      var mintAddressHtml = data.mintAddress ? '<div style="display:flex;justify-content:space-between;margin-top:8px;"><span style="color:#888;font-size:12px;">Mint Address</span><span style="color:#fff;font-size:10px;font-family:monospace;">' + data.mintAddress.slice(0,8) + '...' + data.mintAddress.slice(-4) + '</span></div>' : '';
      
      popup.innerHTML = '<div style="font-size:64px;margin-bottom:16px;">🎉</div>' +
        '<h2 style="color:#14F195;font-size:24px;margin-bottom:8px;">NFT Minted!</h2>' +
        '<p style="color:#888;font-size:14px;margin-bottom:20px;">' + nftTypeLabel + '</p>' +
        imageHtml +
        '<div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:16px;margin-bottom:20px;text-align:left;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
            '<span style="color:#888;font-size:12px;">Total Spent</span>' +
            '<span style="color:#14F195;font-size:14px;font-weight:600;">' + solAmount + ' SOL (~$' + usdAmount + ')</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
            '<span style="color:#888;font-size:12px;">Payment TX</span>' +
            '<a href="https://solscan.io/tx/' + data.paymentTx + '" target="_blank" style="color:#9945FF;font-size:12px;text-decoration:none;">' + data.paymentTx.slice(0,8) + '...' + data.paymentTx.slice(-4) + ' ↗</a>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;">' +
            '<span style="color:#888;font-size:12px;">Mint TX</span>' +
            '<a href="https://solscan.io/tx/' + data.mintTx + '" target="_blank" style="color:#9945FF;font-size:12px;text-decoration:none;">' + data.mintTx.slice(0,8) + '...' + data.mintTx.slice(-4) + ' ↗</a>' +
          '</div>' +
          mintAddressHtml +
        '</div>' +
        '<button onclick="this.parentElement.parentElement.remove()" style="width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#14F195 0%,#10B981 100%);color:#000;font-size:16px;font-weight:600;cursor:pointer;">' +
          'Awesome! 🚀' +
        '</button>';
      
      overlay.appendChild(popup);
      document.body.appendChild(overlay);
      
      // Close NFT mint section
      closeNFTMint();
      
      // Refresh album
      loadNFTAlbum();
    }
    
    // Start polling when minting starts
    ipcRenderer.on('mint-progress', () => {
      if (!mintSuccessPollInterval) startMintSuccessPoll();
    });
    
    // NFT Album Functions
    function openNFTAlbum() {
      console.log('[NFT] openNFTAlbum called');
      const overlay = document.getElementById('nft-album-overlay');
      if (overlay) {
        overlay.classList.add('active');
      }
      loadNFTAlbum();
    }
    
    function closeNFTAlbum() {
      const overlay = document.getElementById('nft-album-overlay');
      if (overlay) {
        overlay.classList.remove('active');
      }
      stopNFTAutoRefresh();
    }
    
    // Scroll to show NFT grid with navigation buttons visible
    function scrollToNFTGrid() {
      const nav = document.getElementById('nft-nav');
      if (nav) {
        // Scroll so navigation buttons are visible at bottom
        nav.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } else {
        const section = document.getElementById('nft-album-section');
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      }
    }
    
    let allNFTs = [];
    let nftPageIndex = 0;
    const NFT_PAGE_SIZE = 6; // 2x3 grid
    let nftAutoRefreshInterval = null;
    const NFT_AUTO_REFRESH_MS = 60000; // Check for new NFTs every 60 seconds
    
    // Start auto-refresh when album is open
    function startNFTAutoRefresh() {
      if (nftAutoRefreshInterval) return;
      nftAutoRefreshInterval = setInterval(async () => {
        if (!nftWalletAddress) return;
        console.log('[NFT Album] Auto-checking for new NFTs...');
        try {
          const result = await ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, 1000);
          if (result && result.success && result.nfts) {
            const newCount = result.nfts.length;
            const oldCount = allNFTs.length;
            if (newCount > oldCount) {
              console.log('[NFT Album] Found', newCount - oldCount, 'new NFT(s)!');
              allNFTs = result.nfts;
              renderNFTPage();
            }
          }
        } catch (e) {
          console.log('[NFT Album] Auto-refresh error:', e.message);
        }
      }, NFT_AUTO_REFRESH_MS);
      console.log('[NFT Album] Auto-refresh started (every', NFT_AUTO_REFRESH_MS/1000, 'seconds)');
    }
    
    function stopNFTAutoRefresh() {
      if (nftAutoRefreshInterval) {
        clearInterval(nftAutoRefreshInterval);
        nftAutoRefreshInterval = null;
        console.log('[NFT Album] Auto-refresh stopped');
      }
    }
    
    async function loadNFTAlbum() {
      try {
        const grid = document.getElementById('nft-grid');
        const loading = document.getElementById('nft-loading');
        const empty = document.getElementById('nft-empty');
        
        grid.innerHTML = '';
        loading.style.display = 'flex';
        empty.style.display = 'none';
        allNFTs = [];
        nftPageIndex = 0;
        
        if (!nftWalletAddress) {
          loading.style.display = 'none';
          empty.innerHTML = '<span>Connect wallet to view NFTs</span><button onclick="connectNFTWallet()" style="margin-top:8px;padding:8px 16px;border-radius:8px;border:1px solid #9945FF;background:transparent;color:#9945FF;cursor:pointer;">Connect Wallet</button>';
          empty.style.display = 'flex';
          return;
        }
        
        // Fetch ALL NFTs (limit 1000)
        const result = await ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, 1000);
        loading.style.display = 'none';
        
        if (result && result.success && result.nfts && result.nfts.length > 0) {
          allNFTs = result.nfts;
          console.log('[NFT Album] Total NFTs:', allNFTs.length);
          renderNFTPage();
          // Start auto-refresh to detect new NFTs
          startNFTAutoRefresh();
        } else {
          empty.innerHTML = '<span>No NFTs yet. Mint your first memory!</span>';
          empty.style.display = 'flex';
          // Still start auto-refresh to detect when first NFT is minted
          startNFTAutoRefresh();
        }
      } catch (e) {
        console.error('loadNFTAlbum error:', e);
      }
    }
    
    // Retry fetching image from metadata for NFTs that failed initial load
    async function retryNFTImageFromMetadata(nftIndex, metadataUrl, itemElement, nftName, isCompressed) {
      console.log('[NFT Album] Retrying image fetch for', nftName, 'from metadata');
      try {
        const result = await ipcRenderer.invoke('fetch-nft-image-from-metadata', metadataUrl, isCompressed);
        if (result && result.imageUrl) {
          console.log('[NFT Album] Got image for', nftName, ':', result.imageUrl.slice(0, 50));
          // Update the NFT in allNFTs array
          if (allNFTs[nftIndex]) {
            allNFTs[nftIndex].image = result.imageUrl;
            allNFTs[nftIndex].imageUrl = result.imageUrl;
          }
          // Update the item element with the image
          const gateways = isCompressed ? CNFT_IPFS_GATEWAYS : IPFS_GATEWAYS;
          const cid = extractIPFSCid(result.imageUrl);
          const primaryUrl = cid ? gateways[0] + cid : result.imageUrl;
          
          itemElement.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div><img style="opacity:0;transition:opacity 0.3s;" data-original-url="' + result.imageUrl + '" data-fallback-url="' + result.imageUrl + '" data-gateway-index="0" data-retry-count="0" data-source="primary" data-compressed="' + (isCompressed ? '1' : '0') + '" src="' + primaryUrl + '"><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
          
          const img = itemElement.querySelector('img');
          const spinner = itemElement.querySelector('.nft-spinner');
          if (img) {
            img.onload = () => { 
              img.style.opacity = '1';
              if (spinner) spinner.style.display = 'none';
            };
            img.onerror = () => { handleNFTImageError(img, false); };
            scheduleNFTImageTimeout(img);
          }
        } else {
          console.log('[NFT Album] No image found for', nftName, '- metadata may not have image field');
          itemElement.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);cursor:pointer;" onclick="retrySingleNFT(' + nftIndex + ')"><div style="padding:8px;text-align:center;font-size:10px;color:var(--text-muted);">No image</div><div style="font-size:9px;color:var(--accent);">Tap to retry</div></div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
        }
      } catch (e) {
        console.error('[NFT Album] Retry failed for', nftName, e);
        itemElement.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);cursor:pointer;" onclick="retrySingleNFT(' + nftIndex + ')"><div style="padding:8px;text-align:center;font-size:10px;color:var(--text-muted);">Load failed</div><div style="font-size:9px;color:var(--accent);">Tap to retry</div></div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
      }
    }
    
    // Retry a single NFT's image without resetting the page
    function retrySingleNFT(nftIndex) {
      const nft = allNFTs[nftIndex];
      if (!nft) return;
      
      const metadataUrl = nft.metadataUrl || '';
      const nftName = nft.name || 'NFT #' + (nftIndex + 1);
      const isCompressed = nft.isCompressed === true;
      
      // Find the item element in the grid
      const grid = document.getElementById('nft-grid');
      const startIdx = nftPageIndex * NFT_PAGE_SIZE;
      const localIdx = nftIndex - startIdx;
      const itemElement = grid.children[localIdx];
      
      if (!itemElement) {
        console.log('[NFT Album] Cannot find item element for index', nftIndex);
        return;
      }
      
      console.log('[NFT Album] Retrying single NFT:', nftName, 'index:', nftIndex);
      
      if (metadataUrl) {
        // Show spinner and retry
        itemElement.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div><div style="position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:9px;color:var(--text-muted);">Retrying...</div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
        retryNFTImageFromMetadata(nftIndex, metadataUrl, itemElement, nftName, isCompressed);
      } else {
        // No metadata URL - show error
        itemElement.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);"><div style="padding:8px;text-align:center;font-size:10px;color:var(--text-muted);">No metadata</div></div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
      }
    }
    window.retrySingleNFT = retrySingleNFT;
    
    // NFT Detail View
    let currentDetailNFT = null;
    
    function openNFTDetail(nftIndex) {
      const nft = allNFTs[nftIndex];
      if (!nft) return;
      
      currentDetailNFT = { ...nft, index: nftIndex };
      const isCompressed = nft.isCompressed === true;
      
      // Set image
      const imgEl = document.getElementById('nft-detail-img');
      const imageUrl = nft.cachedPath ? 'file://' + nft.cachedPath : (nft.image || nft.imageUrl || '');
      imgEl.src = imageUrl;
      
      // Set image container class for shadow
      const imageContainer = document.getElementById('nft-detail-image');
      imageContainer.className = 'nft-detail-image ' + (isCompressed ? 'compressed' : 'standard');

      const mintAddr = nft.mintAddress || nft.assetId || nft.mint || '';
      currentDetailNFT.mintAddress = mintAddr;

      const titleEl = document.getElementById('nft-detail-title');
      if (titleEl) titleEl.textContent = nft.name || 'NFT';

      const typeChip = document.getElementById('nft-detail-type-chip');
      if (typeChip) {
        typeChip.className = 'nft-chip ' + (isCompressed ? 'cnft' : 'standard');
        typeChip.textContent = isCompressed ? 'Compressed NFT' : 'Standard NFT';
      }

      const rawImageUrl = (nft && (nft.imageUrl || nft.image)) ? String(nft.imageUrl || nft.image) : '';
      const storageLabel = (nft.storageType ? (nft.storageType === 'cloud' ? 'StealthCloud' : 'IPFS') : (isStealthCloudUrl(rawImageUrl) ? 'StealthCloud' : 'IPFS'));
      const storageChip = document.getElementById('nft-detail-storage-chip');
      if (storageChip) storageChip.textContent = storageLabel;

      const ownerFull = document.getElementById('nft-detail-owner-full');
      if (ownerFull) ownerFull.textContent = nft.ownerAddress || nftWalletAddress || '';

      configureNFTDetailActions(currentDetailNFT, isCompressed, storageLabel);
      verifyNFTDetailOnOpen(currentDetailNFT);
      
      // Show overlay
      document.getElementById('nft-detail-overlay').classList.add('active');
    }
    
    function closeNFTDetail() {
      document.getElementById('nft-detail-overlay').classList.remove('active');
      currentDetailNFT = null;
    }
    
    function verifyNFTOnChain() {
      openNFTTokenView();
    }

    function setNFTVerifyUI(state) {
      const box = document.getElementById('nft-verify-box');
      const text = document.getElementById('nft-verify-text');
      if (!box || !text) return;

      box.className = 'nft-verify-box';
      text.className = 'nft-verify-text pending';

      if (state === 'checking') {
        text.textContent = 'Checking...';
        text.className = 'nft-verify-text pending';
        return;
      }

      if (state === 'verified') {
        box.classList.add('success');
        text.textContent = 'Verified on Solana';
        text.className = 'nft-verify-text success';
        return;
      }

      if (state === 'action') {
        text.textContent = 'Verify on Chain';
        text.className = 'nft-verify-text action';
        return;
      }

      text.textContent = 'Not found on-chain';
      text.className = 'nft-verify-text pending';
    }

    async function verifyNFTDetailOnOpen(nft) {
      try {
        setNFTVerifyUI('checking');
        const mintAddr = nft?.mintAddress || nft?.assetId || nft?.mint || '';
        const txSig = nft?.txSignature || null;
        const res = await ipcRenderer.invoke('verify-nft-on-chain', mintAddr, txSig);
        if (res && res.verified) {
          setNFTVerifyUI('verified');
          if (currentDetailNFT) currentDetailNFT._verified = true;
        } else {
          setNFTVerifyUI('action');
          if (currentDetailNFT) currentDetailNFT._verified = false;
        }
      } catch (e) {
        setNFTVerifyUI('action');
        if (currentDetailNFT) currentDetailNFT._verified = false;
      }
    }

    function handleNFTVerifyClick() {
      if (!currentDetailNFT) return;
      if (currentDetailNFT._verified) {
        openNFTTokenView();
        return;
      }
      verifyNFTDetailOnOpen(currentDetailNFT);
    }

    function configureNFTDetailActions(nft, isCompressed, storageLabel) {
      const left = document.getElementById('nft-action-left');
      const right = document.getElementById('nft-action-right');

      if (left) {
        if (isCompressed) {
          left.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>XRAY</span>';
        } else {
          left.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Solscan</span>';
        }
      }

      if (right) {
        const label = storageLabel === 'StealthCloud' ? 'Image' : 'IPFS';
        right.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>' + label + '</span>';
      }
    }

    function openNFTTokenView() {
      if (!currentDetailNFT) return;
      const isCompressed = currentDetailNFT.isCompressed === true || String(currentDetailNFT.mintAddress || '').startsWith('cnft_');
      const mintAddr = String(currentDetailNFT.mintAddress || currentDetailNFT.assetId || currentDetailNFT.mint || '');

      if (isCompressed) {
        if (mintAddr.startsWith('cnft_tx_')) {
          const txSig = mintAddr.replace('cnft_tx_', '');
          require('electron').shell.openExternal('https://xray.helius.xyz/tx/' + txSig + '?network=mainnet');
          return;
        }
        const assetId = String(currentDetailNFT.assetId || '').trim();
        if (assetId && assetId.length > 30) {
          require('electron').shell.openExternal('https://xray.helius.xyz/token/' + assetId + '?network=mainnet');
          return;
        }
        const txSig = String(currentDetailNFT.txSignature || '').trim();
        if (txSig) {
          require('electron').shell.openExternal('https://xray.helius.xyz/tx/' + txSig + '?network=mainnet');
          return;
        }
        return;
      }

      require('electron').shell.openExternal('https://solscan.io/token/' + encodeURIComponent(mintAddr));
    }

    async function openNFTStorageView() {
      if (!currentDetailNFT) return;
      const isCompressed = currentDetailNFT.isCompressed === true;

      const rawImageUrl = (currentDetailNFT && (currentDetailNFT.imageUrl || currentDetailNFT.image)) ? String(currentDetailNFT.imageUrl || currentDetailNFT.image) : '';
      const isCloud = currentDetailNFT.storageType === 'cloud' || (!currentDetailNFT.storageType && isStealthCloudUrl(rawImageUrl));
      if (isCloud) {
        if (rawImageUrl) require('electron').shell.openExternal(rawImageUrl);
        return;
      }

      let imgUrl = rawImageUrl;
      let cid = extractIPFSCid(imgUrl);

      if (!cid && currentDetailNFT.metadataUrl) {
        try {
          const result = await ipcRenderer.invoke('fetch-nft-image-from-metadata', currentDetailNFT.metadataUrl, isCompressed);
          if (result && result.imageUrl) {
            imgUrl = result.imageUrl;
            cid = extractIPFSCid(imgUrl);
          }
        } catch (e) {}
      }

      if (cid) {
        require('electron').shell.openExternal('https://ipfs.io/ipfs/' + cid);
        return;
      }

      if (imgUrl) {
        require('electron').shell.openExternal(imgUrl);
      }
    }
    
    async function openNFTTransfer() {
      if (!currentDetailNFT) return;
      
      const isCompressed = currentDetailNFT.isCompressed === true;
      const imageUrl = currentDetailNFT.cachedPath ? 'file://' + currentDetailNFT.cachedPath : (currentDetailNFT.image || currentDetailNFT.imageUrl || '');
      
      document.getElementById('nft-transfer-img').src = imageUrl;
      document.getElementById('nft-transfer-name').textContent = currentDetailNFT.name || 'Unnamed NFT';
      document.getElementById('nft-transfer-type').textContent = isCompressed ? 'Compressed NFT' : 'Standard NFT';
      
      const recipientInput = document.getElementById('nft-transfer-recipient');
      const confirmBtn = document.querySelector('.nft-transfer-actions .nft-action-btn.primary');
      const costEl = document.getElementById('nft-transfer-cost');
      
      recipientInput.value = '';
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirm Transfer';
      
      // Add input listener to enable/disable button based on valid address
      recipientInput.oninput = function() {
        const addr = recipientInput.value.trim();
        const isValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
        confirmBtn.disabled = !isValid;
      };
      
      // Fetch real-time fee estimate from Solana network
      costEl.textContent = 'Calculating...';
      try {
        const feeResult = await ipcRenderer.invoke('estimate-transfer-fee', { isCompressed });
        if (feeResult && feeResult.success) {
          const feeSol = feeResult.feeSol;
          // Format with appropriate decimals
          const formatted = feeSol < 0.0001 ? feeSol.toFixed(5) : feeSol.toFixed(5);
          costEl.textContent = '~' + formatted + ' SOL';
        } else {
          // Fallback to hardcoded estimates
          costEl.textContent = isCompressed ? '~0.00008 SOL' : '~0.00204 SOL';
        }
      } catch (e) {
        console.error('[Transfer Fee] Error fetching fee:', e);
        costEl.textContent = isCompressed ? '~0.00008 SOL' : '~0.00204 SOL';
      }
      
      document.getElementById('nft-transfer-modal').classList.add('active');
    }
    
    function closeNFTTransfer() {
      document.getElementById('nft-transfer-modal').classList.remove('active');
    }
    
    async function confirmNFTTransfer() {
      const recipient = document.getElementById('nft-transfer-recipient').value.trim();
      
      if (!recipient) {
        alert('Please enter a recipient wallet address');
        return;
      }
      
      // Validate Solana address (base58, 32-44 chars)
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) {
        alert('Invalid Solana wallet address');
        return;
      }
      
      if (!currentDetailNFT) {
        alert('No NFT selected');
        return;
      }
      
      if (!nftWalletAddress) {
        alert('Please connect your wallet first');
        return;
      }
      
      const confirmBtn = document.querySelector('.nft-transfer-actions .nft-action-btn.primary');
      
      try {
        confirmBtn.textContent = 'Building TX...';
        confirmBtn.disabled = true;
        
        const mintAddr = currentDetailNFT.mintAddress || currentDetailNFT.assetId || currentDetailNFT.mint;
        const isCompressed = currentDetailNFT.isCompressed === true;
        const actualMint = isCompressed ? mintAddr.replace('cnft_', '') : mintAddr;
        
        // Build the transaction in the renderer using web3.js from window
        confirmBtn.textContent = 'Preparing TX...';
        
        // Request transaction building from main process
        const txResult = await ipcRenderer.invoke('build-nft-transfer-tx', {
          mint: actualMint,
          from: nftWalletAddress,
          to: recipient,
          isCompressed: isCompressed
        });
        
        if (!txResult.success) {
          throw new Error(txResult.error || 'Failed to build transaction');
        }
        
        confirmBtn.textContent = 'Opening Phantom...';
        
        // Open browser to sign the transaction via Phantom
        // The transaction is base64 encoded and will be signed in browser
        ipcRenderer.send('open-nft-transfer', {
          transaction: txResult.transaction,
          mint: actualMint,
          recipient: recipient,
          isVersioned: txResult.isVersioned || false
        });
        
        // Poll for transfer completion
        let transferPollInterval = setInterval(async () => {
          try {
            const res = await fetch('http://localhost:3000/nft-transfer-status');
            const data = await res.json();
            if (data.completed) {
              clearInterval(transferPollInterval);
              // Bring app window to front
              ipcRenderer.send('focus-window');
              if (data.success) {
                showTransferSuccessModal(data.signature);
                closeNFTTransfer();
                closeNFTDetail();
                refreshNFTAlbum();
              } else {
                const isCancelled = (data.error || '').toLowerCase().includes('cancel') || (data.error || '').toLowerCase().includes('rejected');
                showTransferCancelledModal(isCancelled);
              }
              confirmBtn.innerHTML = 'Confirm Transfer';
              confirmBtn.disabled = false;
            }
          } catch (e) { /* Server not ready */ }
        }, 1000);
        
        // Stop polling after 3 minutes
        setTimeout(() => {
          clearInterval(transferPollInterval);
          confirmBtn.innerHTML = 'Confirm Transfer';
          confirmBtn.disabled = false;
        }, 180000);
        
        return; // Don't run finally block yet
        
      } catch (e) {
        console.error('[NFT Transfer] Error:', e);
        const isCancelled = e.message?.includes('User rejected') || e.message?.includes('cancel') || e.code === 4001;
        showTransferCancelledModal(isCancelled);
      } finally {
        confirmBtn.innerHTML = 'Confirm Transfer';
        confirmBtn.disabled = false;
      }
    }
    
    window.openNFTDetail = openNFTDetail;
    window.closeNFTDetail = closeNFTDetail;
    window.verifyNFTOnChain = verifyNFTOnChain;
    window.openNFTTokenView = openNFTTokenView;
    window.openNFTStorageView = openNFTStorageView;
    window.handleNFTVerifyClick = handleNFTVerifyClick;
    window.openNFTTransfer = openNFTTransfer;
    window.closeNFTTransfer = closeNFTTransfer;
    window.confirmNFTTransfer = confirmNFTTransfer;
    
    function showTransferSuccessModal(signature) {
      const solscanUrl = 'https://solscan.io/tx/' + signature;
      const shortSig = signature.slice(0, 16) + '...' + signature.slice(-16);
      
      // Create modal overlay
      const modal = document.createElement('div');
      modal.id = 'transfer-success-modal';
      modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = \`
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(20,241,149,0.3);box-shadow:0 20px 60px rgba(20,241,149,0.2);">
          <div style="font-size:56px;margin-bottom:16px;">✅</div>
          <h2 style="color:#14F195;font-size:22px;margin-bottom:8px;">Transfer Successful!</h2>
          <p style="color:#888;font-size:13px;margin-bottom:20px;">Your NFT has been transferred to the new owner.</p>
          
          <div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:16px;margin-bottom:20px;text-align:left;">
            <div style="color:#888;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Transaction Signature</div>
            <div style="color:#fff;font-size:12px;font-family:monospace;word-break:break-all;">\${shortSig}</div>
          </div>
          
          <button onclick="require('electron').shell.openExternal('\${solscanUrl}')" style="width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,#14F195 0%,#0ea66a 100%);color:#000;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;">
            <span>🔗</span> View on Solscan
          </button>
          
          <button onclick="document.getElementById('transfer-success-modal').remove()" style="width:100%;padding:12px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:transparent;color:#888;font-size:13px;cursor:pointer;">
            Close
          </button>
        </div>
      \`;
      document.body.appendChild(modal);
    }
    window.showTransferSuccessModal = showTransferSuccessModal;
    
    function showTransferCancelledModal(isCancelled) {
      const existing = document.getElementById('transfer-cancelled-modal');
      if (existing) existing.remove();
      
      const modal = document.createElement('div');
      modal.id = 'transfer-cancelled-modal';
      modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = \`
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(255,255,255,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.4);">
          <div style="font-size:56px;margin-bottom:16px;">\${isCancelled ? '🚫' : '⚠️'}</div>
          <h2 style="color:#fff;font-size:20px;margin-bottom:8px;">\${isCancelled ? 'Transfer Cancelled' : 'Transfer Failed'}</h2>
          <p style="color:#888;font-size:13px;margin-bottom:24px;">\${isCancelled ? 'You cancelled the transaction in your wallet.' : 'Something went wrong. Please try again.'}</p>
          <button onclick="document.getElementById('transfer-cancelled-modal').remove()" style="width:100%;padding:14px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:transparent;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
            OK
          </button>
        </div>
      \`;
      document.body.appendChild(modal);
    }
    window.showTransferCancelledModal = showTransferCancelledModal;
    
    function renderNFTPage() {
      const grid = document.getElementById('nft-grid');
      grid.innerHTML = '';
      
      const startIdx = nftPageIndex * NFT_PAGE_SIZE;
      const batch = allNFTs.slice(startIdx, startIdx + NFT_PAGE_SIZE);
      
      batch.forEach((nft, i) => {
        const item = document.createElement('div');
        const isCompressed = nft.isCompressed === true;
        const globalIdx = startIdx + i;
        item.className = 'nft-item ' + (isCompressed ? 'compressed' : 'standard');
        item.onclick = () => openNFTDetail(globalIdx);
        const imageUrl = nft.image || nft.imageUrl || '';
        const originalUrl = nft.imageUrl || imageUrl;  // Keep original for fallback
        const nftName = nft.name || 'NFT #' + (startIdx + i + 1);
        const isCached = nft.cachedPath && imageUrl.startsWith('/');
        
        if (!imageUrl) {
          // Show spinner and try to fetch image from metadata URL
          const metadataUrl = nft.metadataUrl || '';
          const nftIndex = startIdx + i;
          // Always try to fetch if we have metadata URL (even if previous attempt failed)
          if (metadataUrl) {
            item.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div><div style="position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:9px;color:var(--text-muted);">Loading...</div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
            grid.appendChild(item);
            // Try to fetch image from metadata in background
            console.log('[NFT Album] No image for', nftName, '- retrying from metadata:', metadataUrl.slice(0, 50));
            retryNFTImageFromMetadata(nftIndex, metadataUrl, item, nftName, isCompressed);
          } else {
            // No metadata URL either - show placeholder with retry button
            const globalIdx = startIdx + i;
            item.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);cursor:pointer;" onclick="retrySingleNFT(' + globalIdx + ')"><div style="padding:8px;text-align:center;font-size:10px;color:var(--text-muted);">No image</div><div style="font-size:9px;color:var(--accent);">Tap to retry</div></div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
            grid.appendChild(item);
          }
          return;
        }
        
        // Use cached local file if available, otherwise use IPFS gateway
        let primaryUrl = imageUrl;
        if (isCached) {
          // Local file path - use file:// protocol
          primaryUrl = 'file://' + imageUrl;
          console.log('[NFT Album] Using cached:', nftName);
        } else {
          const cid = extractIPFSCid(imageUrl);
          if (cid) {
            const gateways = isCompressed ? CNFT_IPFS_GATEWAYS : IPFS_GATEWAYS;
            primaryUrl = gateways[0] + cid;
          }
          console.log('[NFT Album] Loading', nftName, (isCompressed ? '(cNFT)' : ''), ':', primaryUrl.slice(0, 50) + '...');
        }
        
        // Add loading spinner that shows until image loads, with badge for compressed/standard
        const badgeHtml = isCompressed 
          ? '<div class="nft-badge nft-badge-cnft"><span class="badge-text">cN</span></div>' 
          : '<div class="nft-badge nft-badge-standard"><span class="badge-hex">⬡</span></div>';
        item.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div>' + badgeHtml + '<img style="opacity:0;transition:opacity 0.3s;" data-original-url="' + originalUrl + '" data-fallback-url="' + originalUrl + '" data-gateway-index="0" data-retry-count="0" data-source="primary" data-compressed="' + (isCompressed ? '1' : '0') + '" data-cached="' + (isCached ? '1' : '0') + '" src="' + primaryUrl + '"><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
        grid.appendChild(item);

        const img = item.querySelector('img');
        const spinner = item.querySelector('.nft-spinner');
        if (img) {
          img.dataset.loaded = '0';
          img.onload = () => { 
            img.dataset.loaded = '1'; 
            img.style.opacity = '1';
            if (spinner) spinner.style.display = 'none';
            clearNFTImageTimeout(img); 
          };
          img.onerror = () => { clearNFTImageTimeout(img); handleNFTImageError(img, false); };
          // Skip timeout for cached images - they load instantly
          if (!isCached) scheduleNFTImageTimeout(img);
        }
      });
      
      updateNFTNavigation();
      
      // Scroll to show the grid and navigation after content renders
      setTimeout(() => scrollToNFTGrid(), 300);
    }
    
    function updateNFTNavigation() {
      let navContainer = document.getElementById('nft-nav');
      if (!navContainer) return;
      
      const totalPages = Math.ceil(allNFTs.length / NFT_PAGE_SIZE);
      const currentPage = nftPageIndex + 1;
      const hasPrev = nftPageIndex > 0;
      const hasNext = nftPageIndex < totalPages - 1;
      
      // Solana app style navigation buttons
      const prevBtnStyle = hasPrev 
        ? 'flex:1;padding:12px;border:1px solid #9945FF;border-radius:10px;background:rgba(153,69,255,0.1);color:#9945FF;cursor:pointer;font-size:13px;font-weight:500;' 
        : 'flex:1;padding:12px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text-muted);cursor:default;font-size:13px;font-weight:500;';
      const nextBtnStyle = hasNext 
        ? 'flex:1;padding:12px;border:1px solid #9945FF;border-radius:10px;background:rgba(153,69,255,0.1);color:#9945FF;cursor:pointer;font-size:13px;font-weight:500;' 
        : 'flex:1;padding:12px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text-muted);cursor:default;font-size:13px;font-weight:500;';
      navContainer.innerHTML = '<button onclick="nftPrevPage()" style="' + prevBtnStyle + '"' + (hasPrev ? '' : ' disabled') + '>‹ Prev</button><span style="font-size:12px;color:var(--text-secondary);font-weight:500;">' + currentPage + ' / ' + totalPages + '</span><button onclick="nftNextPage()" style="' + nextBtnStyle + '"' + (hasNext ? '' : ' disabled') + '>Next ›</button>';
    }
    
    function nftPrevPage() {
      if (nftPageIndex > 0) {
        nftPageIndex--;
        renderNFTPage();
      }
    }
    
    function nftNextPage() {
      const totalPages = Math.ceil(allNFTs.length / NFT_PAGE_SIZE);
      if (nftPageIndex < totalPages - 1) {
        nftPageIndex++;
        renderNFTPage();
      }
    }
    
    window.nftPrevPage = nftPrevPage;
    window.nftNextPage = nftNextPage;
    
    async function refreshNFTAlbum() { 
      console.log('[NFT Album] Refreshing - clearing cache and rescanning...');
      try {
        await ipcRenderer.invoke('clear-nft-cache');
        console.log('[NFT Album] Cache cleared');
      } catch (e) {
        console.log('[NFT Album] Cache clear failed:', e.message);
      }
      loadNFTAlbum(); 
    }

    // Ensure inline handlers (onclick/onerror) can access NFT functions
    window.openNFTMint = openNFTMint;
    window.closeNFTMint = closeNFTMint;
    window.selectNFTType = selectNFTType;
    window.selectNFTStorage = selectNFTStorage;
    window.selectNFTPhoto = selectNFTPhoto;
    window.removeNFTPhoto = removeNFTPhoto;
    window.connectNFTWallet = connectNFTWallet;
    window.doMintNFT = doMintNFT;
    window.openNFTAlbum = openNFTAlbum;
    window.closeNFTAlbum = closeNFTAlbum;
    window.refreshNFTAlbum = refreshNFTAlbum;
    window.handleNFTImageError = handleNFTImageError;

    // Ensure other inline handlers work reliably
    window.showView = showView;
    window.startBackup = startBackup;
    window.startSync = startSync;
    window.cancelOperation = cancelOperation;
    window.selectDestination = selectDestination;
    window.addFolder = addFolder;
    window.removeFolder = removeFolder;
    window.clearFolders = clearFolders;
    window.openUploadsFolder = openUploadsFolder;
    window.copyUploadsPath = copyUploadsPath;
    window.addUploadsToSources = addUploadsToSources;
    
    ipcRenderer.on('wallet-connected', (e, address) => {
      nftWalletAddress = address;
      updateMintWalletUI();
      loadNFTAlbum();
    });
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
  
  // DevTools disabled for production
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
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
      contextIsolation: false,
      webSecurity: false
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
      --accent: #03E1FF;           /* Ocean blue - main accent */
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
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

ipcMain.on('set-auto-start', (event, enabled) => {
  startOnBoot = enabled;
  setAutostart(startOnBoot);
  store.set('startOnBoot', startOnBoot);
  safeConsole('log', 'Auto-start set to:', startOnBoot);
});

ipcMain.on('get-auto-start', (event) => {
  const enabled = store.get('startOnBoot', true); // Default to true
  startOnBoot = enabled;
  event.reply('auto-start-status', enabled);
});

// ============================================================================
// NFT IPC HANDLERS
// ============================================================================

let connectedWalletAddress = null;

// Initialize NFT module on app ready
app.whenReady().then(() => {
  const appDataPath = app.getPath('userData');
  nftDesktop.initCache(appDataPath);
  nftDesktop.initNFTStorage(appDataPath);
  nftDesktop.initializeSolana();
});

ipcMain.on('open-nft-mint', () => {
  const credentials = store.get('backupCredentials') || {};
  nftDesktop.openNFTMintWindow(app.getPath('userData'), credentials);
});

ipcMain.on('open-nft-album', () => {
  nftDesktop.openNFTAlbumWindow(app.getPath('userData'), connectedWalletAddress);
});

ipcMain.on('open-wallet-connect', () => {
  // Skip the popup - open browser directly for Phantom connection
  const { shell } = require('electron');
  shell.openExternal('http://localhost:3000/wallet-connect');
});

ipcMain.on('open-nft-transfer', (event, { transaction, mint, recipient, isVersioned }) => {
  // Open browser to sign the NFT transfer transaction via Phantom
  const { shell } = require('electron');
  const params = new URLSearchParams({
    tx: transaction,
    mint: mint,
    to: recipient,
    versioned: isVersioned ? '1' : '0'
  });
  shell.openExternal('http://localhost:3000/nft-transfer-sign?' + params.toString());
});

ipcMain.on('focus-window', () => {
  // Bring the main window to front after transfer completes
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    
    // Linux-specific: setAlwaysOnTop trick to force focus
    if (process.platform === 'linux') {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);
    } else {
      mainWindow.focus();
    }
  }
});

ipcMain.handle('select-photo-for-nft', async () => {
  const parentWindow = mainWindow || null;
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'] }
    ],
    title: 'Select Photo for NFT'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

ipcMain.handle('fetch-user-nfts', async (event, walletAddress, limit) => {
  return await nftDesktop.fetchUserNFTs(walletAddress, limit);
});

ipcMain.handle('fetch-nft-image-from-metadata', async (event, metadataUrl, isCompressed) => {
  try {
    const imageUrl = await nftDesktop.fetchImageFromMetadata(metadataUrl, isCompressed);
    return { imageUrl };
  } catch (e) {
    console.error('[NFT] Failed to fetch image from metadata:', e.message);
    return { imageUrl: '' };
  }
});

ipcMain.handle('clear-nft-cache', async () => {
  try {
    nftDesktop.clearCache();
    return { success: true };
  } catch (e) {
    console.error('[NFT] Failed to clear cache:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('mint-nft', async (event, data) => {
  safeConsole('log', '[NFT] Mint request:', data);
  
  // Get credentials for StealthCloud upload
  const credentials = store.get('backupCredentials') || {};
  const mintParams = {
    ...data,
    credentials: credentials.baseUrl ? {
      baseUrl: credentials.baseUrl,
      token: credentials.token,
      deviceUuid: credentials.deviceUuid,
    } : null,
  };
  
  // Use nftDesktop.mintNFT which handles upload and opens wallet for payment
  const result = await nftDesktop.mintNFT(mintParams, (progress) => {
    // Send progress to renderer
    event.sender.send('mint-progress', progress);
  });
  
  return result;
});

ipcMain.on('bring-to-front', () => {
  // Bring main window to front when wallet connected
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    
    // Linux-specific: setAlwaysOnTop trick to force focus
    if (process.platform === 'linux') {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);
    } else {
      mainWindow.focus();
    }
  }
});

ipcMain.on('wallet-connected-from-browser', (event, address) => {
  connectedWalletAddress = address;
  // Broadcast to all windows
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('wallet-connected', address);
  });
});

// NFT Storage handlers (same as mobile)
ipcMain.handle('get-stored-nfts', async () => {
  return await nftDesktop.getStoredNFTs();
});

ipcMain.handle('get-nft-by-mint', async (event, mintAddress) => {
  return await nftDesktop.getNFTByMintAddress(mintAddress);
});

ipcMain.handle('sync-nfts-from-server', async () => {
  const credentials = store.get('backupCredentials') || {};
  if (!credentials.baseUrl || !credentials.token) {
    return { success: false, error: 'Not authenticated' };
  }
  return await nftDesktop.syncNFTsFromServer(credentials.baseUrl, { Authorization: credentials.token });
});

// NFT Verification handler (same as mobile)
ipcMain.handle('verify-nft-on-chain', async (event, mintAddress, txSignature) => {
  return await nftDesktop.verifyNFTOnChain(mintAddress, txSignature);
});

// Estimate NFT transfer fee from Solana network
ipcMain.handle('estimate-transfer-fee', async (event, { isCompressed }) => {
  try {
    const result = await nftDesktop.estimateTransferFee(isCompressed);
    return result;
  } catch (e) {
    console.error('[Estimate Transfer Fee] Error:', e);
    return { success: false, error: e.message };
  }
});

// NFT Transfer - build transaction for signing using nftDesktop module
ipcMain.handle('build-nft-transfer-tx', async (event, { mint, from, to, isCompressed }) => {
  try {
    // Use nftDesktop's transferNFT which handles both standard and compressed NFTs
    const result = await nftDesktop.buildTransferTransaction(mint, from, to, isCompressed);
    return result;
  } catch (e) {
    console.error('[Build NFT Transfer TX] Error:', e);
    return { success: false, error: e.message };
  }
});

// Confirm transaction after Phantom signs and sends
ipcMain.handle('confirm-transaction', async (event, signature) => {
  try {
    const { Connection } = require('@solana/web3.js');
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=***REMOVED***', 'confirmed');
    
    const result = await connection.confirmTransaction(signature, 'confirmed');
    return { success: !result.value.err, error: result.value.err };
  } catch (e) {
    console.error('[Confirm TX] Error:', e);
    return { success: false, error: e.message };
  }
});

// Domain resolution handler (same as mobile)
ipcMain.handle('resolve-recipient', async (event, input) => {
  return await nftDesktop.resolveRecipient(input);
});

// Get explorer/solscan URLs
ipcMain.handle('get-explorer-url', (event, txSignature, type) => {
  return nftDesktop.getExplorerUrl(txSignature, type);
});

ipcMain.handle('get-solscan-url', (event, mintAddress) => {
  return nftDesktop.getSolscanUrl(mintAddress);
});

// Get current fees (for UI display)
ipcMain.handle('get-nft-fees', () => {
  return {
    fees: nftDesktop.getCurrentFees(),
    isPromo: nftDesktop.isPromoActive(),
    promoDaysRemaining: nftDesktop.getPromoDaysRemaining(),
  };
});

// Get SOL price
ipcMain.handle('get-sol-price', async () => {
  return await nftDesktop.getSolPrice();
});

// Real-time NFT cost estimate (SOL price + network fee signals)
ipcMain.handle('estimate-nft-costs', async (event, { nftType, storageOption, filePath } = {}) => {
  try {
    let fileSizeBytes = 0;
    if (filePath) {
      try {
        fileSizeBytes = fs.statSync(filePath).size;
      } catch (e) {
        fileSizeBytes = 0;
      }
    }
    return await nftDesktop.estimateNftCostsRealtime({ nftType, storageOption, fileSizeBytes });
  } catch (e) {
    return { error: e.message };
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
      contextIsolation: false,
      webSecurity: false
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
      --accent: #03E1FF;           /* Ocean blue - main accent */
      --accent-hover: #02C4E0;
      --text-primary: #FFFFFF;
      --text-secondary: #AAAAAA;
      --text-muted: #666666;
      --border: rgba(255, 255, 255, 0.15);
      --success: #4ADE80;          /* Green for success */
      --error: #F87171;            /* Red for errors */
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
          <label>Email / Nickname / Seeker ID</label>
          <input type="text" id="email" placeholder="email, nickname, or name.skr" value="${credentials.email || ''}">
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
      
      // Store token and baseUrl for NFT StealthCloud uploads
      const stealthCloudBaseUrl = 'https://api.stealthlynk.com';
      store.set('backupCredentials', {
        ...store.get('backupCredentials'),
        baseUrl: stealthCloudBaseUrl,
        token: checkClient.token,
        deviceUuid: checkClient.deviceUuid,
      });
      
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
    safeConsole('log', `[SYNC] Config received:`, JSON.stringify({ source: config.source, email: config.email, downloadPath: config.downloadPath, hasPassword: !!config.password }));
    
    store.set('backupCredentials', {
      email: config.email,
      password: config.password,
      remoteAddress: config.remoteAddress,
      remotePort: config.remotePort
    });
    
    // Compute UUID v5 from email:password and ensure we save to user folder
    const userUuid = computeUserUuidSync(config.email, config.password);
    let downloadPath = config.downloadPath;
    
    // If downloadPath doesn't already contain the UUID, append it
    if (userUuid && !downloadPath.includes(userUuid)) {
      downloadPath = path.join(uploadsPath, userUuid);
      safeConsole('log', `[SYNC] Computed user UUID: ${userUuid}`);
    }
    
    safeConsole('log', `[SYNC] Saving to: ${downloadPath}`);
    store.set('syncDownloadPath', downloadPath);
    
    // Update config with correct path
    config.downloadPath = downloadPath;
    
    event.reply('sync-progress', { message: 'Connecting...', progress: 0.02 });
    
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }
    
    const { DesktopSyncClient } = require('./sync-client');
    activeSyncClient = new DesktopSyncClient(config, (progress) => {
      event.reply('sync-progress', progress);
    });
    
    startBackupPowerSaveBlocker();
    
    const result = await activeSyncClient.sync();
    
    // Store credentials after sync for NFT StealthCloud uploads
    if (activeSyncClient.token) {
      const stealthCloudBaseUrl = 'https://api.stealthlynk.com';
      store.set('backupCredentials', {
        ...store.get('backupCredentials'),
        baseUrl: stealthCloudBaseUrl,
        token: activeSyncClient.token,
        deviceUuid: activeSyncClient.deviceUuid,
      });
    }
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
  
  // Start pairing server to receive credentials from mobile
  startPairingServer();
  
  // Check if this is the first run and whether we've shown the welcome dialog
  const hasRunBefore = !!store.get('hasRunBefore');
  const welcomeShown = !!store.get('welcomeShown');
  const isFirstRun = !hasRunBefore;

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
  
  // Build context menu for tray
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open PhotoLynk', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; stopServer(); app.quit(); } }
  ]);
  
  // Linux: must use setContextMenu as right-click event doesn't work reliably
  if (process.platform === 'linux') {
    tray.setContextMenu(contextMenu);
  }
  
  // Left-click opens the main window (unified app UI)
  tray.on('click', () => {
    showMainWindow();
  });
  
  // Right-click shows context menu (Windows/macOS)
  tray.on('right-click', () => {
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
  
  // On first run (or if welcome never shown), open the main window and show system tray info
  if (isFirstRun || !welcomeShown) {
    setTimeout(() => {
      // Ensure the main window is visible/focused (Linux sometimes starts hidden)
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      
      // Show platform-specific system tray info dialog once
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
      store.set('welcomeShown', true);
    }, 1200);
  }
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when windows are closed
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackupPowerSaveBlocker();
  stopPairingServer();
  
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
  
  // On Windows, also kill any orphaned PhotoLynk processes by name
  if (process.platform === 'win32') {
    try {
      // Kill any remaining PhotoLynk Desktop processes (child Node processes)
      execSync('taskkill /F /IM "PhotoLynk Desktop.exe" /T', { stdio: 'ignore' });
    } catch (e) {
      // Ignore - no processes found or already killed
    }
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
