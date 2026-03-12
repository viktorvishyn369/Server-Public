require('dotenv').config();
const { app, Tray, Menu, shell, nativeImage, Notification, clipboard, BrowserWindow, ipcMain, powerSaveBlocker, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const Store = require('electron-store');
const nftDesktop = require('./nftDesktop');
const { runExifBackfill, cancelExifBackfill, signalBusy: exifBackfillBusy, signalIdle: exifBackfillIdle } = require('./exifBackfill');

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

// EXIF backfill: trigger after backup/sync completes if StealthCloud credentials available
function maybeStartExifBackfill() {
  try {
    const credentials = store.get('backupCredentials') || {};
    const backupFolders = store.get('backupFolders') || [];
    if (!credentials.baseUrl || !credentials.token || backupFolders.length === 0) return;
    setTimeout(() => {
      runExifBackfill({
        serverUrl: credentials.baseUrl,
        token: credentials.token,
        deviceUuid: credentials.deviceUuid || '',
        backupFolders,
        store,
      }).catch(e => console.error('[ExifBackfill] Fatal:', e?.message));
    }, 10000); // 10s delay to let UI settle
  } catch (e) {
    console.warn('[ExifBackfill] trigger error:', e?.message);
  }
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
  
  serverProcess = spawn(nodeExecutable, ['--max-old-space-size=512', serverEntry], {
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
      // Only get PIDs for LISTENING connections - TIME_WAIT has PID 0 and doesn't block binding
      let out = '';
      try {
        out = execSync('netstat -ano | findstr :3000 | findstr LISTENING', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      } catch (e) {
        // No LISTENING entries found
        return [];
      }
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pids = new Set();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
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
      // Only LISTENING state actually blocks binding - ignore TIME_WAIT, CLOSE_WAIT, etc.
      const out = execSync('netstat -ano | findstr :3000 | findstr LISTENING', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).toString();
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
  
  // Refresh in main window (QR modal) - preload new image before swapping
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
          
          // Store credentials securely (include device_uuid + legacy MK creds for migrated users)
          const creds = {
            email: email,
            password: password,
            remoteAddress: '',
            remotePort: '3000'
          };
          if (data.device_uuid) creds.device_uuid = data.device_uuid;
          if (data.mk_email) creds.mk_email = data.mk_email;
          if (data.mk_password) creds.mk_password = data.mk_password;
          store.set('backupCredentials', creds);
          
          // Generate new pairing token for security (one-time use)
          const newToken = generatePairingToken();
          store.set('pairingToken', newToken);
          
          // Refresh QR code in main window with new token
          refreshQRCodeInMainWindow();
          
          safeConsole('log', '[Pairing] Credentials received from mobile for:', email);
          
          // Use device_uuid from mobile if provided (critical for wallet-migrated users
          // where email:password no longer derives the correct legacy UUID).
          // Fall back to computing from email:password for older mobile versions.
          const userUuid = data.device_uuid || computeUserUuidSync(email, password);
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
                    uuidLocked = true;
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
              const stealthCloudBaseUrl = 'https://stealthlynk.io';
              const { DesktopBackupClient } = require('./backup-client');
              const authClient = new DesktopBackupClient({
                destination: 'stealthcloud',
                email: email,
                password: password,
                serverUrl: stealthCloudBaseUrl,
                device_uuid: data.device_uuid || undefined,
                mk_email: data.mk_email || undefined,
                mk_password: data.mk_password || undefined,
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
                maybeStartExifBackfill();
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
                
                // Close QR pairing modal first
                if (typeof closePairModal === 'function') closePairModal();
                
                // Create success popup overlay
                var overlay = document.createElement('div');
                overlay.id = 'pairing-success-overlay';
                overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;';
                
                var popup = document.createElement('div');
                popup.style.cssText = 'background:#1a1a2e;border:1px solid #03E1FF;border-radius:16px;padding:32px;text-align:center;max-width:300px;overflow:hidden;box-shadow:0 0 40px rgba(3,225,255,0.3);';
                
                popup.innerHTML = '<div style="font-size:48px;margin-bottom:16px;">✓</div>' +
                  '<div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:8px;">Paired Successfully</div>' +
                  '<div style="font-size:13px;color:#888;margin-bottom:20px;word-break:break-all;overflow-wrap:break-word;max-width:100%;">${email.replace(/'/g, "\\'")}</div>' +
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
  // Prefer device_uuid from mobile pairing (critical for wallet-migrated users
  // where email:password would derive a different UUID than the legacy one)
  let initialUploadsPath = uploadsPath;
  if (credentials.device_uuid) {
    initialUploadsPath = path.join(uploadsPath, credentials.device_uuid);
  } else if (credentials.email && credentials.password) {
    const userUuid = computeUserUuidSync(credentials.email, credentials.password);
    if (userUuid) {
      initialUploadsPath = path.join(uploadsPath, userUuid);
    }
  }
  const currentVersion = (app && typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0').trim();
  
  mainWindow = new BrowserWindow({
    width: 472,
    height: 802,
    minWidth: 360,
    minHeight: 600,
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
  const iconBase64 = ''; // Temporarily disable to reduce data URL size
  const iconDataUrl = '';
  
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
    html, body { height: 100%; overflow: hidden; overflow-x: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); display: flex; flex-direction: column; height: 100vh; position: relative; max-width: 100vw; overflow-x: hidden; }
    
    /* Views */
    .view { display: none; flex-direction: column; height: 100%; }
    .view.active { display: flex; }

    /* Settings overlay panel — covers content area only, not header or tab bar */
    .settings-overlay { display: none; flex-direction: column; flex: 1; overflow-y: auto; background: var(--bg-primary); padding: 0 12px 12px; gap: 10px; }
    .settings-overlay.open { display: flex; }
    
    /* Header — gradient border */
    .header { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; position: relative; }
    .header::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(37,37,48,0.6), transparent); }
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
    
    /* Quick Stats Card — matches Solana mobile style */
    .quick-stats { margin: 8px 12px; padding: 6px 8px; background: linear-gradient(135deg, rgba(0,255,163,0.07) 0%, #111114 50%, rgba(0,255,163,0.03) 100%); border: none; border-radius: 16px; transition: all 0.3s; position: relative; overflow: hidden; }
    .quick-stats::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 60%; background: linear-gradient(180deg, rgba(0,255,163,0.09) 0%, rgba(0,255,163,0.03) 40%, transparent 100%); pointer-events: none; border-radius: 16px 16px 0 0; }
    .quick-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; background: transparent; border-radius: 10px; overflow: hidden; position: relative; z-index: 1; }
    .qs-cell { background: transparent; padding: 8px 6px; display: flex; align-items: center; gap: 8px; overflow: hidden; min-width: 0; }
    .qs-icon { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 13px; }
    .qs-text { min-width: 0; flex: 1; }
    .qs-label { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: var(--text-muted); line-height: 1; margin-bottom: 2px; }
    .qs-value { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
    .qs-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .qs-dot.green { background: #00FFA3; box-shadow: 0 0 6px rgba(0,255,163,0.5); }
    .qs-dot.red { background: #EF4444; box-shadow: 0 0 6px rgba(239,68,68,0.5); }
    .qs-dot.yellow { background: #F59E0B; box-shadow: 0 0 6px rgba(245,158,11,0.5); }
    /* Active operation state — hides grid, shows inline progress */
    .quick-stats.active-op { text-align: center; }
    .quick-stats.active-op .quick-stats-grid { display: none; }
    .quick-stats.active-op .qs-progress { display: flex; }
    .qs-progress { display: none; flex-direction: column; align-items: center; padding: 4px 0; }
    .qs-progress-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .qs-progress-title.backing-up { color: var(--accent); }
    .qs-progress-title.syncing { color: var(--success); }
    .qs-progress-title.creating-nft { color: #A855F7; }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.8; } }
    
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
    
    /* Content — now sits between header/status and tab bar */
    .content { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 10px; }
    
    /* Tab panels — only active one is visible */
    .tab-panel { display: none; flex-direction: column; gap: 10px; }
    .tab-panel.active { display: flex; }
    
    /* Section header with colored dot */
    .section-dot { width: 4px; height: 16px; border-radius: 2px; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
    .section-header-row { display: flex; align-items: center; gap: 8px; margin: 4px 0 2px 4px; }
    .section-header-label { font-size: 11px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; }
    .section-header-sub { font-size: 10px; color: var(--text-muted); margin-top: 1px; }
    
    /* Coming soon card — glow border */
    .coming-soon-card { background: linear-gradient(135deg, rgba(17,17,20,0.95) 0%, rgba(17,17,20,0.8) 100%); border-radius: 14px; border: 1px solid var(--border); padding: 24px 20px; text-align: center; transition: all 0.2s ease; }
    .coming-soon-card:hover { border-color: rgba(255,255,255,0.15); }
    .coming-soon-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; }
    .coming-soon-title { font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; }
    .coming-soon-sub { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    
    /* Bottom Tab Bar — glass effect */
    .tab-bar { display: flex; background: linear-gradient(180deg, rgba(12,12,16,0.88) 0%, #0C0C10 100%); border-top: none; padding: 6px 8px; flex-shrink: 0; position: relative; }
    .tab-bar::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(26,26,36,0.5), transparent); }
    .tab-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; cursor: pointer; padding: 4px 0; border-radius: 8px; transition: all 0.2s ease; }
    .tab-item:hover { background: rgba(255,255,255,0.04); }
    .tab-item-icon { width: 36px; height: 28px; border-radius: 14px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; }
    .tab-item.active .tab-item-icon { opacity: 1; }
    .tab-item svg { width: 20px; height: 20px; transition: filter 0.2s; }
    .tab-item-label { font-size: 10px; font-weight: 600; letter-spacing: 0.3px; color: #55556A; transition: all 0.2s ease; }
    .tab-item.active .tab-item-label { font-weight: 700; }
    /* Tab colors — with glow */
    .tab-item[data-tab="home"] { color: #55556A; }
    .tab-item[data-tab="home"].active { color: #03E1FF; }
    .tab-item[data-tab="home"].active .tab-item-label { color: #03E1FF; text-shadow: 0 0 8px rgba(3,225,255,0.5); }
    .tab-item[data-tab="home"].active .tab-item-icon { background: linear-gradient(180deg, rgba(3,225,255,0.2) 0%, rgba(3,225,255,0.08) 100%); }
    .tab-item[data-tab="home"].active svg { filter: drop-shadow(0 0 4px rgba(3,225,255,0.4)); }
    .tab-item[data-tab="info"] { color: #55556A; }
    .tab-item[data-tab="info"].active { color: #D4AF37; }
    .tab-item[data-tab="info"].active .tab-item-label { color: #D4AF37; text-shadow: 0 0 8px rgba(212,175,55,0.5); }
    .tab-item[data-tab="info"].active .tab-item-icon { background: linear-gradient(180deg, rgba(212,175,55,0.2) 0%, rgba(212,175,55,0.08) 100%); }
    .tab-item[data-tab="info"].active svg { filter: drop-shadow(0 0 4px rgba(212,175,55,0.4)); }
    .tab-item[data-tab="settings"] { color: #55556A; }
    .tab-item[data-tab="settings"].active { color: #8888A0; }
    .tab-item[data-tab="settings"].active .tab-item-label { color: #8888A0; text-shadow: 0 0 8px rgba(136,136,160,0.5); }
    .tab-item[data-tab="settings"].active .tab-item-icon { background: linear-gradient(180deg, rgba(136,136,160,0.2) 0%, rgba(136,136,160,0.08) 100%); }
    .tab-item[data-tab="settings"].active svg { filter: drop-shadow(0 0 4px rgba(136,136,160,0.4)); }
    
    /* Action Buttons — subtle transparent gradient matching mobile */
    .action-row { display: flex; gap: 8px; }
    .action-btn { flex: 1; display: flex; align-items: center; padding: 12px; border-radius: 14px; cursor: pointer; transition: all 0.2s ease; transform: scale(1); }
    .action-btn.primary { background: linear-gradient(135deg, rgba(3,225,255,0.15) 0%, rgba(3,225,255,0.06) 100%); border: none; }
    .action-btn.secondary { background: linear-gradient(135deg, rgba(0,255,163,0.15) 0%, rgba(0,255,163,0.06) 100%); border: none; }
    .action-btn:hover { transform: scale(1.02) translateY(-1px); }
    .action-btn.primary:hover { }
    .action-btn.secondary:hover { }
    .action-btn:active { transform: scale(0.97); }
    .action-btn-icon { width: 36px; height: 36px; border-radius: 10px; background: rgba(0,0,0,0.12); display: flex; align-items: center; justify-content: center; margin-right: 10px; }
    .action-btn-icon svg { width: 20px; height: 20px; stroke: #FFF; fill: none; }
    .action-btn-text { flex: 1; text-align: left; }
    .action-btn-title { font-size: 14px; font-weight: 700; color: #FFF; }
    .action-btn-subtitle { font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 2px; }
    .action-btn-arrow { font-size: 18px; color: rgba(255,255,255,0.4); }
    
    /* Collapsible section toggle */
    .section-toggle { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 6px 0; user-select: none; }
    .section-toggle:hover .section-toggle-arrow { color: var(--text-primary); }
    .section-toggle-arrow { font-size: 14px; color: var(--text-muted); transition: transform 0.2s, color 0.2s; }
    .section-toggle-arrow.open { transform: rotate(180deg); }
    .collapsible { display: none; }
    .collapsible.open { display: block; }

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
    
    /* Pair Mobile trigger button */
    .pair-btn { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: linear-gradient(135deg, rgba(3,225,255,0.08) 0%, rgba(3,225,255,0.03) 100%); border: 1px solid rgba(3,225,255,0.2); border-radius: 12px; cursor: pointer; transition: all 0.2s; }
    .pair-btn:hover { background: rgba(3,225,255,0.12); border-color: rgba(3,225,255,0.4); }
    .pair-btn-icon { font-size: 18px; }
    .pair-btn-text { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .pair-btn-sub { font-size: 11px; color: var(--text-secondary); }
    .pair-btn-arrow { font-size: 18px; color: var(--text-muted); margin-left: auto; }

    /* QR Pairing Modal Overlay */
    .qr-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 9000; align-items: center; justify-content: center; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    .qr-overlay.open { display: flex; }
    .qr-modal { background: linear-gradient(135deg, #111114 0%, #0a0a0d 100%); border: 1px solid var(--border); border-radius: 20px; padding: 28px; max-width: 340px; width: 90%; text-align: center; position: relative; box-shadow: 0 0 60px rgba(3,225,255,0.1); }
    .qr-modal-close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border-radius: 50%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .qr-modal-close:hover { background: rgba(255,255,255,0.12); color: var(--text-primary); }
    .qr-modal h3 { font-size: 17px; font-weight: 700; margin-bottom: 6px; color: var(--text-primary); }
    .qr-modal p { font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 20px; }
    .qr-container { background: #fff; padding: 14px; border-radius: 14px; display: inline-block; margin-bottom: 16px; }
    .qr-code { width: 180px; height: 180px; display: block; }
    .ip-badge { padding: 8px 14px; background: rgba(3,225,255,0.1); border: 1px solid rgba(3,225,255,0.3); border-radius: 8px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
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
    .progress-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 100; align-items: center; justify-content: center; pointer-events: none; }
    .progress-overlay.visible { display: flex; pointer-events: auto; }
    .progress-box { background: var(--bg-card); border-radius: 20px; padding: 32px; width: 320px; text-align: center; }
    .progress-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
    .progress-text { font-size: 13px; color: var(--text-secondary); margin-bottom: 20px; }
    .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #03E1FF, #4ADE80); width: 0%; transition: width 0.3s; }
    .progress-cancel { margin-top: 20px; padding: 12px 24px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px; }
    
    #remote-config { display: none; }
    #remote-config.visible { display: block; margin-top: 12px; }
    
    /* NFT Styles — translucent gradient matching mobile */
    .action-btn.nft { background: linear-gradient(135deg, rgba(153,69,255,0.18) 0%, rgba(153,69,255,0.08) 100%); border: 1px solid rgba(153,69,255,0.2); position: relative; overflow: hidden; }
    .action-btn.nft::before { content: ''; position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.06); }
    .action-btn.nft:hover { border-color: rgba(153,69,255,0.4); }
    .action-btn-icon.nft-icon { background: rgba(255,255,255,0.18); }
    .action-btn-icon.nft-icon svg { fill: none; stroke: #fff; }
    .action-btn-title.nft-title { color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,0.3); }
    .action-btn-subtitle.nft-subtitle { color: rgba(255,255,255,0.65); }
    .action-btn-arrow.nft-arrow { color: rgba(255,255,255,0.5); }
    /* Album/Certs feature cards — gradient fill matching mobile */
    .feature-card-row { display: flex; gap: 10px; }
    .feature-card { flex: 1; border-radius: 14px; overflow: hidden; border: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px 12px; cursor: pointer; transition: all 0.2s ease; }
    .feature-card:hover { transform: translateY(-1px); }
    .feature-card-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
    .feature-card-icon svg { width: 24px; height: 24px; }
    .feature-card-title { font-size: 13px; font-weight: 700; color: #fff; }
    .feature-card-sub { font-size: 10px; margin-top: 2px; text-align: center; }
    /* Album card — purple */
    .feature-card.album { background: linear-gradient(135deg, rgba(153,69,255,0.12) 0%, rgba(153,69,255,0.05) 100%); border-color: rgba(153,69,255,0.2); }
    .feature-card.album:hover { border-color: rgba(153,69,255,0.4); }
    .feature-card.album .feature-card-icon { background: rgba(153,69,255,0.18); }
    .feature-card.album .feature-card-icon svg { stroke: #9945FF; }
    .feature-card.album .feature-card-sub { color: rgba(153,69,255,0.6); }
    /* Certs card — amber */
    .feature-card.certs { background: linear-gradient(135deg, rgba(245,158,11,0.12) 0%, rgba(245,158,11,0.05) 100%); border-color: rgba(245,158,11,0.2); }
    .feature-card.certs:hover { border-color: rgba(245,158,11,0.4); }
    .feature-card.certs .feature-card-icon { background: rgba(245,158,11,0.18); }
    .feature-card.certs .feature-card-icon svg { stroke: #f59e0b; }
    .feature-card.certs .feature-card-title { color: #fff; }
    .feature-card.certs .feature-card-sub { color: rgba(245,158,11,0.5); }
    
    /* NFT Album Overlay */
    .nft-album-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg-primary); z-index: 1000; display: none; flex-direction: column; overflow: hidden; }
    .nft-album-overlay.active { display: flex; }
    .nft-album-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .nft-album-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .nft-album-content { flex: 1; overflow: hidden; padding: 12px 16px; display: flex; flex-direction: column; }
    .nft-refresh-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 16px; }
    .nft-refresh-btn:hover { background: rgba(255,255,255,0.05); color: #9945FF; border-color: #9945FF; }
    .nft-search-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .nft-search-input { flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; color: var(--text-primary); font-size: 13px; outline: none; }
    .nft-search-input::placeholder { color: var(--text-muted); }
    .nft-search-input:focus { border-color: #9945FF; }
    .nft-search-clear { width: 24px; height: 24px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 14px; display: none; padding: 0; }
    .nft-search-clear:hover { color: var(--text-primary); }
    .nft-search-results { font-size: 11px; color: var(--text-muted); padding: 4px 16px 0; display: none; }
    .nft-filter-bar { display: flex; gap: 8px; padding: 10px 16px 0; flex-shrink: 0; }
    .nft-filter-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 12px; font-weight: 600; }
    .nft-filter-btn:hover { background: rgba(255,255,255,0.04); color: var(--text-primary); }
    .nft-filter-btn.active-all { background: rgba(153,69,255,0.24); border-color: rgba(153,69,255,0.5); color: #fff; }
    .nft-filter-btn.active-public { background: rgba(34,197,94,0.2); border-color: rgba(34,197,94,0.45); color: #22c55e; }
    .nft-filter-btn.active-private { background: rgba(99,102,241,0.22); border-color: rgba(99,102,241,0.45); color: #818cf8; }
    .nft-close-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
    .nft-close-btn:hover { background: rgba(255,255,255,0.05); color: #ff4444; border-color: #ff4444; }
    .nft-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; flex: 1; overflow-y: auto; align-content: start; }
    .nft-item { aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--bg-card); border: 1px solid var(--border); cursor: pointer; position: relative; transition: all 0.2s; }
    .nft-item.standard { border-color: rgba(153,69,255,0.3); } /* Purple shadow for standard NFTs */
    .nft-item.compressed { border-color: rgba(20,241,149,0.25); } /* Green shadow for compressed NFTs */
    .nft-item:hover { transform: scale(1.02); }
    .nft-item.standard:hover { border-color: rgba(153,69,255,0.5); }
    .nft-item.compressed:hover { border-color: rgba(20,241,149,0.4); }
    .nft-item img { width: 100%; height: 100%; object-fit: cover; }
    .nft-item-overlay { position: absolute; bottom: 0; left: 0; right: 0; padding: 6px 8px; background: linear-gradient(transparent, rgba(0,0,0,0.85)); }
    .nft-item-name { font-size: 10px; font-weight: 500; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-item-date { font-size: 9px; color: rgba(255,255,255,0.5); margin-top: 2px; }
    .nft-badge-row { display: flex; flex-direction: row; align-items: center; gap: 3px; margin-top: 3px; flex-wrap: wrap; }
    .nft-badge-pill { display: inline-flex; align-items: center; justify-content: center; padding: 1px 5px; border-radius: 3px; font-size: 7px; font-weight: 600; line-height: 1.4; }
    .nft-badge-stack { position: absolute; bottom: 28px; right: 6px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .nft-badge { width: 24px; height: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .nft-badge-cnft { background: #1a5c2a; border-radius: 50%; } /* Dark green circle */
    .nft-badge-cnft .badge-text { color: #5ddb6e; font-size: 8px; font-weight: 700; line-height: 1; } /* Light green "cN" */
    .nft-badge-cnft .badge-sub { color: #5ddb6e; font-size: 5px; line-height: 1; margin-top: -1px; } /* Light green "compressed" */
    .nft-badge-standard { background: #2a1a4a; border-radius: 4px; } /* Dark purple background */
    .nft-badge-standard .badge-hex { color: #9945FF; font-size: 16px; line-height: 1; } /* Light purple hexagon outline */
    
    /* NFT Detail View Overlay */
    .nft-detail-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.95); z-index: 1100; display: none; flex-direction: column; overflow: hidden; }
    .nft-detail-overlay.active { display: flex; }
    .nft-detail-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; background: rgba(20, 20, 30, 0.98); }
    .nft-detail-header-left { flex: 1; min-width: 0; padding-right: 10px; }
    .nft-detail-title-name { font-size: 16px; font-weight: 700; color: #fff; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-detail-badge-row { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .nft-chip { padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; line-height: 1; }
    .nft-chip.cnft { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .nft-chip.standard { background: rgba(153, 69, 255, 0.2); color: #9945FF; }
    .nft-chip.storage { background: rgba(153, 69, 255, 0.2); color: #9945FF; }
    .nft-chip.edition-limited { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .nft-chip.edition-open { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .nft-chip.cert-private { background: rgba(99, 102, 241, 0.2); color: #818cf8; }
    .nft-chip.cert-public { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .nft-chip.encrypted { background: rgba(153, 69, 255, 0.2); color: #9945FF; }
    .nft-chip.watermarked { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .nft-chip.license { background: rgba(3, 225, 255, 0.15); color: #03E1FF; }
    .nft-chip.rfc3161 { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.4); }
    .nft-chip.c2pa { background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59,130,246,0.4); }
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
    .nft-uri-copy-row { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.06); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: background 0.15s; }
    .nft-uri-copy-row:hover { background: rgba(153,69,255,0.15); }
    .nft-uri-text { flex: 1; font-size: 12px; color: #fff; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
    .nft-transfer-modal { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1200; display: none; align-items: center; justify-content: center; padding: 20px; }
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
    
    /* NFT Mint Panel (full-screen overlay) */
    .nft-mint-section { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000; background: var(--bg-primary); padding: 20px 16px 16px; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; width: 100%; max-width: 100%; }
    .nft-mint-section > * { max-width: 100%; box-sizing: border-box; }
    .nft-mint-section::-webkit-scrollbar { width: 4px; }
    .nft-mint-section::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
    .nft-mint-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .nft-mint-title { font-size: 15px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; letter-spacing: -0.2px; }
    .nft-mint-title::before { content: ''; display: inline-block; width: 3px; height: 16px; border-radius: 2px; background: linear-gradient(180deg, #9945FF, #6366f1); }
    .nft-mint-close { width: 28px; height: 28px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); color: var(--text-muted); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
    .nft-mint-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .nft-promo-banner { background: linear-gradient(135deg, #9945FF 0%, #14F195 100%); padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; text-align: center; font-size: 11px; font-weight: 600; letter-spacing: 0.2px; }
    .nft-option-group { margin-bottom: 14px; }
    .nft-option-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.5px; font-weight: 600; }
    .nft-options { display: flex; gap: 6px; }
    .nft-option { flex: 1; padding: 10px 8px; border-radius: 8px; border: 1px solid var(--border); background: transparent; cursor: pointer; text-align: center; transition: all 0.2s; }
    .nft-option:hover { border-color: #9945FF; }
    .nft-option.selected { border-color: #9945FF; background: rgba(153,69,255,0.15); }
    .nft-option-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .nft-option-sub { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .nft-option-price { font-size: 13px; font-weight: 600; color: #14F195; margin-top: 4px; }
    .nft-cert-section { background: #111114; border-radius: 16px; border: 1px solid #252530; padding: 14px; margin-bottom: 14px; }
    .nft-cert-section-desc { font-size: 11px; color: var(--text-muted); line-height: 1.5; margin-bottom: 10px; }
    .nft-cert-card-desc { font-size: 11px; color: var(--text-muted); line-height: 1.5; margin-bottom: 8px; }
    .nft-cert-options { display: flex; flex-direction: column; gap: 10px; }
    .nft-cert-card { display:flex; flex-direction:column; align-items:flex-start; padding:14px 16px !important; border-radius:12px !important; border:1.5px solid rgba(255,255,255,0.07) !important; background:rgba(255,255,255,0.02) !important; position:relative; cursor:pointer; transition: all 0.2s ease; }
    .nft-cert-card:hover { border-color:rgba(153,69,255,0.4) !important; background:rgba(153,69,255,0.04) !important; }
    .nft-cert-card.selected { border-color:#7c3aed !important; background:rgba(124,58,237,0.08) !important; box-shadow:0 0 0 1px rgba(124,58,237,0.2), 0 2px 8px rgba(124,58,237,0.1); }
    .nft-cert-card-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; width:100%; }
    .nft-cert-card-header svg { flex-shrink:0; opacity:0.6; }
    .nft-cert-card.selected .nft-cert-card-header svg { opacity:1; color:#a78bfa; }
    .nft-cert-card-name { font-size:14px; font-weight:600; color:#e4e4e7; }
    .nft-cert-card.selected .nft-cert-card-name { color:#fff; }
    .nft-cert-card-chips { display:flex; flex-wrap:wrap; gap:5px; }
    .cert-chip { font-size:10px; font-weight:600; padding:3px 8px; border-radius:4px; letter-spacing:0.2px; }
    .cert-chip.green { background:rgba(34,197,94,0.1); color:#4ade80; }
    .cert-chip.amber { background:rgba(245,158,11,0.1); color:#fbbf24; }
    .nft-cost-breakdown { margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.25); border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); }
    .nft-cost-row { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--text-muted); margin-top: 6px; }
    .nft-cost-row:first-child { margin-top: 0; }
    .nft-cost-row strong { color: var(--text-primary); font-weight: 600; }
    .nft-cost-meta { margin-top: 8px; font-size: 10px; color: rgba(255,255,255,0.45); }
    .nft-photo-select { border: 2px dashed rgba(255,255,255,0.1); border-radius: 12px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s; background: rgba(255,255,255,0.015); }
    .nft-photo-select:hover { border-color: rgba(153,69,255,0.5); background: rgba(153,69,255,0.04); }
    .nft-photo-icon { margin-bottom: 6px; display: flex; justify-content: center; }
    .nft-photo-text { font-size: 13px; color: var(--text-muted); }
    .nft-photo-preview { display: none; position: relative; border-radius: 12px; overflow: hidden; }
    .nft-photo-preview img { width: 100%; max-height: 140px; object-fit: cover; border-radius: 12px; }
    .nft-photo-remove { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border-radius: 50%; background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.1); color: #fff; cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
    .nft-photo-remove:hover { background: rgba(239,68,68,0.7); }
    .nft-input { width: 100%; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; background: rgba(255,255,255,0.03); color: var(--text-primary); font-size: 13px; margin-bottom: 0; transition: border-color 0.15s; }
    .nft-input:focus { outline: none; border-color: rgba(153,69,255,0.5); background: rgba(153,69,255,0.04); }
    .nft-input::placeholder { color: var(--text-muted); }
    /* Toggle row (watermark, strip exif, license) */
    .nft-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; cursor: pointer; transition: all 0.15s; }
    .nft-toggle-row:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1); }
    .nft-toggle-left { display: flex; align-items: center; gap: 10px; }
    .nft-toggle-left svg { flex-shrink: 0; opacity: 0.5; }
    .nft-toggle-title { font-size: 13px; font-weight: 500; color: #e4e4e7; }
    .nft-toggle-desc { font-size: 11px; color: #71717a; margin-top: 1px; line-height: 1.4; }
    /* Custom toggle switch */
    .nft-toggle-check { -webkit-appearance: none; appearance: none; width: 36px; height: 20px; border-radius: 10px; background: rgba(255,255,255,0.1); position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0; }
    .nft-toggle-check::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #71717a; transition: all 0.2s; }
    .nft-toggle-check:checked { background: rgba(124,58,237,0.5); }
    .nft-toggle-check:checked::after { left: 18px; background: #a78bfa; }
    /* Cost display */
    .nft-cost-display { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; margin-bottom: 10px; }
    .nft-cost-label { font-size: 12px; color: #71717a; font-weight: 500; }
    .nft-cost-value { font-size: 14px; font-weight: 700; color: #14F195; }
    /* Wallet row */
    .nft-wallet-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; margin-bottom: 12px; font-size: 12px; }
    .nft-wallet-dot { width: 7px; height: 7px; border-radius: 50%; background: #14F195; box-shadow: 0 0 6px rgba(20,241,149,0.4); }
    .nft-wallet-dot.disconnected { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.3); }
    .nft-wallet-connect { margin-left: auto; padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(153,69,255,0.4); background: rgba(153,69,255,0.1); color: #a78bfa; cursor: pointer; font-size: 11px; font-weight: 600; transition: all 0.15s; }
    .nft-wallet-connect:hover { background: rgba(153,69,255,0.2); border-color: rgba(153,69,255,0.6); color: #c4b5fd; }
    .nft-guide-btn { width: 18px; height: 18px; border-radius: 50%; border: 1px solid #9945FF; background: transparent; color: #9945FF; font-size: 11px; font-weight: 700; cursor: pointer; margin-left: 6px; padding: 0; line-height: 16px; }
    .nft-guide-btn:hover { background: rgba(153,69,255,0.2); }
    .nft-guide-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.75); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .nft-guide-modal { background: #111; border-radius: 14px; padding: 16px; width: 100%; max-width: 440px; max-height: 82vh; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.08); }
    .nft-guide-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .nft-guide-scroll { overflow-y: auto; flex: 1; padding-right: 4px; }
    .nft-guide-scroll::-webkit-scrollbar { width: 3px; }
    .nft-guide-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
    .nft-guide-subtitle { font-size: 11px; color: #71717a; line-height: 15px; margin-bottom: 14px; }
    .nft-guide-label { font-size: 9px; font-weight: 600; color: #52525b; text-transform: uppercase; letter-spacing: 0.6px; margin: 14px 0 6px; }
    .nft-guide-example { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 11px; margin-bottom: 6px; }
    .nft-guide-ex-head { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
    .nft-guide-ex-tag { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
    .nft-guide-ex-name { font-size: 12px; font-weight: 600; color: #e4e4e7; }
    .nft-guide-ex-desc { font-size: 10.5px; color: #a1a1aa; line-height: 15px; margin-bottom: 5px; }
    .nft-guide-ex-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .nft-guide-chip { font-size: 9px; padding: 2px 6px; border-radius: 3px; background: rgba(255,255,255,0.05); color: #a1a1aa; }
    .nft-guide-chip.green { background: rgba(34,197,94,0.1); color: #4ade80; }
    .nft-guide-chip.amber { background: rgba(245,158,11,0.1); color: #fbbf24; }
    .nft-guide-chip.red { background: rgba(239,68,68,0.1); color: #f87171; }
    .nft-guide-detail { border-top: 1px solid rgba(255,255,255,0.05); margin-top: 6px; }
    .nft-guide-detail-toggle { display: flex; align-items: center; justify-content: space-between; padding: 6px 0 0; cursor: pointer; user-select: none; }
    .nft-guide-detail-toggle span { font-size: 10px; color: #52525b; }
    .nft-guide-detail-toggle .arrow { font-size: 9px; color: #52525b; transition: transform 0.15s; }
    .nft-guide-detail-body { max-height: 0; overflow: hidden; transition: max-height 0.2s ease; }
    .nft-guide-detail.open .nft-guide-detail-body { max-height: 300px; }
    .nft-guide-detail.open .arrow { transform: rotate(90deg); }
    .nft-guide-detail-inner { padding: 5px 0 2px; }
    .nft-guide-pro, .nft-guide-con { font-size: 10px; line-height: 14px; padding-left: 10px; position: relative; margin-bottom: 2px; }
    .nft-guide-pro { color: #71717a; }
    .nft-guide-pro::before { content: '+'; position: absolute; left: 0; color: #4ade80; font-weight: 700; }
    .nft-guide-con { color: #71717a; }
    .nft-guide-con::before { content: '–'; position: absolute; left: 0; color: #f59e0b; font-weight: 700; }
    .nft-guide-note { font-size: 10px; color: #52525b; line-height: 14px; background: rgba(255,255,255,0.02); border-radius: 6px; padding: 8px 10px; margin-top: 4px; }
    .nft-guide-note strong { color: #a1a1aa; font-weight: 600; }
    .nft-guide-hl { color: #e4e4e7; font-weight: 600; }
    .nft-guide-close-btn { width: 100%; padding: 10px; border: none; border-radius: 10px; background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 10px; }
    .nft-guide-close-btn:hover { box-shadow: 0 4px 16px rgba(153,69,255,0.4); }
    .nft-mint-btn { width: 100%; padding: 12px; border: none; border-radius: 10px; background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }
    .nft-mint-btn:hover { box-shadow: 0 6px 20px rgba(153,69,255,0.4); }
    .nft-mint-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
    .nft-item-name { font-size: 8px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nft-loading, .nft-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; color: var(--text-muted); font-size: 12px; gap: 8px; }
    .nft-spinner { width: 24px; height: 24px; border: 2px solid var(--border); border-top-color: #9945FF; border-radius: 50%; animation: spin 1s linear infinite; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    #file-picker-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:#000; z-index:99999; flex-direction:column; align-items:center; justify-content:center; gap:20px; }
    #file-picker-overlay.active { display:flex; }
    .gradient-spinner { width:70px; height:70px; position:relative; animation: gs-spin 2s linear infinite; }
    @keyframes gs-spin { 0%{transform:rotate(0deg) scale(0.9)} 50%{transform:rotate(180deg) scale(1.1)} 100%{transform:rotate(360deg) scale(0.9)} }
    .gs-petal { position:absolute; width:20px; height:27px; border-radius:10px; top:50%; left:50%; margin-left:-10px; margin-top:-13.5px; transform-origin:10px 13.5px; }
    .gs-center { position:absolute; top:50%; left:50%; width:21px; height:21px; border-radius:50%; background:#1E3A8A; transform:translate(-50%,-50%); }
    #file-picker-overlay .fp-label { font-size:16px; color:#fff; font-weight:600; }
    #file-picker-overlay .fp-sub { font-size:13px; color:#888; }
  </style>
</head>
<body>
  <div id="file-picker-overlay">
    <div class="gradient-spinner">
      <div class="gs-petal" style="background:#03E1FF;opacity:0.60;transform:rotate(0deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#00FFA3;opacity:0.65;transform:rotate(45deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#02C4E0;opacity:0.70;transform:rotate(90deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#00CC88;opacity:0.75;transform:rotate(135deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#03E1FF;opacity:0.80;transform:rotate(180deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#00FFA3;opacity:0.85;transform:rotate(225deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#02C4E0;opacity:0.90;transform:rotate(270deg) translateY(-16px)"></div>
      <div class="gs-petal" style="background:#00CC88;opacity:1.00;transform:rotate(315deg) translateY(-16px)"></div>
      <div class="gs-center"></div>
    </div>
    <div class="fp-label">Preparing...</div>
    <div class="fp-sub">Please wait</div>
  </div>
  <!-- MAIN VIEW -->
  <div id="main-view" class="view active">
    <div class="header">
      <div class="header-left">
        <div class="app-title">PhotoLynk <span class="version-badge">v${currentVersion}</span></div>
        <div class="server-badge">
          <div class="server-badge-dot" id="server-dot"></div>
          <span class="server-badge-text" id="server-status">Local Vault</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="header-btn" onclick="openPairModal()" title="Pair Mobile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </button>
        <button class="header-btn" id="autostart-btn" onclick="toggleAutoStart()" title="Start on Boot">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><rect x="1" y="5" width="22" height="14" rx="7" ry="7"/><circle cx="16" cy="12" r="3"/></svg>
        </button>
      </div>
    </div>
    
    <div class="quick-stats" id="status-hero">
      <div class="quick-stats-grid" id="qs-grid">
        <div class="qs-cell">
          <div class="qs-icon" style="background:rgba(3,225,255,0.12);">👤</div>
          <div class="qs-text">
            <div class="qs-label">Account</div>
            <div class="qs-value" id="qs-account">${credentials.email || 'Not paired'}</div>
          </div>
        </div>
        <div class="qs-cell">
          <div class="qs-icon" style="background:rgba(16,185,129,0.12);">
            <div class="qs-dot green" id="qs-server-dot"></div>
          </div>
          <div class="qs-text">
            <div class="qs-label">Server</div>
            <div class="qs-value" id="qs-server">Starting...</div>
          </div>
        </div>
        <div class="qs-cell">
          <div class="qs-icon" style="background:rgba(99,102,241,0.12);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg></div>
          <div class="qs-text">
            <div class="qs-label">Last Backup</div>
            <div class="qs-value" id="qs-backup">—</div>
          </div>
        </div>
        <div class="qs-cell">
          <div class="qs-icon" style="background:rgba(153,69,255,0.12);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9945FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
          <div class="qs-text">
            <div class="qs-label">Originals</div>
            <div class="qs-value" id="qs-nfts">—</div>
          </div>
        </div>
      </div>
      <!-- Inline Progress (hidden by default, shown during operations) -->
      <div class="qs-progress" id="qs-progress">
        <div class="qs-progress-title" id="qs-progress-title">Processing...</div>
        <div class="inline-progress" id="inline-progress" style="display:flex;">
          <div class="inline-progress-bar">
            <div class="inline-progress-fill" id="inline-progress-fill"></div>
          </div>
          <div class="inline-progress-text" id="inline-progress-text">0%</div>
        </div>
        <div class="inline-status-message" id="inline-status-message"></div>
      </div>
    </div>
    
    <div class="content">
      <!-- ═══ TAB: HOME ═══ -->
      <div class="tab-panel active" id="tab-home">
        <div class="section-header-row">
          <div class="section-dot" style="background:#03E1FF;"></div>
          <div><div class="section-header-label" style="color:#03E1FF;">SECURE VAULT</div></div>
        </div>
        <div class="action-row">
          <div class="action-btn primary" onclick="startBackup()">
            <div class="action-btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg></div>
            <div class="action-btn-text">
              <div class="action-btn-title">Backup Library</div>
              <div class="action-btn-subtitle">Encrypted media backup</div>
            </div>
            <div class="action-btn-arrow">›</div>
          </div>
        </div>
        <div class="action-row">
          <div class="action-btn secondary" onclick="startSync()">
            <div class="action-btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 21v-9"/><path d="m8 17 4 4 4-4"/></svg></div>
            <div class="action-btn-text">
              <div class="action-btn-title">Restore Library</div>
              <div class="action-btn-subtitle">Restore from vault</div>
            </div>
            <div class="action-btn-arrow">›</div>
          </div>
        </div>

        <div class="section-header-row">
          <div class="section-dot" style="background:#9945FF;"></div>
          <div><div class="section-header-label" style="color:#9945FF;">AUTHENTICITY</div><div class="section-header-sub">Tamper-proof certified originals</div></div>
        </div>
        <div class="action-row">
          <div class="action-btn nft" onclick="openNFTMint()">
            <div class="action-btn-icon nft-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div>
            <div class="action-btn-text">
              <div class="action-btn-title nft-title">Certify Original</div>
              <div class="action-btn-subtitle nft-subtitle">Create a permanent authenticity record</div>
            </div>
            <div class="action-btn-arrow nft-arrow">›</div>
          </div>
        </div>
        <div class="feature-card-row">
          <div class="feature-card album" onclick="openNFTAlbum()">
            <div class="feature-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>
            <div class="feature-card-title">Originals</div>
            <div class="feature-card-sub">Verified originals</div>
          </div>
          <div class="feature-card certs" onclick="openCertificates()">
            <div class="feature-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg></div>
            <div class="feature-card-title">Proofs</div>
            <div class="feature-card-sub">Proof records</div>
          </div>
        </div>
      </div>

      <!-- ═══ TAB: TOOLS (AI Detector only) ═══ -->
      <div class="tab-panel" id="tab-tools">
        <div class="section-header-row">
          <div class="section-dot" style="background:#D4AF37;"></div>
          <div><div class="section-header-label" style="color:#D4AF37;">AI IMAGE DETECTOR</div><div class="section-header-sub">Coming soon</div></div>
        </div>
        <div class="coming-soon-card">
          <div class="coming-soon-icon" style="background:rgba(212,175,55,0.12);">
            <svg viewBox="0 0 24 24" fill="none" stroke="#D4AF37" stroke-width="2" style="width:24px;height:24px;"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/></svg>
          </div>
          <div class="coming-soon-title">Detect AI-Generated Images</div>
          <div class="coming-soon-sub">Identify synthetic photos in your library using on-device analysis</div>
        </div>
      </div>

      <!-- ═══ TAB: SHARE ═══ -->
      <div class="tab-panel" id="tab-share">
        <div class="section-header-row">
          <div class="section-dot" style="background:#00FFA3;"></div>
          <div><div class="section-header-label" style="color:#00FFA3;">P2P SHARING</div><div class="section-header-sub">End-to-end encrypted</div></div>
        </div>
        <div class="coming-soon-card">
          <div class="coming-soon-icon" style="background:rgba(0,255,163,0.12);">
            <svg viewBox="0 0 24 24" fill="none" stroke="#00FFA3" stroke-width="2" style="width:24px;height:24px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <div class="coming-soon-title">Encrypted P2P Sharing</div>
          <div class="coming-soon-sub">Share photos & videos with other PhotoLynk users via encrypted key exchange through Encrypted Cloud</div>
        </div>
      </div>
      
      <!-- NFT Album Overlay (separate window on top) -->
      <div id="nft-album-overlay" class="nft-album-overlay">
        <div class="nft-album-header">
          <button class="nft-close-btn" onclick="closeNFTAlbum()">✕</button>
          <span class="nft-album-title">Photo Album</span>
          <button class="nft-refresh-btn" onclick="refreshNFTAlbum()">↻</button>
        </div>
        <div class="nft-search-bar">
          <span style="color:var(--text-secondary);font-size:14px;">🔍</span>
          <input id="nft-search-input" class="nft-search-input" type="text" placeholder="Search originals..." oninput="onNFTSearchInput(this.value)">
          <button id="nft-search-clear" class="nft-search-clear" onclick="clearNFTSearch()">✕</button>
        </div>
        <div id="nft-search-results" class="nft-search-results"></div>
        <div class="nft-filter-bar">
          <button id="nft-filter-all" class="nft-filter-btn active-all" onclick="setNFTFilter('all')">⬡ All</button>
          <button id="nft-filter-public" class="nft-filter-btn" onclick="setNFTFilter('public')">🌍 Public</button>
          <button id="nft-filter-private" class="nft-filter-btn" onclick="setNFTFilter('private')">🔐 Private</button>
        </div>
        <div class="nft-album-content">
          <div id="nft-grid" class="nft-grid"></div>
          <div id="nft-loading" class="nft-loading" style="display: none;">
            <div class="nft-spinner"></div>
            <span>Loading originals...</span>
          </div>
          <div id="nft-empty" class="nft-empty" style="display: none;">
            <span>No certified originals yet. Certify your first photo!</span>
          </div>
          <div id="nft-nav" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px;flex-shrink:0;"></div>
        </div>
      </div>
      
      <!-- Certificates Overlay -->
      <div id="certs-overlay" class="nft-album-overlay">
        <div class="nft-album-header">
          <button class="nft-close-btn" onclick="closeCertificates()">✕</button>
          <span class="nft-album-title" style="color:#f59e0b;">Proof Records</span>
          <button class="nft-refresh-btn" onclick="loadCertificates()">↻</button>
        </div>
        <div class="nft-album-content" style="overflow-y:auto;">
          <div id="certs-loading" style="display:none;text-align:center;padding:40px;color:#f59e0b;">
            <div style="width:28px;height:28px;border:3px solid rgba(245,158,11,0.15);border-top-color:#f59e0b;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 10px;"></div>
            <span style="font-size:12px;color:#b8860b;">Loading proof records...</span>
          </div>
          <div id="certs-empty" style="display:none;text-align:center;padding:40px;color:#888;">
            <div style="font-size:32px;margin-bottom:8px;">🏆</div>
            <div style="font-weight:600;color:#fff;margin-bottom:4px;">No Proof Records Yet</div>
            <div style="font-size:12px;">Certify an original to receive a Certificate of Authenticity</div>
          </div>
          <div id="certs-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </div>
      </div>
      
      <!-- NFT Detail View Overlay -->
      <div id="nft-detail-overlay" class="nft-detail-overlay">
        <div class="nft-detail-header">
          <div class="nft-detail-header-left">
            <div id="nft-detail-title" class="nft-detail-title-name"></div>
          </div>
          <button class="nft-detail-close" onclick="closeNFTDetail()">✕</button>
        </div>
        <div class="nft-detail-content">
          <div class="nft-detail-badge-row" id="nft-detail-badge-row"></div>
          <div id="nft-detail-image" class="nft-detail-image">
            <img id="nft-detail-img" src="" alt="">
          </div>

          <div class="nft-section">
            <div class="nft-section-label">OWNER</div>
            <div id="nft-detail-owner-full" class="nft-owner-address"></div>
          </div>

          <div class="nft-divider"></div>

          <div class="nft-action-row">
            <button id="nft-action-left" class="nft-mini-btn" onclick="openNFTTokenView()"></button>
            <button id="nft-action-right" class="nft-mini-btn" onclick="openNFTStorageView()"></button>
          </div>

          <button id="nft-transfer-main-btn" class="nft-transfer-main" onclick="openNFTTransfer()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            Transfer Original
          </button>
        </div>
      </div>
      
      <!-- NFT Transfer Modal -->
      <div id="nft-transfer-modal" class="nft-transfer-modal">
        <div class="nft-transfer-content">
          <div class="nft-transfer-header">
            <span class="nft-transfer-title">Transfer Original</span>
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
              <label class="nft-transfer-label">Recipient Address</label>
              <input type="text" id="nft-transfer-recipient" class="nft-transfer-input" placeholder="Enter recipient address...">
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
      
      <!-- NFT Mint Panel (full-screen overlay) -->
      <div id="nft-mint-section" class="nft-mint-section" style="display: none;">
        <div class="nft-mint-header">
          <div class="nft-mint-title">Certify Original</div>
          <button class="nft-mint-close" onclick="closeNFTMint()">✕</button>
        </div>
        
        <div id="nft-promo-banner" class="nft-promo-banner" style="display: none;">
          Launch Special - <span id="promo-days">30</span> Days Left! Up to 90% off!
        </div>
        
        <!-- 1. Select Photo (moved to top for immediate engagement) -->
        <div class="nft-option-group">
          <div class="nft-photo-select" id="nft-photo-select" onclick="selectNFTPhoto()">
            <div class="nft-photo-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>
            <div class="nft-photo-text">Click to open folder and drag a photo here</div>
          </div>
          <div class="nft-photo-preview" id="nft-photo-preview">
            <img id="nft-preview-img" src="">
            <button class="nft-photo-remove" onclick="removeNFTPhoto()">✕</button>
          </div>
        </div>
        
        <!-- 2. Name -->
        <div class="nft-option-group">
          <input type="text" class="nft-input" id="nft-name-input" placeholder="Name (e.g., My Original)">
          <input type="text" class="nft-input" id="nft-desc-input" placeholder="Description (optional)" style="display:none">
        </div>
        
        <!-- 3. Certification Mode: Private vs Public -->
        <div class="nft-cert-section">
          <div class="nft-option-label">Certification Mode</div>
          <div class="nft-cert-section-desc">Create a tamper-proof certification. Choose your privacy level.</div>
          <div class="nft-cert-options">
            <div class="nft-cert-card selected" onclick="selectCertificationMode('private', this)">
              <div class="nft-cert-card-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span class="nft-cert-card-name">Private Certified</span>
              </div>
              <div class="nft-cert-card-desc">Encrypted on your device before upload. Only you can decrypt and view the original.</div>
              <div class="nft-cert-card-chips">
                <span class="cert-chip green">Full quality</span>
                <span class="cert-chip green">Zero-knowledge</span>
                <span class="cert-chip green">EXIF preserved</span>
                <span class="cert-chip green">Transferable</span>
                <span class="cert-chip green">Privacy-first</span>
              </div>
            </div>
            <div class="nft-cert-card" onclick="selectCertificationMode('public', this)">
              <div class="nft-cert-card-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                <span class="nft-cert-card-name">Public Certified</span>
              </div>
              <div class="nft-cert-card-desc">Unencrypted, publicly viewable. Stored on secure infrastructure. Ideal for portfolios.</div>
              <div class="nft-cert-card-chips">
                <span class="cert-chip green">Full quality</span>
                <span class="cert-chip amber">Publicly visible</span>
                <span class="cert-chip green">Transferable</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Optional watermark (Public mode only) - HIDDEN for now -->
        <div class="nft-option-group" id="watermark-option" style="display:none !important;">
          <label class="nft-toggle-row">
            <div class="nft-toggle-left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
              <div>
                <div class="nft-toggle-title">Add Watermark</div>
                <div class="nft-toggle-desc">Protect your public original with a visible watermark</div>
              </div>
            </div>
            <input type="checkbox" id="nft-watermark-public" class="nft-toggle-check">
          </label>
        </div>
        
        <!-- Strip EXIF toggle -->
        <div class="nft-option-group" id="strip-exif-option">
          <label class="nft-toggle-row">
            <div class="nft-toggle-left">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <div>
                <div class="nft-toggle-title">Remove Private Data (EXIF)</div>
                <div class="nft-toggle-desc" id="nft-strip-exif-desc">Strip location, camera info, and other metadata</div>
              </div>
            </div>
            <input type="checkbox" id="nft-strip-exif-toggle" class="nft-toggle-check" onchange="selectedStripExif = this.checked">
          </label>
        </div>
        
        <!-- 4. License -->
        <div class="nft-option-group">
          <div class="nft-option-label">License</div>
          <select class="nft-input" id="nft-license-select">
            <option value="arr" selected>All Rights Reserved</option>
            <option value="cc-by">CC BY 4.0</option>
            <option value="cc-by-sa">CC BY-SA 4.0</option>
            <option value="cc-by-nc">CC BY-NC 4.0</option>
            <option value="cc-by-nc-sa">CC BY-NC-SA 4.0</option>
            <option value="cc-by-nd">CC BY-ND 4.0</option>
            <option value="cc-by-nc-nd">CC BY-NC-ND 4.0</option>
            <option value="cc0">CC0 1.0 (Public Domain)</option>
            <option value="commercial">Commercial License</option>
          </select>
        </div>
        
        <!-- Cost Display -->
        <div class="nft-cost-display">
          <span class="nft-cost-label">Estimated Cost</span>
          <strong id="nft-simple-cost" class="nft-cost-value">~$0.07</strong>
        </div>
        
        <!-- Wallet Connection -->
        <div class="nft-wallet-row">
          <div class="nft-wallet-dot disconnected" id="mint-wallet-dot"></div>
          <span id="mint-wallet-text">No credentials connected</span>
          <button class="nft-wallet-connect" onclick="connectNFTWallet()">Connect</button>
        </div>
        <div id="wallet-connect-hint" style="display:none;margin-top:6px;padding:8px 10px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:8px;font-size:11px;color:#a5b4fc;line-height:1.5;">A browser tab just opened. Approve the connection in your browser to link your credentials.</div>
        
        <!-- Certify Button -->
        <button class="nft-mint-btn" id="nft-mint-btn" disabled onclick="doMintNFT()">
          Certify Original
        </button>
        
        <!-- HIDDEN: Internal state checkboxes read by JS — not shown to user -->
        <div style="display:none;">
          <input type="checkbox" id="nft-encrypt-check">
          <input type="checkbox" id="nft-watermark-check">
          <span id="cnft-price"></span>
          <span id="nft-price"></span>
          <span id="storage-fee"></span>
          <span id="cloud-fee"></span>
          <div id="nft-cost-breakdown"><div id="nft-cost-total"></div></div>
          <div id="nft-storage-group"></div>
        </div>
      </div>
    </div>
    
    <!-- SETTINGS PANEL (replaces hero+content when active) -->
    <div id="settings-overlay" class="settings-overlay">
      <div class="section-title">BACKUP DESTINATION</div>
      <div class="card">
        <div class="server-option selected" onclick="selectDestination('stealthcloud', this)">
          <div class="server-option-icon">☁️</div>
          <div class="server-option-text">
            <div class="server-option-title">Encrypted Cloud</div>
            <div class="server-option-subtitle">StealthLynk.io zero-knowledge storage</div>
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
      
      <div class="section-toggle" onclick="toggleCredentials()">
        <div class="section-title" style="margin:0;">CREDENTIALS</div>
        <span class="section-toggle-arrow" id="cred-arrow">▾</span>
      </div>
      <div class="collapsible" id="cred-section">
        <div class="card">
          <div class="form-group">
            <input class="form-input" type="text" id="email" placeholder="Email, nickname, or name.skr" value="${credentials.email || ''}">
          </div>
          <div class="form-group">
            <input class="form-input" type="password" id="password" placeholder="Password" value="${credentials.password || ''}">
          </div>
          <input type="hidden" id="destination" value="stealthcloud">
        </div>
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

    <!-- ═══ BOTTOM TAB BAR ═══ -->
    <div class="tab-bar">
      <div class="tab-item active" data-tab="home" onclick="switchTab('home')">
        <div class="tab-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>
        <div class="tab-item-label">Home</div>
      </div>
      <div class="tab-item" data-tab="settings" onclick="switchTab('settings')">
        <div class="tab-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></div>
        <div class="tab-item-label">Settings</div>
      </div>
    </div>
  </div>
  
  <!-- NFT Welcome/Guide Modal -->
  <div id="nft-guide-overlay" class="nft-guide-overlay" style="display: none !important;">
    <div class="nft-guide-header">
      <div style="font-size:14px;font-weight:700;color:#fff;">Certifying Your Originals</div>
      <button class="nft-mint-close" onclick="closeNFTGuide()">✕</button>
      <div class="nft-guide-scroll">

        <!-- ── 3 USE-CASE EXAMPLES ── -->
        <div class="nft-guide-label">Choose your scenario</div>

        <!-- Example 1: Fully Public -->
        <div class="nft-guide-example">
          <div class="nft-guide-ex-head">
            <span class="nft-guide-ex-tag" style="background:rgba(34,197,94,0.15);color:#4ade80;">Public</span>
            <span class="nft-guide-ex-name">Share, sell, or use as avatar</span>
          </div>
          <div class="nft-guide-ex-desc"><span class="nft-guide-hl">Open Edition + Decentralized Storage + Unencrypted.</span> Your photo is uploaded to decentralized storage — a network no one controls. Metadata is permanently recorded. Anyone can view the image. Ideal for portfolios, social profiles, or selling prints.</div>
          <div class="nft-guide-ex-row">
            <span class="nft-guide-chip green">Image 100% preserved</span>
            <span class="nft-guide-chip green">EXIF kept by default</span>
            <span class="nft-guide-chip amber">Publicly visible</span>
          </div>
          <div class="nft-guide-detail" onclick="this.classList.toggle('open')">
            <div class="nft-guide-detail-toggle"><span>Details</span><span class="arrow">›</span></div>
            <div class="nft-guide-detail-body"><div class="nft-guide-detail-inner">
              <div class="nft-guide-pro">Viewable in any compatible app, marketplace, or browser</div>
              <div class="nft-guide-pro">Original quality — no compression, no re-encoding</div>
              <div class="nft-guide-pro">Optional watermark to protect your work</div>
              <div class="nft-guide-pro">Transferable and sellable on any compatible marketplace</div>
              <div class="nft-guide-con">Image is publicly accessible via storage gateway</div>
              <div class="nft-guide-con">EXIF (location, camera) visible unless you strip it</div>
            </div></div>
          </div>
        </div>

        <!-- Example 2: Encrypted Private -->
        <div class="nft-guide-example">
          <div class="nft-guide-ex-head">
            <span class="nft-guide-ex-tag" style="background:rgba(99,102,241,0.15);color:#818cf8;">Private</span>
            <span class="nft-guide-ex-name">Encrypted backup — only you can view</span>
          </div>
          <div class="nft-guide-ex-desc"><span class="nft-guide-hl">Open Edition + Decentralized Storage + Encrypted.</span> Same as above, but the image is encrypted on your device before upload. The file in storage is unreadable without your credentials. Your private key never leaves your device — the app only requests a signature, never extracts anything. Ownership permanently recorded, image stays private.</div>
          <div class="nft-guide-ex-row">
            <span class="nft-guide-chip green">Image 100% preserved</span>
            <span class="nft-guide-chip green">Encrypted on device</span>
            <span class="nft-guide-chip green">Only you can decrypt</span>
          </div>
          <div class="nft-guide-detail" onclick="this.classList.toggle('open')">
            <div class="nft-guide-detail-toggle"><span>Details</span><span class="arrow">›</span></div>
            <div class="nft-guide-detail-body"><div class="nft-guide-detail-inner">
              <div class="nft-guide-pro">AES-256-GCM encryption — military-grade, done locally</div>
              <div class="nft-guide-pro">Decryption key sealed to your credentials — the app never touches your private key, only requests a signature</div>
              <div class="nft-guide-pro">EXIF stripped automatically for privacy</div>
              <div class="nft-guide-pro">Stored on decentralized storage — no company can delete it</div>
              <div class="nft-guide-con">Others see an encrypted blob, not the image</div>
              <div class="nft-guide-con">Cannot be used as a public avatar or sold as-is</div>
            </div></div>
          </div>
        </div>

        <!-- Example 3: Limited On-Chain Certificate -->
        <div class="nft-guide-example">
          <div class="nft-guide-ex-head">
            <span class="nft-guide-ex-tag" style="background:rgba(245,158,11,0.15);color:#fbbf24;">Certificate</span>
            <span class="nft-guide-ex-name">Copyright proof with legal timestamps</span>
          </div>
          <div class="nft-guide-ex-desc"><span class="nft-guide-hl">Limited Edition + Embedded in Record + Encrypted.</span> Your original photo and metadata are stored directly inside the authenticity record (not in a separate location — think of it as a permanent file attached to your certificate). No external storage, no links that can break. Includes SHA-256 hashes of image + EXIF + camera serial, an <span class="nft-guide-hl">RFC 3161 trusted timestamp</span> (court-admissible), and a <span class="nft-guide-hl">C2PA provenance manifest</span> (Adobe/Microsoft standard).</div>
          <div class="nft-guide-ex-row">
            <span class="nft-guide-chip green">Image embedded in record</span>
            <span class="nft-guide-chip green">Encrypted</span>
            <span class="nft-guide-chip green">Legally timestamped</span>
          </div>
          <div class="nft-guide-detail" onclick="this.classList.toggle('open')">
            <div class="nft-guide-detail-toggle"><span>Details</span><span class="arrow">›</span></div>
            <div class="nft-guide-detail-body"><div class="nft-guide-detail-inner">
              <div class="nft-guide-pro">No external dependencies — image is stored inside the record, not on a separate server</div>
              <div class="nft-guide-pro">RFC 3161 timestamp from FreeTSA.org — accepted in legal proceedings</div>
              <div class="nft-guide-pro">C2PA manifest — industry standard used by Adobe, Microsoft, BBC</div>
              <div class="nft-guide-pro">Certificate of Authenticity — proves you took the photo, when, and with what camera</div>
              <div class="nft-guide-pro">Permanent and tamper-proof — no pinning services, no cloud subscription</div>
              <div class="nft-guide-con">Larger metadata — costs more than a simple storage upload</div>
              <div class="nft-guide-con">Not viewable as a regular image in apps (encrypted data)</div>
            </div></div>
          </div>
        </div>

        <!-- ── KEY FACTS ── -->
        <div class="nft-guide-label">Key facts</div>

        <div class="nft-guide-note">
          <strong>Image quality:</strong> Your photo is never compressed or re-encoded. The record type refers to how the <em>authenticity record</em> is stored on-chain — your image stays pixel-perfect. All records have identical ownership rights regardless of storage method.
        </div>

        <div class="nft-guide-note" style="margin-top:4px;">
          <strong>EXIF data:</strong> Date, GPS, camera model, and serial number are preserved by default. You can strip EXIF before certification for privacy. Limited Edition always hashes EXIF for proof without exposing it.
        </div>

        <div class="nft-guide-note" style="margin-top:4px;">
          <strong>Encryption:</strong> Done on your device with AES-256-GCM before anything is uploaded. The decryption key is sealed to your credentials via a signature request — your private key never leaves your device. No server ever sees the original.
        </div>

        <div class="nft-guide-note" style="margin-top:4px;">
          <strong>What makes your image public:</strong> Only unencrypted decentralized storage or unencrypted cloud. Everything else — encrypted storage, encrypted embedded, or Limited Edition — keeps your image private.
        </div>

      </div>
      <div style="padding:0 16px 8px;display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="document.getElementById('nft-guide-dontshow').checked=!document.getElementById('nft-guide-dontshow').checked;">
        <input type="checkbox" id="nft-guide-dontshow" style="accent-color:#9945FF;cursor:pointer;" onclick="event.stopPropagation();">
        <span style="font-size:12px;color:#52525b;">Don't show again</span>
      </div>
      <button class="nft-guide-close-btn" onclick="closeNFTGuide()">Got It</button>
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
  
  <!-- QR Pairing Modal -->
  <div class="qr-overlay" id="qr-overlay" onclick="if(event.target===this)closePairModal()">
    <div class="qr-modal">
      <div class="qr-modal-close" onclick="closePairModal()">&times;</div>
      <h3>📱 Pair Mobile</h3>
      <p>Scan with PhotoLynk app to connect and sync credentials</p>
      <div class="qr-container">
        <img class="qr-code" src="${qrImage}" alt="QR Code">
      </div>
      <div class="ip-badge">🔗 <span>${pairingData.ip}:${pairingData.port}</span></div>
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
    
    // QR Pairing Modal
    function openPairModal() {
      document.getElementById('qr-overlay').classList.add('open');
    }
    function closePairModal() {
      document.getElementById('qr-overlay').classList.remove('open');
    }
    window.openPairModal = openPairModal;
    window.closePairModal = closePairModal;
    
    // Tab navigation within main view
    function switchTab(tabName) {
      const settingsOverlay = document.getElementById('settings-overlay');
      if (tabName === 'settings') {
        // Show settings, hide hero + content
        settingsOverlay.classList.add('open');
        document.getElementById('status-hero').style.display = 'none';
        document.querySelector('.content').style.display = 'none';
      } else {
        // Hide settings, restore hero + content
        settingsOverlay.classList.remove('open');
        document.getElementById('status-hero').style.display = '';
        document.querySelector('.content').style.display = '';
        // Switch content tab panel
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById('tab-' + tabName);
        if (panel) panel.classList.add('active');
      }
      // Update tab highlights
      document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
      const item = document.querySelector('.tab-item[data-tab="' + tabName + '"]');
      if (item) item.classList.add('active');
    }
    window.switchTab = switchTab;

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
    
    // Get initial auto-start state
    ipcRenderer.send('get-auto-start');
    ipcRenderer.on('auto-start-status', (e, enabled) => {
      autoStartEnabled = enabled;
      updateAutoStartButton();
    });
    
    function updateServerStatus(running) {
      const dot = document.getElementById('server-dot');
      const status = document.getElementById('server-status');
      const qsDot = document.getElementById('qs-server-dot');
      const qsServer = document.getElementById('qs-server');
      
      if (running) {
        dot.classList.remove('stopped');
        status.textContent = 'Local Vault';
        if (qsDot) { qsDot.className = 'qs-dot green'; }
        if (qsServer) qsServer.textContent = 'Running';
      } else {
        dot.classList.add('stopped');
        status.textContent = 'Server Stopped';
        if (qsDot) { qsDot.className = 'qs-dot red'; }
        if (qsServer) qsServer.textContent = 'Stopped';
      }
      serverBusy = false;
    }
    
    function toggleCredentials() {
      const section = document.getElementById('cred-section');
      const arrow = document.getElementById('cred-arrow');
      section.classList.toggle('open');
      arrow.classList.toggle('open');
    }

    function toggleSettings() { switchTab('settings'); }
    function closeSettings() { switchTab('home'); }

    function selectDestination(dest, el) {
      currentDestination = dest;
      document.getElementById('destination').value = dest;
      document.querySelectorAll('.server-option').forEach(opt => opt.classList.remove('selected'));
      el.classList.add('selected');
      document.getElementById('remote-config').classList.toggle('visible', dest === 'remote');
    }
    
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
    function clearFolders() { selectedFolders = []; ipcRenderer.send('save-backup-folders', selectedFolders); renderFolders(); }
    const baseUploadsPath = "${(uploadsPath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";
    
    // Compute UUID v5 from email:password using Node.js crypto (crypto.subtle is blocked in data: URL context)
    function computeUserUuid(email, password) {
      try {
        if (!email || !password) return null;
        const normalizedEmail = email.trim().toLowerCase();
        const name = normalizedEmail + ':' + password;
        const cryptoNode = require('crypto');
        const namespaceBytes = Buffer.from([
          0x6b, 0xa7, 0xb8, 0x10,
          0x9d, 0xad,
          0x11, 0xd1,
          0x80, 0xb4,
          0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8
        ]);
        const hash = cryptoNode.createHash('sha1').update(namespaceBytes).update(name).digest();
        hash[6] = (hash[6] & 0x0f) | 0x50;
        hash[8] = (hash[8] & 0x3f) | 0x80;
        const hex = hash.slice(0, 16).toString('hex');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
      } catch (e) {
        console.error('computeUserUuid error:', e);
        return null;
      }
    }
    
    // Initialize cachedUuid from initialUploadsPath if it contains a UUID
    let cachedUuid = null;
    let uuidLocked = false; // When true, pairing provided the UUID — don't recompute from email:password
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
    // If device_uuid was provided by mobile pairing, lock it so form changes don't override
    if (${credentials.device_uuid ? 'true' : 'false'}) {
      uuidLocked = true;
      console.log('[UUID] Locked from pairing device_uuid');
    }
    
    async function getUserUploadsPath() {
      // If UUID was provided by mobile pairing, always use it (don't recompute)
      if (uuidLocked && cachedUuid) {
        return baseUploadsPath + (baseUploadsPath.includes('\\\\') ? '\\\\' : '/') + cachedUuid;
      }
      
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      
      // If form has credentials, compute fresh UUID
      if (email && password) {
        console.log('[UUID] Computing for email:', email, 'hasPassword:', !!password);
        const uuid = computeUserUuid(email, password);
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
      if (!pathEl) return;
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
    
    async function getConfig() {
      const downloadPath = await getUserUploadsPath(); // Use computed path with UUID, not input value
      console.log('[getConfig] downloadPath:', downloadPath);
      return { destination: document.getElementById('destination').value, source: document.getElementById('destination').value, email: document.getElementById('email').value, password: document.getElementById('password').value, remoteAddress: document.getElementById('remote-address').value, remotePort: document.getElementById('remote-port').value || '3000', folders: selectedFolders, downloadPath: downloadPath };
    }
    
    // Inline progress helper functions
    function showInlineProgress(type) {
      const hero = document.getElementById('status-hero');
      const progressTitle = document.getElementById('qs-progress-title');
      const progressFill = document.getElementById('inline-progress-fill');
      const progressText = document.getElementById('inline-progress-text');
      const statusMsg = document.getElementById('inline-status-message');
      
      // Switch to active operation mode
      hero.classList.add('active-op');
      progressTitle.className = 'qs-progress-title ' + type;
      
      if (type === 'backing-up') {
        progressTitle.textContent = 'Backing Up...';
        progressFill.className = 'inline-progress-fill';
        progressText.className = 'inline-progress-text';
      } else if (type === 'syncing') {
        progressTitle.textContent = 'Syncing...';
        progressFill.className = 'inline-progress-fill syncing';
        progressText.className = 'inline-progress-text syncing';
      }
      
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
      const progressTitle = document.getElementById('qs-progress-title');
      const statusMsg = document.getElementById('inline-status-message');
      
      // Show completion message briefly
      if (success) {
        progressTitle.textContent = '✓ Complete!';
        progressTitle.className = 'qs-progress-title';
        progressTitle.style.color = '#10B981';
        document.getElementById('inline-progress-fill').style.width = '100%';
        // Update last backup stat
        updateLastBackupStat(message);
      } else {
        progressTitle.textContent = '✕ Error';
        progressTitle.className = 'qs-progress-title';
        progressTitle.style.color = '#EF4444';
      }
      statusMsg.textContent = message;
      
      // Restore quick-stats grid after delay
      setTimeout(() => {
        hero.classList.remove('active-op');
        progressTitle.style.color = '';
        statusMsg.classList.remove('visible');
        document.getElementById('inline-progress-fill').style.width = '0%';
      }, success ? 2000 : 3000);
    }
    
    function setActionButtonsDisabled(disabled) {
      document.querySelectorAll('.action-btn, .action-btn-side').forEach(btn => {
        btn.style.opacity = disabled ? '0.4' : '';
        btn.style.pointerEvents = disabled ? 'none' : '';
      });
    }

    function updateLastBackupStat(message) {
      const el = document.getElementById('qs-backup');
      if (!el) return;
      const now = new Date();
      const hhmm = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      el.textContent = hhmm;
      el.title = message || '';
    }

    function updateQsNfts(count) {
      const el = document.getElementById('qs-nfts');
      if (el) el.textContent = count != null ? String(count) : '—';
    }

    async function startBackup() {
      const config = await getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      if (selectedFolders.length === 0) { alert('Please add at least one folder to backup'); return; }
      currentOperation = 'backup';
      setActionButtonsDisabled(true);
      showInlineProgress('backing-up');
      ipcRenderer.send('start-desktop-backup', config);
    }
    
    async function startSync() {
      const config = await getConfig();
      if (!config.email || !config.password) { alert('Please enter email and password'); return; }
      currentOperation = 'sync';
      setActionButtonsDisabled(true);
      showInlineProgress('syncing');
      ipcRenderer.send('start-desktop-sync', config);
    }
    
    function cancelOperation() {
      ipcRenderer.send(currentOperation === 'backup' ? 'cancel-desktop-backup' : 'cancel-desktop-sync');
      document.getElementById('inline-status-message').textContent = 'Cancelling...';
    }
    
    ipcRenderer.on('backup-progress', (e, d) => { updateInlineProgress(d.progress * 100, d.message); });
    ipcRenderer.on('backup-complete', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(true, d.message); });
    ipcRenderer.on('backup-error', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(false, 'Error: ' + d.message); });
    ipcRenderer.on('sync-progress', (e, d) => { updateInlineProgress(d.progress * 100, d.message); });
    ipcRenderer.on('sync-complete', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(true, d.message); });
    ipcRenderer.on('sync-error', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(false, 'Error: ' + d.message); });
    
    // IPFS Gateways — ipfs.io and gateway.pinata.cloud return 200 directly;
    // w3s.link/nftstorage.link/dweb.link return 301/302 redirects that break in Electron data:text/html
    const IPFS_GATEWAYS = [
      'https://ipfs.io/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://w3s.link/ipfs/',
      'https://dweb.link/ipfs/',
    ];
    // cNFT-optimized gateways (same order)
    const CNFT_IPFS_GATEWAYS = [
      'https://ipfs.io/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://w3s.link/ipfs/',
      'https://dweb.link/ipfs/',
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
    // Deduplicates concurrent fetch-user-nfts calls — all callers share one in-flight DAS request
    // TTL cache: reuse last successful result for 5 minutes to avoid DAS spam on auto-refresh
    let _fetchNFTsInFlight = null;
    let _fetchNFTsCache = null;
    let _fetchNFTsCacheTs = 0;
    const _FETCH_NFTS_TTL_MS = 300000; // 5 minutes
    async function fetchUserNFTsCached(limit = 1000, forceRefresh = false) {
      if (!nftWalletAddress) return { success: false, nfts: [] };
      // Return cached result if still fresh
      if (!forceRefresh && _fetchNFTsCache && (Date.now() - _fetchNFTsCacheTs) < _FETCH_NFTS_TTL_MS) {
        return _fetchNFTsCache;
      }
      if (_fetchNFTsInFlight) return _fetchNFTsInFlight;
      _fetchNFTsInFlight = ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, limit)
        .then(result => { _fetchNFTsCache = result; _fetchNFTsCacheTs = Date.now(); return result; })
        .finally(() => { _fetchNFTsInFlight = null; });
      return _fetchNFTsInFlight;
    }
    let selectedNFTType = 'compressed';
    let selectedNFTStorage = 'ipfs';
    let selectedNFTEdition = 'open';
    let selectedCertificationMode = 'private';
    let selectedStripExif = false;
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
        
        // Initialize with Private mode selected by default
        const privateOption = document.querySelector('.nft-cert-card');
        if (privateOption) {
          selectCertificationMode('private', privateOption);
        }
        
        // Setup watermark checkbox sync (public watermark -> hidden watermark)
        const publicWatermark = document.getElementById('nft-watermark-public');
        const hiddenWatermark = document.getElementById('nft-watermark-check');
        if (publicWatermark && hiddenWatermark) {
          publicWatermark.addEventListener('change', function() {
            hiddenWatermark.checked = this.checked;
          });
        }
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
        updateOnchainLockedState();
        maybeShowNFTWelcome();

        // Defer initial price refresh so UI is interactive before network IPC fires
        if (nftPriceTimer) clearInterval(nftPriceTimer);
        setTimeout(() => {
          refreshNFTPricesRealtime();
          nftPriceTimer = setInterval(refreshNFTPricesRealtime, 15000);
        }, 1500);
      } catch (e) {
        console.error('openNFTMint error:', e);
      }
    }

    
    function closeNFTMint() {
      const section = document.getElementById('nft-mint-section');
      if (section.style.display === 'none') return; // already closed — don't reset a new form
      section.style.display = 'none';
      if (nftPriceTimer) { clearInterval(nftPriceTimer); nftPriceTimer = null; }
      resetNFTMintForm();
      // Restore quick-stats grid
      const hero = document.getElementById('status-hero');
    }
    
    function resetNFTMintForm() {
      selectedNFTPhoto = null;
      selectedNFTEdition = 'open';
      selectedNFTStorage = 'ipfs';
      document.getElementById('nft-photo-select').style.display = 'block';
      document.getElementById('nft-photo-preview').style.display = 'none';
      document.getElementById('nft-name-input').value = '';
      document.getElementById('nft-desc-input').value = '';
      document.getElementById('nft-license-select').value = 'arr';
      document.getElementById('nft-watermark-check').checked = false;
      document.getElementById('nft-encrypt-check').checked = false;
      // Reset UI selections to match defaults
      // Edition group: first .nft-option-group in the mint section
      const editionOptions = document.querySelectorAll('#nft-mint-section .nft-option-group:first-child .nft-option');
      editionOptions.forEach((o, i) => { o.classList.toggle('selected', i === 0); });
      document.querySelectorAll('#nft-storage-group .nft-option').forEach((o, i) => { o.classList.toggle('selected', i === 0); });
      const storageGroup = document.getElementById('nft-storage-group');
      if (storageGroup) storageGroup.style.display = '';
      // Reset certification mode to Private
      const certCards = document.querySelectorAll('.nft-cert-card');
      if (certCards.length > 0) {
        selectCertificationMode('private', certCards[0]);
      }
      // Reset stripExif toggle
      selectedStripExif = false;
      const stripToggle = document.getElementById('nft-strip-exif-toggle');
      if (stripToggle) stripToggle.checked = false;
      updateOnchainLockedState();
      updateMintButton();
    }
    
    async function refreshNFTPricesRealtime() {
      try {
        const feesData = await ipcRenderer.invoke('get-nft-fees');
        if (feesData && feesData.fees) lastNftFees = feesData.fees;
        const [cnft, standard] = await Promise.all([
          ipcRenderer.invoke('estimate-nft-costs', { nftType: 'compressed', storageOption: selectedNFTStorage, filePath: selectedNFTPhoto, edition: selectedNFTEdition }),
          ipcRenderer.invoke('estimate-nft-costs', { nftType: 'standard', storageOption: selectedNFTStorage, filePath: selectedNFTPhoto, edition: selectedNFTEdition }),
        ]);
        if (cnft && !cnft.error && cnft.total) {
          document.getElementById('cnft-price').textContent = '~$' + (cnft.total.usd || 0).toFixed(2);
        }
        if (standard && !standard.error && standard.total) {
          document.getElementById('nft-price').textContent = '~$' + (standard.total.usd || 0).toFixed(2);
        }

        // Storage option fee labels
        if (selectedNFTEdition === 'limited') {
          // Limited Edition: dynamic fee based on file size — show in both slots
          const limitedFeeUsd = lastNftEstimate?.fee?.usd;
          const limitedFeeLabel = limitedFeeUsd != null
            ? '$' + limitedFeeUsd.toFixed(0) + ' (0.1% of file size)'
            : 'Dynamic (0.1% of file size)';
          const cloudEl = document.getElementById('cloud-fee');
          const ipfsEl = document.getElementById('storage-fee');
          if (cloudEl) cloudEl.textContent = limitedFeeLabel;
          if (ipfsEl) ipfsEl.textContent = limitedFeeLabel;
        } else if (lastNftFees) {
          if (selectedNFTType === 'compressed') {
            document.getElementById('cloud-fee').textContent = '$' + lastNftFees.APP_COMMISSION_CNFT_CLOUD_USD.toFixed(2);
            document.getElementById('storage-fee').textContent = '$' + lastNftFees.APP_COMMISSION_CNFT_IPFS_USD.toFixed(2);
          } else {
            document.getElementById('cloud-fee').textContent = '$' + lastNftFees.APP_COMMISSION_STANDARD_CLOUD_USD.toFixed(2);
            document.getElementById('storage-fee').textContent = '$' + lastNftFees.APP_COMMISSION_STANDARD_IPFS_USD.toFixed(2);
          }
        }

        // Selected option estimate for mint button (reuse already-fetched result)
        const selectedEstimate = selectedNFTType === 'compressed' ? cnft : standard;
        if (selectedEstimate && !selectedEstimate.error) {
          lastNftEstimate = selectedEstimate;
        }

        if (lastNftEstimate && lastNftEstimate.total) {
          const box = document.getElementById('nft-cost-breakdown');
          if (box) box.style.display = 'block';
          const totalEl = document.getElementById('nft-cost-total');
          if (totalEl) totalEl.textContent = '~$' + (Number(lastNftEstimate.total.usd) || 0).toFixed(2);
          // Update simplified cost display
          const simpleCost = document.getElementById('nft-simple-cost');
          if (simpleCost) simpleCost.textContent = '~$' + (Number(lastNftEstimate.total.usd) || 0).toFixed(2);
        }

        updateMintButton();
      } catch (e) {
        console.error('refreshNFTPricesRealtime error:', e);
      }
    }
    
    // New simplified certification mode handler
    function selectCertificationMode(mode, el) {
      selectedCertificationMode = mode;
      // Update UI selection
      el.parentElement.querySelectorAll('.nft-cert-card').forEach(o => {
        o.classList.remove('selected');
      });
      el.classList.add('selected');
      
      // Auto-configure settings based on mode (must match solana-seeker NFTPhotoPicker presets)
      if (mode === 'private') {
        // Private: Always encrypted, IPFS storage, Open Edition, Compressed, no watermark, stripExif off
        selectedNFTEdition = 'open';
        selectedNFTStorage = 'ipfs';
        selectedNFTType = 'compressed';
        selectedStripExif = false;
        document.getElementById('nft-encrypt-check').checked = true;
        document.getElementById('watermark-option').style.display = 'none';
        document.getElementById('nft-watermark-public').checked = false;
        const stripToggle1 = document.getElementById('nft-strip-exif-toggle');
        if (stripToggle1) { stripToggle1.checked = false; stripToggle1.disabled = true; }
        const stripOption1 = document.getElementById('strip-exif-option');
        if (stripOption1) stripOption1.style.opacity = '0.4';
        const stripDesc1 = document.getElementById('nft-strip-exif-desc');
        if (stripDesc1) stripDesc1.textContent = 'EXIF preserved in private mode';
      } else {
        // Public: Unencrypted, IPFS storage, Open Edition, Compressed, optional watermark, stripExif off
        selectedNFTEdition = 'open';
        selectedNFTStorage = 'ipfs';
        selectedNFTType = 'compressed';
        selectedStripExif = false;
        document.getElementById('nft-encrypt-check').checked = false;
        document.getElementById('watermark-option').style.display = 'block';
        const stripToggle2 = document.getElementById('nft-strip-exif-toggle');
        if (stripToggle2) { stripToggle2.checked = false; stripToggle2.disabled = false; }
        const stripOption2 = document.getElementById('strip-exif-option');
        if (stripOption2) stripOption2.style.opacity = '1';
        const stripDesc2 = document.getElementById('nft-strip-exif-desc');
        if (stripDesc2) stripDesc2.textContent = 'Strip location, camera info, and other metadata';
      }
      
      // Update hidden controls to match
      const editionOptions = document.querySelectorAll('.nft-option-group')[1]?.querySelectorAll('.nft-option');
      if (editionOptions) {
        editionOptions.forEach(o => o.classList.remove('selected'));
        editionOptions[0]?.classList.add('selected'); // Open Edition
      }
      
      updateOnchainLockedState();
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    function selectNFTType(type, el) {
      selectedNFTType = type;
      el.parentElement.querySelectorAll('.nft-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    function updateOnchainLockedState() {
      const isLimited = selectedNFTEdition === 'limited';
      // Limited Edition embeds full original image on-chain — encryption & watermark are user-choosable
      // Only Open Edition + onchain (SVG vector) locks them (SVG can't be meaningfully encrypted)
      const isOnchainLocked = !isLimited && selectedNFTEdition === 'open' && selectedNFTStorage === 'onchain';
      const isCloudSelected = selectedNFTStorage === 'cloud';
      const wmCheck = document.getElementById('nft-watermark-check');
      const encCheck = document.getElementById('nft-encrypt-check');
      const storageGroup = document.getElementById('nft-storage-group');
      if (wmCheck) {
        wmCheck.disabled = isOnchainLocked;
        if (isOnchainLocked) wmCheck.checked = false;
        wmCheck.parentElement.style.opacity = isOnchainLocked ? '0.4' : '1';
        wmCheck.parentElement.style.pointerEvents = isOnchainLocked ? 'none' : 'auto';
      }
      if (encCheck) {
        if (isCloudSelected) {
          // StealthCloud: encryption is mandatory — force on and lock
          encCheck.checked = true;
          encCheck.disabled = true;
          encCheck.parentElement.style.opacity = '1';
          encCheck.parentElement.style.pointerEvents = 'none';
          encCheck.parentElement.title = 'Encryption is required for Encrypted Cloud storage';
        } else if (isOnchainLocked) {
          encCheck.checked = false;
          encCheck.disabled = true;
          encCheck.parentElement.style.opacity = '0.4';
          encCheck.parentElement.style.pointerEvents = 'none';
          encCheck.parentElement.title = '';
        } else {
          encCheck.disabled = false;
          encCheck.parentElement.style.opacity = '1';
          encCheck.parentElement.style.pointerEvents = 'auto';
          encCheck.parentElement.title = '';
        }
      }
      if (storageGroup) {
        storageGroup.style.display = isLimited ? 'none' : '';
      }
    }

    function selectNFTEdition(edition, el) {
      selectedNFTEdition = edition;
      el.parentElement.querySelectorAll('.nft-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      if (edition === 'limited') {
        selectedNFTStorage = 'onchain';
      }
      updateOnchainLockedState();
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    function selectNFTStorage(storage, el) {
      selectedNFTStorage = storage;
      el.parentElement.querySelectorAll('.nft-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      updateOnchainLockedState();
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    let _filePickerOpen = false;
    const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','heic','heif','bmp','tiff','tif','avif','dng','cr2','cr3','nef','arw','orf','rw2'];
    
    function handleNFTPhotoSelected(filePath) {
      selectedNFTPhoto = filePath;
      document.getElementById('nft-preview-img').src = 'http://localhost:3000/local-image?path=' + encodeURIComponent(filePath);
      document.getElementById('nft-photo-select').style.display = 'none';
      document.getElementById('nft-photo-preview').style.display = 'block';
      // Auto-populate name from filename if field is empty
      const nameInput = document.getElementById('nft-name-input');
      if (nameInput && !nameInput.value.trim()) {
        const baseName = filePath.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        if (baseName) nameInput.value = baseName;
      }
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    async function selectNFTPhoto() {
      // Open Pictures folder instantly (same approach as Settings > Open button)
      // User drags the photo from the opened folder onto the drop zone
      try {
        await ipcRenderer.invoke('open-pictures-folder');
      } catch (e) {
        console.error('selectNFTPhoto error:', e);
      }
    }
    
    // Prevent default file drag behavior globally (Electron would navigate to the file)
    document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    document.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); });
    
    // Drag-and-drop support for NFT photo select area
    (function setupNFTPhotoDrop() {
      const dropTarget = document.getElementById('nft-photo-select');
      if (!dropTarget) return;
      dropTarget.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropTarget.style.borderColor = '#6366f1';
        dropTarget.style.background = 'rgba(99,102,241,0.08)';
      });
      dropTarget.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropTarget.style.borderColor = '';
        dropTarget.style.background = '';
      });
      dropTarget.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropTarget.style.borderColor = '';
        dropTarget.style.background = '';
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (IMAGE_EXTS.includes(ext)) {
            handleNFTPhotoSelected(file.path);
          } else {
            console.warn('[NFT] Dropped file is not a supported image:', file.name);
          }
        }
      });
    })();
    
    function removeNFTPhoto() {
      selectedNFTPhoto = null;
      document.getElementById('nft-photo-select').style.display = 'block';
      document.getElementById('nft-photo-preview').style.display = 'none';
      refreshNFTPricesRealtime();
      updateMintButton();
    }
    
    let walletPollInterval = null;
    let walletHandledByPoll = false; // Flag to prevent double-fire from IPC broadcast
    
    function connectNFTWallet() {
      ipcRenderer.send('open-wallet-connect');
      
      document.getElementById('mint-wallet-text').textContent = 'Connecting...';
      const hint = document.getElementById('wallet-connect-hint');
      if (hint) hint.style.display = 'block';
      
      // Poll for wallet address
      if (walletPollInterval) clearInterval(walletPollInterval);
      walletPollInterval = setInterval(async () => {
        try {
          const res = await fetch('http://localhost:3000/wallet-address');
          const data = await res.json();
          if (data.success && data.address) {
            clearInterval(walletPollInterval);
            walletPollInterval = null;
            const walletChanged = nftWalletAddress && nftWalletAddress !== data.address;
            nftWalletAddress = data.address;
            walletHandledByPoll = true;
            if (hint) hint.style.display = 'none';
            updateMintWalletUI();
            // Notify main process so connectedWalletAddress stays in sync
            ipcRenderer.send('wallet-connected-from-browser', data.address);
            // Only purge + clear cache when wallet actually changed
            if (walletChanged) {
              allNFTs = [];
              cachedCerts = [];
              nftPageIndex = 0;
              stopNFTAutoRefresh();
              try { await ipcRenderer.invoke('purge-nft-storage'); } catch (_) {}
              try { await ipcRenderer.invoke('clear-nft-cache'); } catch (_) {}
            }
            loadNFTAlbum();
            // Clear certs UI when wallet changed, and always reload if certs overlay is open
            if (walletChanged) {
              const certsList = document.getElementById('certs-list');
              const certsLoading = document.getElementById('certs-loading');
              const certsEmpty = document.getElementById('certs-empty');
              if (certsList) certsList.innerHTML = '';
              if (certsLoading) certsLoading.style.display = 'block';
              if (certsEmpty) certsEmpty.style.display = 'none';
            }
            const certsOv = document.getElementById('certs-overlay');
            if (certsOv && certsOv.classList.contains('active')) {
              loadCertificates();
            }
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
            if (hint) hint.style.display = 'none';
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
        text.textContent = 'No credentials connected';
      }
      updateMintButton();
    }
    
    function updateMintButton() {
      const btn = document.getElementById('nft-mint-btn');
      btn.disabled = !selectedNFTPhoto || !nftWalletAddress || isMinting;
      if (!btn.disabled && lastNftEstimate && lastNftEstimate.total) {
        btn.innerHTML = 'Certify Original (~$' + (lastNftEstimate.total.usd || 0).toFixed(2) + ')';
      } else if (!isMinting) {
        btn.innerHTML = 'Certify Original';
      }
    }
    
    async function doMintNFT() {
      if (isMinting || !selectedNFTPhoto || !nftWalletAddress) return;
      isMinting = true;
      
      // Show NFT creation progress in quick-stats
      const hero = document.getElementById('status-hero');
      const progressTitle = document.getElementById('qs-progress-title');
      hero.classList.add('active-op');
      progressTitle.className = 'qs-progress-title creating-nft';
      progressTitle.textContent = 'Certifying...';
      document.getElementById('inline-status-message').classList.add('visible');
      document.getElementById('inline-status-message').textContent = 'Uploading...';
      
      const btn = document.getElementById('nft-mint-btn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Certifying...';
      
      const nameInputVal = document.getElementById('nft-name-input').value.trim();
      const selectedPath = (typeof selectedNFTPhoto === 'string')
        ? selectedNFTPhoto
        : (selectedNFTPhoto && typeof selectedNFTPhoto.path === 'string')
          ? selectedNFTPhoto.path
          : String(selectedNFTPhoto || '');
      const name = nameInputVal || (selectedPath ? selectedPath.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : '') || 'My Original';
      const description = document.getElementById('nft-desc-input').value || '';
      
      const license = document.getElementById('nft-license-select').value || 'arr';
      const watermark = document.getElementById('nft-watermark-check').checked;
      const encrypt = document.getElementById('nft-encrypt-check').checked;
      const stripExif = selectedStripExif;
      
      try {
        const result = await ipcRenderer.invoke('mint-nft', {
          nftType: selectedNFTType,
          storageOption: selectedNFTStorage,
          filePath: selectedPath,
          name: name,
          description: description,
          walletAddress: nftWalletAddress,
          edition: selectedNFTEdition,
          license: license,
          watermark: watermark,
          encrypt: encrypt,
          stripExif: stripExif,
          certificationMode: selectedCertificationMode,
        });
        
        if (result.success) {
          // Cache encryptionData from mint result (needed for save-minted-nft after payment)
          if (result.encryptionData) {
            window._pendingMintEncryptionData = result.encryptionData;
          }
          // Cache thumbnailUrl from mint result (encrypted thumb on StealthCloud)
          window._pendingMintThumbnailUrl = result.thumbnailUrl || null;
          window._pendingMintIpfsThumbnailUrl = result.ipfsThumbnailUrl || null;
          // Cache RFC 3161 + C2PA proof data + attributes (needed after payment completes)
          window._pendingMintProofData = {
            tsaToken: result.tsaToken || null,
            tsaUrl: result.tsaUrl || null,
            tsaPolicy: result.tsaPolicy || null,
            c2paManifest: result.c2paManifest || null,
            mintTimestamp: result.mintTimestamp || null,
            attributes: result.attributes || [],
          };
          console.log('[NFT] Cached proof data: tsaToken?', !!result.tsaToken, 'c2pa?', !!result.c2paManifest, 'timestamp:', result.mintTimestamp);
          btn.innerHTML = '<span>✓</span> ' + (result.message || 'Complete payment in browser');
          btn.style.background = 'linear-gradient(135deg, #14F195 0%, #10B981 100%)';
          setTimeout(() => {
            closeNFTMint();
            btn.style.background = '';
            isMinting = false;
            // Restore quick-stats grid after NFT creation
            hero.classList.remove('active-op');
            document.getElementById('inline-status-message').classList.remove('visible');
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
          btn.innerHTML = 'Certify Original';
          updateMintButton();
          // Restore quick-stats grid after certification failure
          hero.classList.remove('active-op');
          document.getElementById('inline-status-message').classList.remove('visible');
        }, 3000);
      }
    }
    
    ipcRenderer.on('mint-progress', (e, data) => {
      document.getElementById('nft-mint-btn').innerHTML = '<span>⏳</span> ' + data.status;
      // Update quick-stats progress message
      const statusMsg = document.getElementById('inline-status-message');
      if (statusMsg) statusMsg.textContent = data.status;
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
    
    async function showMintSuccessPopup(data) {
      // Bring window to front
      ipcRenderer.send('bring-to-front');
      
      // Show success popup IMMEDIATELY — don't block on DAS resolution or save
      const overlay = document.createElement('div');
      overlay.id = 'mint-success-overlay';
      overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
      
      const popup = document.createElement('div');
      popup.style.cssText = 'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border:1px solid #14F195;border-radius:20px;padding:24px;max-width:400px;width:100%;text-align:center;box-shadow:0 0 60px rgba(20,241,149,0.3);';
      
      const _totalSol = data.estimatedTotalSol || (lastNftEstimate && lastNftEstimate.total ? lastNftEstimate.total.sol : null) || data.amount || 0;
      const _totalUsd = data.estimatedTotalUsd || (lastNftEstimate && lastNftEstimate.total ? lastNftEstimate.total.usd : null) || 0;
      const solAmount = _totalSol ? _totalSol.toFixed(6) : '0';
      const usdAmount = _totalUsd ? _totalUsd.toFixed(2) : '0';
      
      var nftTypeLabel = data.nftType === 'compressed' ? 'Compressed Record' : 'Standard Record';
      var imageHtml = data.imageUrl ? '<img src="' + data.imageUrl + '" onerror="this.style.display=\\\'none\\\'" style="width:120px;height:120px;border-radius:12px;object-fit:cover;margin-bottom:20px;border:2px solid #9945FF;">' : '';
      var mintAddressHtml = data.mintAddress ? '<div style="display:flex;justify-content:space-between;margin-top:8px;"><span style="color:#888;font-size:12px;">Record ID</span><span style="color:#fff;font-size:10px;font-family:monospace;">' + data.mintAddress.slice(0,8) + '...' + data.mintAddress.slice(-4) + '</span></div>' : '';
      var isRealPaymentTx = data.paymentTx && !data.paymentTx.startsWith('fee_wallet');
      var paymentTxHtml = isRealPaymentTx ? '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#888;font-size:12px;">Payment</span><a href="https://solscan.io/tx/' + data.paymentTx + '" target="_blank" style="color:#9945FF;font-size:12px;text-decoration:none;">' + data.paymentTx.slice(0,8) + '...' + data.paymentTx.slice(-4) + ' ↗</a></div>' : '';
      
      popup.innerHTML = '<div style="font-size:64px;margin-bottom:16px;">🎉</div>' +
        '<h2 style="color:#14F195;font-size:24px;margin-bottom:8px;">Original Certified!</h2>' +
        '<p style="color:#888;font-size:14px;margin-bottom:20px;">' + nftTypeLabel + '</p>' +
        imageHtml +
        '<div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:16px;margin-bottom:20px;text-align:left;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
            '<span style="color:#888;font-size:12px;">Total Spent</span>' +
            '<span style="color:#14F195;font-size:14px;font-weight:600;">' + solAmount + ' SOL (~$' + usdAmount + ')</span>' +
          '</div>' +
          paymentTxHtml +
          '<div style="display:flex;justify-content:space-between;">' +
            '<span style="color:#888;font-size:12px;">Certification TX</span>' +
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
      
      // Background: save NFT immediately, refresh album, then resolve cNFT assetId
      (async () => {
        const pendingEncData = window._pendingMintEncryptionData || null;
        window._pendingMintEncryptionData = null;
        const isCNFT = data.nftType === 'compressed';
        const initialId = String(data.mintAddress || '');

        // Step 1: Save immediately with temporary ID (tx-based for cNFTs without mintAddress)
        const tempMintAddress = isCNFT
          ? (initialId ? ('cnft_' + initialId.replace(/^cnft_/, '')) : (data.mintTx ? ('tx_' + data.mintTx) : null))
          : (initialId || null);
        // Match mobile: use thumbnailUrl as display imageUrl when available
        // (mobile nftOperations.js line 3754: imageUrl: result.thumbnailUrl || result.imageUrl)
        const savedThumbUrl = window._pendingMintThumbnailUrl || null;
        const displayImageUrl = savedThumbUrl || data.imageUrl || null;
        try {
          await ipcRenderer.invoke('save-minted-nft', {
            mintAddress: tempMintAddress,
            assetId: isCNFT ? (initialId || null) : null,
            ownerAddress: data.wallet || nftWalletAddress,
            name: data.name || 'Photo Original',
            imageUrl: displayImageUrl,
            metadataUrl: data.metadataUrl || null,
            txSignature: data.mintTx || data.paymentTx || null,
            storageType: data.storageOption || 'ipfs',
            isCompressed: isCNFT,
            nftType: data.nftType || 'compressed',
            edition: data.edition || 'open',
            license: data.license || 'arr',
            watermarked: data.watermark === 'true',
            encrypted: data.encrypt === 'true',
            encryptionData: pendingEncData,
            thumbnailUrl: savedThumbUrl,
            ipfsThumbnailUrl: window._pendingMintIpfsThumbnailUrl || null,
            createdAt: new Date().toISOString(),
            attributes: (window._pendingMintProofData?.attributes) || [],
            contentHash: data.contentHash || null,
            exifHash: data.exifHash || null,
            exifRawHash: data.exifRawHash || null,
            exifBindingHash: data.exifBindingHash || null,
            certificationMode: data.certificationMode || null,
          });
          window._pendingMintThumbnailUrl = null;
          window._pendingMintIpfsThumbnailUrl = null;
          console.log('[NFT] Minted NFT saved to storage (temp ID:', tempMintAddress, ')');
        } catch (saveErr) {
          console.warn('[NFT] Post-mint save failed:', saveErr.message);
        }

        // Step 2: Directly append minted NFT to in-memory grid so it appears instantly
        // (DAS cache is stale — won't include the new NFT for up to 2 minutes)
        if (tempMintAddress) {
          const mintedNFT = {
            mintAddress: tempMintAddress,
            assetId: isCNFT ? (initialId || null) : null,
            ownerAddress: data.wallet || nftWalletAddress,
            name: data.name || 'Photo Original',
            imageUrl: displayImageUrl,
            image: displayImageUrl,
            metadataUrl: data.metadataUrl || null,
            txSignature: data.mintTx || data.paymentTx || null,
            storageType: data.storageOption || 'ipfs',
            isCompressed: isCNFT,
            nftType: data.nftType || 'compressed',
            edition: data.edition || 'open',
            license: data.license || 'arr',
            watermarked: data.watermark === 'true',
            encrypted: data.encrypt === 'true',
            encryptionData: pendingEncData,
            thumbnailUrl: savedThumbUrl,
            ipfsThumbnailUrl: window._pendingMintIpfsThumbnailUrl || null,
            createdAt: new Date().toISOString(),
          };
          appendNewNFTs([mintedNFT]);
          renderNFTPage();
        }
        // Invalidate DAS cache so next refresh picks up the real cnft_ entry
        _fetchNFTsCache = null;
        _fetchNFTsCacheTs = 0;
        checkForNewNFTsOnce();
        startNFTAutoRefresh();

        // Step 3: Generate Certificate of Authenticity IMMEDIATELY (before DAS resolution)
        // DAS resolution can take minutes when rate-limited — cert must not be blocked by it.
        // Cert is created with temp tx_ ID now, updated to cnft_ ID later via update-certificate-mint.
        try {
          const pendingProof = window._pendingMintProofData || null;
          window._pendingMintProofData = null;
          console.log('[NFT] Certificate: pendingProof tsaToken?', !!pendingProof?.tsaToken, 'c2pa?', !!pendingProof?.c2paManifest, 'mintTimestamp?', pendingProof?.mintTimestamp);
          await ipcRenderer.invoke('generate-certificate', {
            forceGenerate: true, // bypass tx_ guard — this is a real post-mint call
            mintAddress: tempMintAddress,
            txSignature: data.mintTx || data.paymentTx || null,
            ownerAddress: data.wallet || nftWalletAddress,
            name: data.name || 'Photo Original',
            edition: data.edition || 'open',
            license: data.license || 'arr',
            watermarked: data.watermark === 'true',
            encrypted: data.encrypt === 'true',
            storageType: data.storageOption || 'ipfs',
            imageUrl: data.imageUrl || null,
            metadataUrl: data.metadataUrl || null,
            contentHash: data.contentHash || null,
            exifHash: data.exifHash || null,
            exifRawHash: data.exifRawHash || null,
            exifBindingHash: data.exifBindingHash || null,
            certificationMode: data.certificationMode || null,
            createdAt: new Date().toISOString(),
            tsaToken: pendingProof?.tsaToken || null,
            tsaUrl: pendingProof?.tsaUrl || null,
            tsaPolicy: pendingProof?.tsaPolicy || null,
            c2paManifest: pendingProof?.c2paManifest || null,
            mintTimestamp: pendingProof?.mintTimestamp || null,
          });
          console.log('[NFT] Certificate of Authenticity generated');
        } catch (certErr) {
          console.warn('[NFT] Certificate generation failed:', certErr.message);
        }

        // Step 4: For cNFTs without mintAddress, resolve real assetId from DAS in background
        let resolvedMintAddress = tempMintAddress;
        if (isCNFT && !initialId && (data.metadataUrl || data.mintTx) && nftWalletAddress) {
          try {
            console.log('[NFT] Resolving cNFT assetId from DAS for metadataUrl:', data.metadataUrl);
            for (let attempt = 0; attempt < 5; attempt++) {
              if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
              const dasRes = await ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, 1000);
              if (dasRes && dasRes.success && Array.isArray(dasRes.nfts)) {
                const match = dasRes.nfts.find(n =>
                  (data.metadataUrl && n.metadataUrl && n.metadataUrl === data.metadataUrl) ||
                  (data.name && n.name && n.name === data.name && n.txSignature === data.mintTx)
                );
                if (match) {
                  const realId = String(match.assetId || match.mintAddress || '').replace(/^cnft_/, '');
                  resolvedMintAddress = 'cnft_' + realId;
                  console.log('[NFT] Resolved cNFT assetId:', realId);
                  _fetchNFTsInFlight = null;
                  // Update saved NFT with real assetId
                  try {
                    await ipcRenderer.invoke('save-minted-nft', {
                      mintAddress: resolvedMintAddress,
                      assetId: realId,
                      ownerAddress: data.wallet || nftWalletAddress,
                      name: data.name || 'Photo Original',
                      imageUrl: displayImageUrl,
                      metadataUrl: data.metadataUrl || null,
                      txSignature: data.mintTx || data.paymentTx || null,
                      storageType: data.storageOption || 'ipfs',
                      isCompressed: true,
                      nftType: 'compressed',
                      edition: data.edition || 'open',
                      license: data.license || 'arr',
                      watermarked: data.watermark === 'true',
                      encrypted: data.encrypt === 'true',
                      encryptionData: pendingEncData,
                      thumbnailUrl: savedThumbUrl,
                      ipfsThumbnailUrl: window._pendingMintIpfsThumbnailUrl || null,
                      createdAt: new Date().toISOString(),
                      attributes: (window._pendingMintProofData?.attributes) || [],
                      contentHash: data.contentHash || null,
                      exifHash: data.exifHash || null,
                      exifRawHash: data.exifRawHash || null,
                      exifBindingHash: data.exifBindingHash || null,
                      certificationMode: data.certificationMode || null,
                    });
                    console.log('[NFT] Updated saved NFT with resolved assetId:', resolvedMintAddress);
                  } catch (updateErr) {
                    console.warn('[NFT] Failed to update saved NFT with resolved assetId:', updateErr.message);
                  }
                  // Remove old temp tx_ entry to prevent duplicates
                  if (tempMintAddress && tempMintAddress !== resolvedMintAddress) {
                    try {
                      await ipcRenderer.invoke('remove-stored-nft', tempMintAddress);
                      console.log('[NFT] Removed old temp entry:', tempMintAddress);
                    } catch (_) {}
                    // Update certificate mintAddress from temp tx_ to real cnft_ ID
                    try {
                      await ipcRenderer.invoke('update-certificate-mint', tempMintAddress, resolvedMintAddress);
                      console.log('[NFT] Certificate updated with resolved mintAddress:', resolvedMintAddress);
                    } catch (_) {}
                  }
                  // Refresh album again with real ID
                  checkForNewNFTsOnce();
                  break;
                }
              }
            }
          } catch (dasErr) {
            console.warn('[NFT] DAS assetId resolution failed:', dasErr.message);
          }
        }

        // Step 5: Background DAS retry — if mint still has tx_ prefix, keep trying to resolve
        if (resolvedMintAddress.startsWith('tx_') && isCNFT && nftWalletAddress && (data.metadataUrl || data.mintTx)) {
          (async () => {
            console.log('[NFT] Starting background DAS retry for', tempMintAddress);
            for (let bgAttempt = 0; bgAttempt < 10; bgAttempt++) {
              await new Promise(r => setTimeout(r, 10000)); // 10s between retries
              try {
                const dasRes = await ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, 1000);
                if (dasRes && dasRes.success && Array.isArray(dasRes.nfts)) {
                  const match = dasRes.nfts.find(n =>
                    (data.metadataUrl && n.metadataUrl && n.metadataUrl === data.metadataUrl) ||
                    (data.name && n.name && n.name === data.name && n.txSignature === data.mintTx)
                  );
                  if (match) {
                    const realId = String(match.assetId || match.mintAddress || '').replace(/^cnft_/, '');
                    const newMint = 'cnft_' + realId;
                    console.log('[NFT] Background DAS resolved:', newMint);
                    _fetchNFTsInFlight = null;
                    try { await ipcRenderer.invoke('save-minted-nft', { mintAddress: newMint, assetId: realId, ownerAddress: data.wallet || nftWalletAddress, name: data.name || 'Photo Original', imageUrl: displayImageUrl, metadataUrl: data.metadataUrl || null, txSignature: data.mintTx || data.paymentTx || null, storageType: data.storageOption || 'ipfs', isCompressed: true, nftType: 'compressed', edition: data.edition || 'open', license: data.license || 'arr', watermarked: data.watermark === 'true', encrypted: data.encrypt === 'true', encryptionData: pendingEncData, thumbnailUrl: savedThumbUrl, ipfsThumbnailUrl: window._pendingMintIpfsThumbnailUrl || null, createdAt: new Date().toISOString(), contentHash: data.contentHash || null, exifHash: data.exifHash || null, exifRawHash: data.exifRawHash || null, exifBindingHash: data.exifBindingHash || null, certificationMode: data.certificationMode || null }); } catch (_) {}
                    try { await ipcRenderer.invoke('remove-stored-nft', tempMintAddress); } catch (_) {}
                    try { await ipcRenderer.invoke('update-certificate-mint', tempMintAddress, newMint); console.log('[NFT] Background: cert updated to', newMint); } catch (_) {}
                    checkForNewNFTsOnce();
                    return; // done
                  }
                }
              } catch (_) {}
            }
            console.warn('[NFT] Background DAS retry exhausted for', tempMintAddress);
          })();
        }
      })();
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
      syncNFTFilterButtons();
      updateNFTResultsSummary();
      if (allNFTs.length > 0) {
        renderNFTPage();
        checkForNewNFTsOnce();
        startNFTAutoRefresh();
      } else {
        loadNFTAlbum();
      }
    }
    
    function closeNFTAlbum() {
      const overlay = document.getElementById('nft-album-overlay');
      if (overlay) {
        overlay.classList.remove('active');
      }
      stopNFTAutoRefresh();
    }
    
    // ========== Certificates Functions ==========
    let cachedCerts = [];
    let certPollInterval = null;
    let _certSyncRunning = false; // Concurrency lock — prevents bg and fg from overlapping
    
    // Shared enrichment: enrich certs array from an nftMap, then attempt RFC3161 token recovery
    // Returns true if any field was enriched (caller should persist)
    async function enrichCertsWithNFTData(certs, nftMap, logPrefix) {
      let enriched = false;
      const hasNFTs = nftMap && Object.keys(nftMap).length > 0;
      for (const c of certs) {
        const cKey = (c.mintAddress || '').replace(/^cnft_/, '');
        const nft = hasNFTs ? nftMap[cKey] : null;
        if (!nft) continue;
        const attrs = nft.metadata?.attributes || nft.attributes || [];
        if (!c.contentHash) { const a = attrs.find(x => x.trait_type === 'Content Hash'); if (a) { c.contentHash = a.value; enriched = true; } }
        if (!c.exifRawHash) { const a = attrs.find(x => x.trait_type === 'EXIF Raw Hash'); if (a) { c.exifRawHash = a.value; enriched = true; } }
        if (!c.exifHash) { const a = attrs.find(x => x.trait_type === 'EXIF Hash'); if (a) { c.exifHash = a.value; enriched = true; } }
        if (!c.exifBindingHash) { const a = attrs.find(x => x.trait_type === 'EXIF Binding Hash'); if (a) { c.exifBindingHash = a.value; enriched = true; } }
        if (!c.cameraHash) { const a = attrs.find(x => x.trait_type === 'Camera Hash'); if (a) { c.cameraHash = a.value; enriched = true; } }
        if (!c.license || c.license === 'arr') { const a = attrs.find(x => x.trait_type === 'License'); if (a) { c.license = a.value; enriched = true; } }
        if (!c.storageType && nft.storageType) { c.storageType = nft.storageType; enriched = true; }
        if (!c.encrypted && nft.encrypted) { c.encrypted = true; enriched = true; }
        if (!c.watermarked && nft.watermarked) { c.watermarked = true; enriched = true; }
        const metaCert = nft.metadata?.properties?.certificate;
        if (!c.rfc3161Token && metaCert?.rfc3161?.tsaTokenBase64) { c.rfc3161Token = metaCert.rfc3161.tsaTokenBase64; c.hasRfc3161 = true; enriched = true; }
        if (!c.c2paManifest && nft.metadata?.properties?.c2pa) { c.c2paManifest = nft.metadata.properties.c2pa; c.hasC2pa = true; enriched = true; }
        if (!c.rfc3161Token && !c.hasRfc3161) { const a = attrs.find(x => x.trait_type === 'RFC 3161 Timestamp'); if (a) { c.hasRfc3161 = true; enriched = true; } }
        if (!c.c2paManifest && !c.hasC2pa) { const a = attrs.find(x => x.trait_type === 'C2PA Provenance'); if (a) { c.hasC2pa = true; enriched = true; } }
        // Fallback: NFT-level flags (survive metadata stripping)
        if (!c.hasRfc3161 && nft.hasRfc3161) { c.hasRfc3161 = true; enriched = true; }
        if (!c.hasC2pa && nft.hasC2pa) { c.hasC2pa = true; enriched = true; }
        // NOTE: Do NOT unconditionally set hasRfc3161/hasC2pa — only set when evidence exists.
        // Setting the flag without the actual token causes permanent "Recovering..." UI state.
      }
      if (enriched) console.log('[Certs] ' + logPrefix + ' enriched certs from', Object.keys(nftMap).length, 'NFTs');
      // Fetch rfc3161Token from metadata URI for certs that have the flag but no token
      // Skip certs already attempted in the last 2 hours to avoid infinite retry loop
      const RECOVERY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
      const now = Date.now();
      let recoveryAttempted = 0;
      for (const c of certs) {
        const needsRfc = c.hasRfc3161 && !c.rfc3161Token;
        const needsC2pa = c.hasC2pa && !c.c2paManifest;
        if (needsRfc || needsC2pa) {
          if (c._recoveryAttemptedAt && (now - c._recoveryAttemptedAt) < RECOVERY_COOLDOWN_MS) continue;
          const cKey = (c.mintAddress || '').replace(/^cnft_/, '');
          const nft = hasNFTs ? nftMap[cKey] : null;
          const metaUrl = nft?.metadataUrl || nft?.metadata?.uri || nft?.uri || c.metadataUrl || '';
          if (metaUrl) {
            try {
              const encData = (nft?.encrypted || c.encrypted) ? (nft?.encryptionData || null) : null;
              const result = await ipcRenderer.invoke('fetch-rfc3161-token', metaUrl, encData);
              c._recoveryAttemptedAt = Date.now();
              recoveryAttempted++;
              if (result && result.token && !c.rfc3161Token) { c.rfc3161Token = result.token; enriched = true; console.log('[Certs] ' + logPrefix + ' got RFC3161 token for', c.name); }
              if (result && result.c2pa && !c.c2paManifest) { c.c2paManifest = result.c2pa; c.hasC2pa = true; enriched = true; }
              // Enrich hashes from fetched metadata attributes (matches mobile recovery paths)
              if (result) {
                if (result.contentHash && !c.contentHash) { c.contentHash = result.contentHash; enriched = true; }
                if (result.exifRawHash && !c.exifRawHash) { c.exifRawHash = result.exifRawHash; enriched = true; }
                if (result.exifHash && !c.exifHash) { c.exifHash = result.exifHash; enriched = true; }
                if (result.exifBindingHash && !c.exifBindingHash) { c.exifBindingHash = result.exifBindingHash; enriched = true; }
                if (result.cameraHash && !c.cameraHash) { c.cameraHash = result.cameraHash; enriched = true; }
              }
            } catch (_) { c._recoveryAttemptedAt = Date.now(); recoveryAttempted++; }
          }
          if (recoveryAttempted >= 5) break; // Cap per cycle
        }
      }
      if (enriched || recoveryAttempted > 0) {
        // Strip _recoveryAttemptedAt before persisting — it's an in-memory cooldown that shouldn't create stale locks across restarts
        const certsToSave = certs.map(c => { const { _recoveryAttemptedAt, ...rest } = c; return rest; });
        try { await ipcRenderer.invoke('save-enriched-certs', certsToSave); } catch (_) {}
      }
      return enriched;
    }
    
    // Shared: build NFT map from owned + local stored NFTs
    async function buildNFTMap(ownedNFTs) {
      const nftMap = {};
      for (const nft of (ownedNFTs || [])) {
        const key = (nft.mintAddress || nft.assetId || '').replace(/^cnft_/, '');
        if (key) nftMap[key] = nft;
      }
      try {
        const localNFTs = await ipcRenderer.invoke('get-stored-nfts') || [];
        for (const s of localNFTs) {
          const key = (s.mintAddress || '').replace(/^cnft_/, '');
          if (key && !nftMap[key]) nftMap[key] = s;
          else if (key && nftMap[key]) {
            if (s.metadata && !nftMap[key].metadata) nftMap[key].metadata = s.metadata;
            if (s.attributes?.length && !nftMap[key].attributes?.length) nftMap[key].attributes = s.attributes;
          }
        }
      } catch (_) {}
      return nftMap;
    }
    
    // Shared: filter certs by wallet ownership
    async function filterCertsByOwnership(certs) {
      if (certs.length === 0) return certs;
      try {
        const ownedResult = await fetchUserNFTsCached();
        if (ownedResult && ownedResult.success && Array.isArray(ownedResult.nfts) && ownedResult.nfts.length > 0) {
          const ownedSet = new Set(
            ownedResult.nfts
              .map(n => n && (n.mintAddress || n.assetId) ? String(n.mintAddress || n.assetId).replace('cnft_', '') : null)
              .filter(Boolean)
          );
          try {
            const localNFTs = await ipcRenderer.invoke('get-stored-nfts') || [];
            for (const n of localNFTs) {
              const k = n && (n.mintAddress || n.assetId) ? String(n.mintAddress || n.assetId).replace('cnft_', '') : null;
              if (k) ownedSet.add(k);
            }
          } catch (_) {}
          return certs.filter(c => {
            const id = c && c.mintAddress ? String(c.mintAddress).replace('cnft_', '') : null;
            if (id && id.startsWith('tx_')) return true;
            return id && ownedSet.has(id);
          });
        }
      } catch (_) {}
      return certs;
    }
    
    // Shared: preserve enrichment from cachedCerts into fresh certs (prevents badge flicker)
    function preserveCachedEnrichment(certs) {
      if (cachedCerts.length === 0) return;
      const prev = {};
      for (const c of cachedCerts) { if (c.id) prev[c.id] = c; }
      for (const c of certs) {
        const p = c.id ? prev[c.id] : null;
        if (!p) continue;
        if (p.hasRfc3161 && !c.hasRfc3161) c.hasRfc3161 = true;
        if (p.hasC2pa && !c.hasC2pa) c.hasC2pa = true;
        if (p.rfc3161Token && !c.rfc3161Token) c.rfc3161Token = p.rfc3161Token;
        if (p.c2paManifest && !c.c2paManifest) c.c2paManifest = p.c2paManifest;
        if (p.contentHash && !c.contentHash) c.contentHash = p.contentHash;
        if (p.exifHash && !c.exifHash) c.exifHash = p.exifHash;
        if (p.storageType && !c.storageType) c.storageType = p.storageType;
        if (p.encrypted && !c.encrypted) c.encrypted = true;
        if (p.watermarked && !c.watermarked) c.watermarked = true;
        if (p.license && !c.license) c.license = p.license;
        if (p._recoveryAttemptedAt && !c._recoveryAttemptedAt) c._recoveryAttemptedAt = p._recoveryAttemptedAt;
        if (p._recoveryFailed && !c._recoveryFailed) c._recoveryFailed = p._recoveryFailed;
      }
    }
    
    // Background cert polling — starts on app load, polls every 60s
    function startCertBackgroundSync() {
      if (certPollInterval) return;
      // Initial sync after 5s
      setTimeout(loadCertificatesBackground, 5000);
      certPollInterval = setInterval(loadCertificatesBackground, 300000);
      console.log('[Certs] Background sync started');
    }
    
    async function loadCertificatesBackground() {
      if (!nftWalletAddress || _certSyncRunning) return;
      _certSyncRunning = true;
      try {
        const result = await ipcRenderer.invoke('get-certificates');
        let certs = (result && result.certificates) ? result.certificates : [];
        certs = await filterCertsByOwnership(certs);
        preserveCachedEnrichment(certs);
        // Enrich from blockchain NFT data if allNFTs available
        try { var _bgNfts = allNFTs; } catch(_) { var _bgNfts = []; }
        const nftMap = await buildNFTMap(_bgNfts);
        try { await enrichCertsWithNFTData(certs, nftMap, 'BG'); } catch (e) { console.log('[Certs] BG enrich error:', e.message); }
        cachedCerts = certs.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
      } catch (e) {
        console.log('[Certs] Background sync error:', e.message);
      }
      _certSyncRunning = false;
    }
    
    // Start background cert sync immediately
    startCertBackgroundSync();
    
    function openCertificates() {
      const overlay = document.getElementById('certs-overlay');
      if (overlay) overlay.classList.add('active');
      loadCertificates();
    }
    
    function closeCertificates() {
      const overlay = document.getElementById('certs-overlay');
      if (overlay) overlay.classList.remove('active');
    }
    window.openCertificates = openCertificates;
    window.closeCertificates = closeCertificates;
    
    async function loadCertificates() {
      const listEl = document.getElementById('certs-list');
      const loadingEl = document.getElementById('certs-loading');
      const emptyEl = document.getElementById('certs-empty');
      if (!listEl) return;
      
      // If no wallet connected, show connect prompt
      if (!nftWalletAddress) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'none';
        listEl.innerHTML = '<div style="text-align:center;padding:40px;color:#888;">' +
          '<div style="font-size:32px;margin-bottom:8px;">🔗</div>' +
          '<div style="font-weight:600;color:#fff;margin-bottom:4px;">Connect Credentials</div>' +
          '<div style="font-size:12px;margin-bottom:16px;">Connect your credentials to scan for certificates</div>' +
          '<button onclick="connectNFTWallet()" style="padding:10px 20px;border-radius:8px;border:1px solid #f59e0b;background:transparent;color:#f59e0b;cursor:pointer;font-size:13px;font-weight:600;">Connect</button>' +
          '</div>';
        return;
      }
      
      // Show cached data instantly if available
      if (cachedCerts.length > 0) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'none';
        renderCertsList(listEl);
      } else {
        listEl.innerHTML = '';
        if (loadingEl) loadingEl.style.display = 'block';
        if (emptyEl) emptyEl.style.display = 'none';
      }
      
      // Concurrency lock — skip if bg sync is already running
      if (_certSyncRunning) {
        // Just render cached data and exit — bg sync will update it
        if (loadingEl) loadingEl.style.display = 'none';
        if (cachedCerts.length > 0) renderCertsList(listEl);
        return;
      }
      _certSyncRunning = true;
      
      try {
      // 1. Fetch server-stored + local certs (merged)
      let serverCerts = [];
      try {
        const result = await ipcRenderer.invoke('get-certificates');
        serverCerts = (result && result.certificates) ? result.certificates : [];
      } catch (e) {
        console.log('[Certs] Server fetch error:', e.message);
      }
      console.log('[Certs] Fetched', serverCerts.length, 'certs from server+local');
      // Push local certs to server so other devices can see them
      try { await ipcRenderer.invoke('backup-certificates'); } catch (_) {}

      // Filter by ownership using shared function
      serverCerts = await filterCertsByOwnership(serverCerts);
      preserveCachedEnrichment(serverCerts);

      // Fetch on-chain NFTs for enrichment + auto-generation
      let ownedNFTs = [];
      try {
        const ownedResult = await fetchUserNFTsCached();
        if (ownedResult && ownedResult.success && Array.isArray(ownedResult.nfts)) {
          ownedNFTs = ownedResult.nfts;
        }
      } catch (e) {
        console.log('[Certs] NFT fetch skipped:', e.message);
      }

      // Build NFT map and enrich using shared functions
      const nftMap = await buildNFTMap(ownedNFTs);
      try { await enrichCertsWithNFTData(serverCerts, nftMap, 'FG'); } catch (e) { console.log('[Certs] FG enrich error:', e.message); }

      // Auto-generate certificates for ecosystem NFTs that don't have one yet
      // Only PhotoLynk-created NFTs get proofs — external NFTs are skipped
      // (matches mobile discoverAndImportNFTs auto-cert generation)
      if (Object.keys(nftMap).length > 0) {
        try {
          const certMints = new Set(serverCerts.map(c => (c.mintAddress || '').replace(/^cnft_/, '')));
          let autoGenerated = 0;
          for (const [mint, nft] of Object.entries(nftMap)) {
            if (!certMints.has(mint)) {
              try {
                const genResult = await ipcRenderer.invoke('generate-certificate', nft);
                if (genResult && genResult.success && genResult.certificate) {
                  serverCerts.push(genResult.certificate);
                  certMints.add(mint);
                  autoGenerated++;
                }
              } catch (genErr) {
                console.log('[Certs] Auto-gen failed for', mint, ':', genErr.message);
              }
            }
          }
          if (autoGenerated > 0) console.log('[Certs] Auto-generated', autoGenerated, 'certificates');
        } catch (e) {
          console.log('[Certs] Auto-generation sweep error:', e.message);
        }
      }
      
      cachedCerts = serverCerts.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
      // Persist enriched certs locally so rfc3161Token/c2paManifest survive restarts
      try { await ipcRenderer.invoke('save-enriched-certs', cachedCerts); } catch (_) {}
      } catch (e) {
        console.log('[Certs] loadCertificates error:', e.message);
      }
      _certSyncRunning = false;
      
      if (loadingEl) loadingEl.style.display = 'none';
      
      if (cachedCerts.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      
      if (emptyEl) emptyEl.style.display = 'none';
      renderCertsList(listEl);
    }
    
    function renderCertsList(listEl) {
      listEl.innerHTML = '';
      
      for (const cert of cachedCerts) {
        const card = document.createElement('div');
        card.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:12px;cursor:pointer;';
        card.onmouseenter = () => card.style.borderColor = '#f59e0b';
        card.onmouseleave = () => card.style.borderColor = '#333';
        
        const dateStr = cert.issuedAt ? new Date(cert.issuedAt).toLocaleString('en', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'N/A';
        const _isPrivate = isPrivateNFTClassification(cert);
        const _isPublic = isPublicNFTClassification(cert);
        const tags = [_isPublic
          ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.3);border-radius:4px;color:#10b981;">🌍 Public Certified</span>'
          : '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(139,92,246,0.3);border-radius:4px;color:#8b5cf6;">🔐 Private Certified</span>'];
        if (cert.encrypted) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(139,92,246,0.3);border-radius:4px;color:#8b5cf6;">🔒 Encrypted</span>');
        if (cert.watermarked) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.3);border-radius:4px;color:#10b981;">✓ Watermarked</span>');
        if (cert.rfc3161Token || cert.hasRfc3161) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.4);border-radius:4px;color:#10b981;background:rgba(16,185,129,0.08);">✔ Timestamp (RFC 3161)</span>');
        if (cert.c2paManifest || cert.hasC2pa) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.4);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.08);">✔ Authenticity (C2PA)</span>');
        if (cert.contentHash) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.3);border-radius:4px;color:#10b981;background:rgba(16,185,129,0.06);">✔ Cryptographic Hash</span>');
        tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.3);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.06);">✔ Immutable Anchor</span>');
        if (cert.license) tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(245,158,11,0.3);border-radius:4px;color:#f59e0b;">' + (cert.license === 'arr' ? 'All Rights Reserved' : cert.license) + '</span>');
        const storageLabel = cert.storageType === 'onchain' ? 'Embedded SVG' : cert.storageType === 'cloud' ? 'StealthCloud' : 'IPFS';
        tags.push('<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(107,114,128,0.3);border-radius:4px;color:#9ca3af;background:rgba(107,114,128,0.06);">' + storageLabel + '</span>');
        
        card.innerHTML = \`
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="width:32px;height:32px;border-radius:8px;background:rgba(245,158,11,0.15);display:flex;align-items:center;justify-content:center;font-size:16px;">🏆</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${cert.name || 'Untitled'}</div>
              <div style="font-size:10px;color:#888;">\${dateStr}</div>
            </div>
          </div>
          <div style="font-size:9px;color:#6b7280;margin-bottom:6px;">SHA-256 anchored · Immutable · Timestamped</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">\${tags.join('')}</div>
          \${cert.mintAddress ? '<div style="font-size:9px;color:#666;font-family:monospace;">' + cert.mintAddress.slice(0,20) + '...' + cert.mintAddress.slice(-8) + '</div>' : ''}
        \`;
        card.onclick = () => showCertDetail(cert);
        listEl.appendChild(card);
      }
    }
    
    function showCertDetail(cert) {
      const listEl = document.getElementById('certs-list');
      if (!listEl) return;
      window._rfcCertData = cert;
      const dateStr = cert.issuedAt ? new Date(cert.issuedAt).toLocaleString('en', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'N/A';
      
      listEl.innerHTML = \`
        <div style="margin-bottom:12px;">
          <button onclick="loadCertificates()" style="background:transparent;border:1px solid #333;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">← Back</button>
        </div>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:16px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            <span style="font-size:28px;">🏆</span>
            <span style="font-size:15px;font-weight:700;color:#f59e0b;">Certificate of Authenticity</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
            <span style="font-size:10px;padding:2px 6px;border:1px solid rgba(99,102,241,0.3);border-radius:4px;color:#818cf8;">\${isPublicNFTClassification(cert) ? '🌍 Public' : '🔐 Private'}</span>
            \${cert.encrypted ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(153,69,255,0.3);border-radius:4px;color:#9945FF;">🔒 Encrypted</span>' : ''}
            \${cert.watermarked ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(34,197,94,0.3);border-radius:4px;color:#22c55e;">Watermarked</span>' : ''}
            \${(cert.rfc3161Token || cert.hasRfc3161) ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.4);border-radius:4px;color:#10b981;background:rgba(16,185,129,0.08);">⏱ RFC 3161</span>' : ''}
            \${(cert.c2paManifest || cert.hasC2pa) ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.4);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.08);">C2PA</span>' : ''}
            \${cert.storageType === 'onchain' ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(245,158,11,0.3);border-radius:4px;color:#f59e0b;background:rgba(245,158,11,0.08);">Embedded</span>' : ''}
            \${cert.storageType === 'cloud' ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.3);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.08);">Encrypted Cloud</span>' : ''}
          </div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Certification</span><span style="color:#fff;font-size:12px;">\${isPublicNFTClassification(cert) ? 'Public Certified' : 'Private Certified'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">License</span><span style="color:#fff;font-size:12px;">\${({'arr':'All Rights Reserved','cc-by':'CC BY 4.0','cc-by-sa':'CC BY-SA 4.0','cc-by-nc':'CC BY-NC 4.0','cc-by-nc-sa':'CC BY-NC-SA 4.0','cc-by-nd':'CC BY-ND 4.0','cc-by-nc-nd':'CC BY-NC-ND 4.0','cc0':'CC0 1.0 (Public Domain)','commercial':'Commercial License'})[cert.license] || cert.license || 'All Rights Reserved'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Issued</span><span style="color:#fff;font-size:12px;">\${dateStr}</span></div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">AUTHENTICITY PROOF</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Record ID</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${cert.mintAddress || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">TX</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${cert.txSignature || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Certified By</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${cert.creatorWallet || 'N/A'}</span></div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Integrity</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Content Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${cert.contentHash || 'N/A'}">\${cert.contentHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Raw EXIF Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${cert.exifRawHash || 'N/A'}">\${cert.exifRawHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">EXIF Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${cert.exifHash || 'N/A'}">\${cert.exifHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Binding Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${cert.exifBindingHash || 'N/A'}">\${cert.exifBindingHash || 'N/A'}</span></div>
          <div style="padding:8px;margin:8px 0;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:8px;">
            <div style="font-size:9px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">How to Verify</div>
            <div style="font-size:9px;color:#aaa;line-height:1.5;">
              <div style="margin-bottom:4px;"><span style="color:#ccc;font-weight:600;">Content Hash</span> — run <span style="color:#f59e0b;font-family:monospace;">sha256sum &lt;file&gt;</span></div>
              <div id="cert-cmd-sha256" onclick="window.copyCertCommand('sha256')" style="cursor:pointer;display:flex;align-items:flex-start;gap:6px;font-family:monospace;font-size:8px;color:#888;background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:4px;margin:4px 0;border:1px solid rgba(245,158,11,0.2);"><span style="flex:1;">sha256sum &lt;file&gt;</span><span style="color:#f59e0b;font-size:7px;white-space:nowrap;">📋 copy</span></div>
              <div style="margin-bottom:4px;"><span style="color:#ccc;font-weight:600;">EXIF Hash</span> — SHA-256 of normalized EXIF fields (decimals rounded to 4dp, GPS truncated to 4dp). Verify with:</div>
              <div id="cert-cmd-exif" onclick="window.copyCertCommand('exif')" style="cursor:pointer;display:flex;align-items:flex-start;gap:6px;font-family:monospace;font-size:8px;color:#888;background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:4px;margin:4px 0;border:1px solid rgba(245,158,11,0.2);white-space:pre-wrap;word-break:break-all;"><span style="flex:1;">npm install exifreader &amp;&amp; node verify-exif-hash.js &lt;file&gt;</span><span style="color:#f59e0b;font-size:7px;white-space:nowrap;">📋 copy</span></div>
              <div style="margin-top:4px;color:#666;font-size:8px;">Script: <a href="https://github.com/viktorvishyn369/PhotoLynk/blob/main/server-tray/verify-exif-hash.js" style="color:#f59e0b;" target="_blank">verify-exif-hash.js</a> — uses the same ExifReader + normalization as the app.</div>
            </div>
          </div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Details</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Watermarked</span><span style="color:#fff;font-size:12px;">\${cert.watermarked ? 'Yes' : 'No'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Encrypted</span><span style="color:#fff;font-size:12px;">\${cert.encrypted ? 'Yes' : 'No'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Storage</span><span style="color:#fff;font-size:12px;">\${cert.storageType === 'cloud' ? 'Encrypted Cloud' : cert.storageType === 'arweave' ? 'Arweave (Permanent)' : cert.storageType === 'onchain' ? 'Embedded' : 'Decentralized'}</span></div>
          \${(cert.rfc3161Token || cert.hasRfc3161) ? \`
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">⏱ RFC 3161 Trusted Timestamp</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Authority</span><span style="color:#10b981;font-size:11px;">FreeTSA.org</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Standard</span><span style="color:#10b981;font-size:11px;">RFC 3161 / IETF</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Hash Algorithm</span><span style="color:#10b981;font-size:11px;">SHA-256</span></div>
          <div style="padding:10px;margin:8px 0;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);border-radius:8px;overflow:hidden;">
            <div style="font-size:10px;font-weight:700;color:#10b981;margin-bottom:8px;">Verify RFC 3161 Timestamp</div>
            <div style="font-size:9px;color:#6b7280;margin-bottom:6px;">macOS / Linux (Terminal):</div>
            <div style="margin-bottom:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
                <span style="font-size:9px;font-weight:700;color:#10b981;">1. Save token to file</span>
                <span id="rfc-mac-toggle" onclick="window.toggleRfcExpand('mac')" style="cursor:pointer;font-size:9px;color:#10b981;background:rgba(16,185,129,0.12);padding:2px 6px;border-radius:4px;">👁 Show</span>
              </div>
              <div id="rfc-mac-step1" onclick="window.copyRfcCmd('mac1')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span id="rfc-mac-step1-text" style="font-size:9px;color:#6b7280;font-family:monospace;flex:1;font-style:italic;">(token hidden — click Show to preview, click row to copy)</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;font-weight:700;color:#10b981;margin-bottom:2px;">2. Download CA cert</div>
              <div id="rfc-mac-step2" onclick="window.copyRfcCmd('mac2')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">curl -o cacert.pem https://freetsa.org/files/cacert.pem</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;font-weight:700;color:#10b981;margin-bottom:2px;">3. Verify timestamp</div>
              <div id="rfc-mac-step3" onclick="window.copyRfcCmd('mac3')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">openssl ts -verify -in token.tsr -digest \${(cert.contentHash || '').replace('SHA256:','') || '&lt;sha256_hash&gt;'} -CAfile cacert.pem</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="font-size:9px;color:#6b7280;margin-top:6px;margin-bottom:6px;">Windows (PowerShell):</div>
            <div style="margin-bottom:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
                <span style="font-size:9px;font-weight:700;color:#10b981;">1. Save token to file</span>
                <span id="rfc-win-toggle" onclick="window.toggleRfcExpand('win')" style="cursor:pointer;font-size:9px;color:#10b981;background:rgba(16,185,129,0.12);padding:2px 6px;border-radius:4px;">👁 Show</span>
              </div>
              <div id="rfc-win-step1" onclick="window.copyRfcCmd('win1')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span id="rfc-win-step1-text" style="font-size:9px;color:#6b7280;font-family:monospace;flex:1;font-style:italic;">(token hidden — click Show to preview, click row to copy)</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="margin-bottom:8px;">
              <div style="font-size:9px;font-weight:700;color:#10b981;margin-bottom:2px;">2. Download CA cert</div>
              <div id="rfc-win-step2" onclick="window.copyRfcCmd('win2')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">Invoke-WebRequest https://freetsa.org/files/cacert.pem -OutFile cacert.pem</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="margin-bottom:4px;">
              <div style="font-size:9px;font-weight:700;color:#10b981;margin-bottom:2px;">3. Verify timestamp</div>
              <div id="rfc-win-step3" onclick="window.copyRfcCmd('win3')" style="cursor:pointer;background:rgba(0,0,0,0.35);border-radius:6px;padding:7px;display:flex;align-items:flex-start;gap:6px;">
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">openssl ts -verify -in token.tsr -digest \${(cert.contentHash || '').replace('SHA256:','') || '&lt;sha256_hash&gt;'} -CAfile cacert.pem</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="font-size:9px;color:#6b7280;margin-top:4px;">Expected: <span style="color:#10b981;font-weight:600;">Verification: OK</span></div>
          </div>
          \` : ''}
          \${(cert.rfc3161Token || cert.hasRfc3161) && !cert.rfc3161Token ? \`
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px;padding:0 4px;">
            <span style="color:#10b981;font-size:12px;">✓</span>
            <span style="font-size:10px;color:#6b7280;">Full token stored on-chain — verified via metadata</span>
          </div>
          \` : ''}
          \${(cert.c2paManifest || cert.hasC2pa) ? \`
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">C2PA Provenance</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Standard</span><span style="color:#3b82f6;font-size:11px;">C2PA / Coalition for Content Provenance</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Claim Generator</span><span style="color:#3b82f6;font-size:11px;">\${cert.c2paManifest?.claim_generator || 'PhotoLynk/' + (app && typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0').trim()}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Created</span><span style="color:#3b82f6;font-size:11px;">\${cert.c2paManifest?.claim?.created || cert.issuedAt || 'N/A'}</span></div>
          \` : ''}
          \${cert.mintAddress ? \`
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div onclick="window.viewCertNFT('\${cert.mintAddress}')" style="cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(153,69,255,0.15);border-radius:10px;padding:12px;margin-top:8px;">
            <span style="font-size:14px;">🖼️</span>
            <span style="color:#9945FF;font-weight:600;font-size:13px;">View in Collection</span>
          </div>
          \` : ''}
        </div>
      \`;
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
    let nftSearchQuery = '';
    let nftFilter = 'all';
    let nftPageIndex = 0;
    const NFT_PAGE_SIZE = 12; // 3x4 grid
    let nftAutoRefreshInterval = null;
    const NFT_AUTO_REFRESH_MS = 300000; // Check for new NFTs every 5 minutes (matches mobile)

    function isPhotoLynkEcosystemNFT(nft) {
      if (!nft) return false;
      if (nft.merkleTree === '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS') return true;
      if (nft.creatorWallet === 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU') return true;
      const attrs = nft.metadata?.attributes || nft.attributes || [];
      const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
      const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
      if (hasContentHash && hasExifHash) return true;
      const metaCert = nft.metadata?.properties?.certificate;
      if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
      if (nft.name && nft.name.includes('PhotoLynk')) return true;
      return false;
    }

    function isPrivateNFTClassification(nft) {
      return nft?.certificationMode === 'private'
        || (nft?.edition === 'limited' && nft?.certificationMode !== 'public')
        || nft?.encrypted === true;
    }

    function isPublicNFTClassification(nft) {
      return (nft?.certificationMode === 'public' || (nft?.edition === 'open' && !nft?.certificationMode))
        && nft?.encrypted !== true;
    }

    function getNFTEffectiveDateValue(nft) {
      const timestamps = [nft?.createdAt, nft?.mintedAt, nft?.transferredAt, nft?.discoveredAt]
        .filter(Boolean)
        .map(value => new Date(value).getTime())
        .filter(ts => Number.isFinite(ts) && ts > 0);
      return timestamps.length ? Math.max(...timestamps) : 0;
    }

    function getNFTBadgeTags(nft) {
      const tags = [];
      if (isPrivateNFTClassification(nft)) tags.push('private', 'certified');
      else if (isPublicNFTClassification(nft)) tags.push('public', 'certified');
      // Legacy edition tags kept for backward compat search
      if (nft.edition === 'limited') tags.push('limited', 'limited edition');
      else if (nft.edition === 'open') tags.push('open', 'open edition');
      // Compressed vs standard
      const compressed = nft.isCompressed === true || (nft.mintAddress || '').startsWith('cnft_');
      if (compressed) { tags.push('compressed', 'cnft'); } else { tags.push('standard'); }
      // Encrypted
      if (nft.encrypted) tags.push('encrypted');
      if (nft.watermarked) tags.push('watermarked');
      // Certified — check cachedCerts
      const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
      const mint = normMint(nft.mintAddress);
      if (mint && cachedCerts.some(c => normMint(c.mintAddress) === mint)) tags.push('certified');
      // Storage type
      const rawImg = (nft.imageUrl || nft.image || '');
      const st = nft.storageType || (rawImg.startsWith('data:') ? 'onchain' : (rawImg.includes('stealthlynk.io') || rawImg.includes('stealthcloud')) ? 'cloud' : (rawImg.includes('akrd.net') || rawImg.includes('arweave.net')) ? 'arweave' : 'ipfs');
      tags.push(st);
      if (st === 'onchain') tags.push('on-chain');
      return tags.join(' ');
    }

    function getFilteredNFTs() {
      let result = allNFTs;
      if (nftFilter === 'private') {
        result = result.filter(nft => isPhotoLynkEcosystemNFT(nft) && isPrivateNFTClassification(nft));
      } else if (nftFilter === 'public') {
        result = result.filter(nft => isPhotoLynkEcosystemNFT(nft) && isPublicNFTClassification(nft));
      }
      if (!nftSearchQuery.trim()) return result;
      const q = nftSearchQuery.toLowerCase();
      return result.filter(nft =>
        (nft.name || '').toLowerCase().includes(q) ||
        (nft.description || '').toLowerCase().includes(q) ||
        getNFTBadgeTags(nft).includes(q)
      );
    }

    function updateNFTResultsSummary() {
      const resultsEl = document.getElementById('nft-search-results');
      if (!resultsEl) return;
      if (nftSearchQuery.trim()) {
        const filtered = getFilteredNFTs();
        resultsEl.textContent = filtered.length + ' result' + (filtered.length !== 1 ? 's' : '') + ' found';
        resultsEl.style.display = 'block';
      } else {
        resultsEl.style.display = 'none';
      }
    }

    function syncNFTFilterButtons() {
      const allBtn = document.getElementById('nft-filter-all');
      const publicBtn = document.getElementById('nft-filter-public');
      const privateBtn = document.getElementById('nft-filter-private');
      if (allBtn) allBtn.className = 'nft-filter-btn' + (nftFilter === 'all' ? ' active-all' : '');
      if (publicBtn) publicBtn.className = 'nft-filter-btn' + (nftFilter === 'public' ? ' active-public' : '');
      if (privateBtn) privateBtn.className = 'nft-filter-btn' + (nftFilter === 'private' ? ' active-private' : '');
    }

    function setNFTFilter(nextFilter) {
      nftFilter = nextFilter;
      nftPageIndex = 0;
      syncNFTFilterButtons();
      updateNFTResultsSummary();
      renderNFTPage();
    }

    function onNFTSearchInput(value) {
      nftSearchQuery = value;
      nftPageIndex = 0;
      const clearBtn = document.getElementById('nft-search-clear');
      if (clearBtn) clearBtn.style.display = value.length > 0 ? 'block' : 'none';
      updateNFTResultsSummary();
      renderNFTPage();
    }
    window.onNFTSearchInput = onNFTSearchInput;

    function clearNFTSearch() {
      nftSearchQuery = '';
      nftPageIndex = 0;
      const input = document.getElementById('nft-search-input');
      const clearBtn = document.getElementById('nft-search-clear');
      if (input) input.value = '';
      if (clearBtn) clearBtn.style.display = 'none';
      updateNFTResultsSummary();
      renderNFTPage();
    }
    window.clearNFTSearch = clearNFTSearch;
    window.setNFTFilter = setNFTFilter;

    function normalizeNFTId(id) {
      if (!id) return id;
      // Strip cnft_ prefix for comparison so cnft_XYZ and XYZ are treated as same NFT
      return String(id).startsWith('cnft_') ? String(id).slice(5) : String(id);
    }

    // Check if an NFT belongs to the currently connected wallet.
    // NFTs without ownerAddress are kept (legacy data / safe default).
    function nftBelongsToCurrentWallet(nft) {
      if (!nftWalletAddress) return true; // no wallet connected — show all
      if (!nft || !nft.ownerAddress) return true; // no owner info — keep it
      return nft.ownerAddress === nftWalletAddress;
    }

    function appendNewNFTs(fetchedNFTs) {
      if (!Array.isArray(fetchedNFTs) || fetchedNFTs.length === 0) return 0;
      const existingMap = {};
      const existingMetaMap = {};
      allNFTs.forEach((n, i) => {
        const id = n && normalizeNFTId(n.mintAddress || n.assetId);
        if (id) existingMap[id] = i;
        if (n && n.metadataUrl) existingMetaMap[n.metadataUrl] = i;
      });
      let added = 0;
      for (const nft of fetchedNFTs) {
        if (!nftBelongsToCurrentWallet(nft)) continue; // skip NFTs from other wallets
        const id = nft && normalizeNFTId(nft.mintAddress || nft.assetId);
        if (!id) continue;
        if (id in existingMap) {
          // Update existing entry with any newly available fields (encryptionData, thumbnailUrl, etc.)
          const existing = allNFTs[existingMap[id]];
          if (nft.encryptionData && !existing.encryptionData) existing.encryptionData = nft.encryptionData;
          if (nft.thumbnailUrl && !existing.thumbnailUrl) existing.thumbnailUrl = nft.thumbnailUrl;
          if (nft.edition && !existing.edition) existing.edition = nft.edition;
          if (nft.encrypted && !existing.encrypted) existing.encrypted = nft.encrypted;
          if (nft.watermarked && !existing.watermarked) existing.watermarked = nft.watermarked;
          if (nft.license && !existing.license) existing.license = nft.license;
          if (nft.storageType && (!existing.storageType || existing.storageType === 'ipfs')) existing.storageType = nft.storageType;
          if (nft.createdAt && !existing.createdAt) existing.createdAt = nft.createdAt;
          if (nft.encrypted && nft.imageUrl && !existing.encryptionData?.wrappedKey) {
            // Don't overwrite imageUrl if existing already has encryption keys
          } else if (nft.encrypted && nft.imageUrl) {
            existing.imageUrl = nft.imageUrl;
            if (!existing.cachedPath) existing.image = nft.imageUrl;
          }
          continue;
        }
        // Dedup by metadataUrl: if a tx_ temp entry exists with same metadataUrl, replace it
        const mintStr = String(nft.mintAddress || '');
        if (nft.metadataUrl && !mintStr.startsWith('tx_') && existingMetaMap[nft.metadataUrl] !== undefined) {
          const oldIdx = existingMetaMap[nft.metadataUrl];
          const old = allNFTs[oldIdx];
          if (old && String(old.mintAddress || '').startsWith('tx_')) {
            // Merge encryptionData from temp entry into real entry, then replace
            if (old.encryptionData && !nft.encryptionData) nft.encryptionData = old.encryptionData;
            if (old.thumbnailUrl && !nft.thumbnailUrl) nft.thumbnailUrl = old.thumbnailUrl;
            if (old.edition && !nft.edition) nft.edition = old.edition;
            if (old.encrypted && !nft.encrypted) nft.encrypted = old.encrypted;
            if (old.watermarked && !nft.watermarked) nft.watermarked = old.watermarked;
            if (old.license && !nft.license) nft.license = old.license;
            if (old.imageUrl && !nft.imageUrl) nft.imageUrl = old.imageUrl;
            if (old.createdAt && !nft.createdAt) nft.createdAt = old.createdAt;
            allNFTs[oldIdx] = nft;
            existingMap[id] = oldIdx;
            existingMetaMap[nft.metadataUrl] = oldIdx;
            console.log('[NFT Album] Replaced temp tx_ entry with real cnft_ for:', nft.name);
            continue;
          }
        }
        existingMap[id] = allNFTs.length;
        if (nft.metadataUrl) existingMetaMap[nft.metadataUrl] = allNFTs.length;
        allNFTs.push(nft);
        added++;
      }
      return added;
    }

    async function checkForNewNFTsOnce() {
      if (!nftWalletAddress) return 0;
      try {
        const result = await fetchUserNFTsCached();
        if (result && result.success && result.nfts) {
          // Merge local storage data into DAS results before appending
          // (DAS doesn't have encryptionData, thumbnailUrl, original imageUrl for encrypted NFTs)
          try {
            const localStoredNFTs = await ipcRenderer.invoke('get-stored-nfts') || [];
            if (localStoredNFTs.length > 0) {
              const storedMap = {};
              const storedByMeta = {};
              localStoredNFTs.forEach(s => {
                if (s.mintAddress) storedMap[normalizeNFTId(s.mintAddress)] = s;
                if (s.metadataUrl) storedByMeta[s.metadataUrl] = s;
              });
              result.nfts.forEach(nft => {
                const nid = normalizeNFTId(nft.mintAddress);
                const stored = storedMap[nid] || (nft.metadataUrl && storedByMeta[nft.metadataUrl]) || null;
                if (stored) {
                  if (stored.encryptionData) nft.encryptionData = stored.encryptionData;
                  if (stored.thumbnailUrl) nft.thumbnailUrl = stored.thumbnailUrl;
                  if (stored.edition && !nft.edition) nft.edition = stored.edition;
                  if (stored.encrypted && !nft.encrypted) nft.encrypted = stored.encrypted;
                  if (stored.watermarked && !nft.watermarked) nft.watermarked = stored.watermarked;
                  if (stored.license && !nft.license) nft.license = stored.license;
                  if (stored.storageType && (!nft.storageType || nft.storageType === 'ipfs' || nft.storageType === 'unknown')) nft.storageType = stored.storageType;
                  if (stored.encrypted && stored.imageUrl) {
                    nft.imageUrl = stored.imageUrl;
                    if (!nft.cachedPath) nft.image = stored.imageUrl;
                  }
                }
              });
            }
          } catch (_mergeErr) {
            console.log('[NFT Album] Auto-refresh merge skipped:', _mergeErr.message);
          }
          const oldCount = allNFTs.length;
          const added = appendNewNFTs(result.nfts);
          if (added > 0) {
            if (oldCount === 0) {
              renderNFTPage();
            } else {
              updateNFTNavigation();
            }
          }
          return added;
        }
      } catch (e) {
        console.log('[NFT Album] Auto-refresh error:', e.message);
      }
      return 0;
    }
    
    // Start auto-refresh when album is open
    function startNFTAutoRefresh() {
      if (nftAutoRefreshInterval) return;
      nftAutoRefreshInterval = setInterval(async () => {
        console.log('[NFT Album] Auto-checking for new NFTs...');
        const added = await checkForNewNFTsOnce();
        if (added > 0) {
          console.log('[NFT Album] Found', added, 'new NFT(s)!');
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

        if (!nftWalletAddress) {
          grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#888;">' +
            '<div style="font-size:32px;margin-bottom:8px;">🖼️</div>' +
            '<div style="font-weight:600;color:#fff;margin-bottom:4px;">Connect Credentials</div>' +
            '<div style="font-size:12px;margin-bottom:16px;">Connect your credentials to view your certified originals</div>' +
            '<button onclick="connectNFTWallet()" style="padding:10px 20px;border-radius:8px;border:1px solid #9945FF;background:transparent;color:#9945FF;cursor:pointer;font-size:13px;font-weight:600;">Connect</button>' +
            '</div>';
          loading.style.display = 'none';
          empty.style.display = 'none';
          return;
        }

        // Show persisted local NFTs instantly (survives app restart/update)
        if (allNFTs.length === 0) {
          try {
            const persistedNFTs = (await ipcRenderer.invoke('get-stored-nfts') || []).filter(nftBelongsToCurrentWallet);
            if (persistedNFTs.length > 0) {
              allNFTs = persistedNFTs;
              loading.style.display = 'none';
              empty.style.display = 'none';
              renderNFTPage();
            }
          } catch (persistErr) {
            console.log('[NFT Album] Persisted load skipped:', persistErr.message);
          }
        }

        // Only show loader if we truly have nothing to show
        if (allNFTs.length === 0) {
          grid.innerHTML = '';
          loading.style.display = 'flex';
          empty.style.display = 'none';
        }

        // Fetch DAS NFTs + sync from server in parallel (not sequential)
        const [result] = await Promise.all([
          fetchUserNFTsCached(),
          ipcRenderer.invoke('sync-nfts-from-server').catch(syncErr => {
            console.log('[NFT Album] Server sync skipped:', syncErr.message);
          }),
        ]);
        loading.style.display = 'none';
        
        // Merge local storage data (has encryptionData, edition, etc. from minting)
        // Also APPEND any server/local NFTs that DAS didn't return (mobile may have discovered them via RPC)
        try {
          const localStoredNFTs = await ipcRenderer.invoke('get-stored-nfts') || [];
          if (localStoredNFTs.length > 0 && result && result.nfts) {
            const storedMap = {};
            const storedByMeta = {};
            localStoredNFTs.forEach(s => {
              if (s.mintAddress) storedMap[normalizeNFTId(s.mintAddress)] = s;
              if (s.metadataUrl) storedByMeta[s.metadataUrl] = s;
            });
            const dasIdSet = new Set();
            const dasMetaSet = new Set();
            result.nfts.forEach(nft => {
              const nid = normalizeNFTId(nft.mintAddress);
              dasIdSet.add(nid);
              if (nft.metadataUrl) dasMetaSet.add(nft.metadataUrl);
              // Match by mintAddress first, then by metadataUrl (cNFT assetId may differ from stored tx-based id)
              const stored = storedMap[nid] || (nft.metadataUrl && storedByMeta[nft.metadataUrl]) || null;
              if (stored) {
                // Merge local fields that DAS doesn't have
                if (stored.encryptionData) nft.encryptionData = stored.encryptionData;
                if (stored.thumbnailUrl) nft.thumbnailUrl = stored.thumbnailUrl;
                if (stored.edition && !nft.edition) nft.edition = stored.edition;
                if (stored.encrypted && !nft.encrypted) nft.encrypted = stored.encrypted;
                if (stored.watermarked && !nft.watermarked) nft.watermarked = stored.watermarked;
                if (stored.license && !nft.license) nft.license = stored.license;
                if (stored.storageType && (!nft.storageType || nft.storageType === 'ipfs')) nft.storageType = stored.storageType;
                if (stored.createdAt && !nft.createdAt) nft.createdAt = stored.createdAt;
                // For encrypted NFTs: DAS imageUrl is a proxied URL that can't be decrypted.
                // Use the original upload URL from local storage (Pinata/StealthCloud) instead.
                if (stored.encrypted && stored.imageUrl) {
                  nft.imageUrl = stored.imageUrl;
                  // Also update nft.image so grid uses the correct URL for decrypt
                  if (!nft.cachedPath) nft.image = stored.imageUrl;
                }
              }
            });
            // Append NFTs from server/local that DAS missed (skip tx_ entries if real cnft_ exists by metadataUrl)
            let appended = 0;
            localStoredNFTs.forEach(s => {
              if (!nftBelongsToCurrentWallet(s)) return; // skip NFTs from other wallets
              if (s.mintAddress && !dasIdSet.has(normalizeNFTId(s.mintAddress))) {
                // Skip tx_ temp entries if DAS already has the real cnft_ with same metadataUrl
                if (String(s.mintAddress).startsWith('tx_') && s.metadataUrl && dasMetaSet.has(s.metadataUrl)) return;
                result.nfts.push(s);
                dasIdSet.add(normalizeNFTId(s.mintAddress));
                appended++;
              }
            });
            if (appended > 0) console.log('[NFT Album] Appended', appended, 'NFTs from server/local that DAS missed');
          }
        } catch (mergeErr) {
          console.log('[NFT Album] Local merge skipped:', mergeErr.message);
        }
        
        // Persist full merged NFT list so album loads instantly next time
        if (result && result.nfts && result.nfts.length > 0) {
          try { await ipcRenderer.invoke('bulk-save-nfts', result.nfts); } catch (_) {}
        }

        if (result && result.success && result.nfts && result.nfts.length > 0) {
          if (allNFTs.length === 0) {
            allNFTs = result.nfts;
            console.log('[NFT Album] Total NFTs:', allNFTs.length);
            renderNFTPage();
          } else {
            const added = appendNewNFTs(result.nfts);
            if (added > 0) {
              console.log('[NFT Album] Appended', added, 'new NFT(s). Total:', allNFTs.length);
              updateNFTNavigation();
            }
          }
          // Start auto-refresh to detect new NFTs
          startNFTAutoRefresh();
        } else {
          if (allNFTs.length === 0) {
            empty.innerHTML = '<span>No originals yet. Certify your first photo!</span>';
            empty.style.display = 'flex';
          }
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
      const nftName = nft.name || 'Original #' + (nftIndex + 1);
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
      
      // Set image (encrypted NFTs need decryption, limited edition shows certificate)
      const imgEl = document.getElementById('nft-detail-img');
      const imageContainer = document.getElementById('nft-detail-image');
      // Clear any previous decrypt status overlays
      const prevStatus = document.getElementById('nft-decrypt-status');
      if (prevStatus) prevStatus.remove();
      const prevCert = document.getElementById('nft-cert-placeholder');
      if (prevCert) prevCert.remove();

      let imageUrl = nft.cachedPath ? 'file://' + nft.cachedPath : (nft.image || nft.imageUrl || '');
      if (imageUrl && imageUrl.startsWith('ipfs://')) imageUrl = 'https://ipfs.io/ipfs/' + imageUrl.slice(7);
      console.log('[NFT Detail] encrypted:', nft.encrypted, 'encryptionData:', JSON.stringify(nft.encryptionData), 'imageUrl:', (nft.imageUrl || nft.image || '').slice(0, 80));

      // Reset container styles from any previous detail view
      imageContainer.style.aspectRatio = '';
      imageContainer.style.minHeight = '';
      imageContainer.style.maxHeight = '';
      imageContainer.style.background = '';

      if (nft.encrypted && nft.encryptionData) {
        // Has real encryption keys — decrypt (check cache first)
        const detailCacheKey = nft.thumbnailUrl || nft.imageUrl || nft.image || nft.mintAddress;
        if (detailCacheKey && _decryptCache[detailCacheKey]) {
          imgEl.src = _decryptCache[detailCacheKey];
          imgEl.style.opacity = '1';
        } else {
        imgEl.src = '';
        imgEl.style.opacity = '0.3';
        imgEl.alt = '🔒 Decrypting...';
        imageContainer.insertAdjacentHTML('beforeend', '<div id="nft-decrypt-status" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#9945FF;font-size:13px;font-weight:600;">🔒 Decrypting...</div>');
        (async () => {
          try {
            const result = await ipcRenderer.invoke('decrypt-nft-image', { imageUrl: nft.imageUrl || nft.image, thumbnailUrl: nft.thumbnailUrl || null, encryptionData: nft.encryptionData });
            const statusEl = document.getElementById('nft-decrypt-status');
            if (result && result.success && result.dataUrl) {
              imgEl.src = result.dataUrl;
              imgEl.style.opacity = '1';
              if (statusEl) statusEl.remove();
              // Cache the result
              if (detailCacheKey) _decryptCache[detailCacheKey] = result.dataUrl;
            } else {
              const errMsg = result?.error || 'Decryption failed';
              const friendly = errMsg.includes('403') || errMsg.includes('429') ? '🔒 Image temporarily unavailable — try again later'
                : errMsg.includes('On-chain encrypted') ? '🔒 On-chain encrypted — no thumbnail stored'
                : '🔒 ' + errMsg;
              if (statusEl) statusEl.textContent = friendly;
            }
          } catch (e) {
            const statusEl = document.getElementById('nft-decrypt-status');
            if (statusEl) statusEl.textContent = '🔒 Decryption error — try again later';
          }
        })();
        }
      } else {
        const detailCid = extractIPFSCid(imageUrl);
        if (detailCid) {
          // Fetch IPFS image via IPC (Node.js follows redirects, no browser rate-limit)
          imgEl.src = '';
          imgEl.style.opacity = '0.3';
          if (_ipfsCache[detailCid]) {
            imgEl.src = _ipfsCache[detailCid];
            imgEl.style.opacity = '1';
          } else {
            (async () => {
              try {
                const result = await ipcRenderer.invoke('fetch-ipfs-image', { cid: detailCid });
                if (result && result.success && result.dataUrl) {
                  _ipfsCache[detailCid] = result.dataUrl;
                  imgEl.src = result.dataUrl;
                  imgEl.style.opacity = '1';
                } else {
                  imgEl.style.opacity = '0.3';
                }
              } catch (e) {
                imgEl.style.opacity = '0.3';
              }
            })();
          }
        } else {
          imgEl.src = imageUrl;
          imgEl.style.opacity = '1';
        }
      }
      
      imageContainer.className = 'nft-detail-image ' + (isCompressed ? 'compressed' : 'standard');

      const mintAddr = nft.mintAddress || nft.assetId || nft.mint || '';
      currentDetailNFT.mintAddress = mintAddr;

      const titleEl = document.getElementById('nft-detail-title');
      if (titleEl) titleEl.textContent = nft.name || 'Original';

      // Rebuild badge row: certification mode + storage + encrypted + watermarked + license
      const badgeRow = document.getElementById('nft-detail-badge-row');
      if (badgeRow) {
        badgeRow.innerHTML = '';
        // Certification mode badge (Private/Public) — replaces legacy Open/Limited
        if (isPrivateNFTClassification(nft)) {
          badgeRow.innerHTML += '<div class="nft-chip cert-private">🔐 Private</div>';
        } else if (isPublicNFTClassification(nft)) {
          badgeRow.innerHTML += '<div class="nft-chip cert-public">🌍 Public</div>';
        } else {
          badgeRow.innerHTML += '<div class="nft-chip ' + (isCompressed ? 'cnft' : 'standard') + '">' + (isCompressed ? 'Public' : 'Private') + '</div>';
        }
        // Storage chip
        const rawImageUrl = (nft && (nft.imageUrl || nft.image)) ? String(nft.imageUrl || nft.image) : '';
        const _allUrls = rawImageUrl + (nft.arweaveUrl || '');
        const storageLabel = nft.storageType ? (nft.storageType === 'cloud' ? 'Encrypted Cloud' : nft.storageType === 'arweave' ? 'Arweave' : nft.storageType === 'onchain' ? 'On-Chain' : 'Decentralized') : (isStealthCloudUrl(_allUrls) ? 'Encrypted Cloud' : _allUrls.includes('arweave.net') || _allUrls.includes('akrd.net') ? 'Arweave' : 'Decentralized');
        badgeRow.innerHTML += '<div class="nft-chip storage">' + storageLabel + '</div>';
        // Encrypted badge
        if (nft.encrypted === true) {
          badgeRow.innerHTML += '<div class="nft-chip encrypted">🔒 Encrypted</div>';
        }
        // Watermarked badge
        if (nft.watermarked === true) {
          badgeRow.innerHTML += '<div class="nft-chip watermarked">Watermarked</div>';
        }
        // License badge — always show (ARR as amber, CC as cyan)
        if (nft.license && nft.license !== 'none') {
          const licenseLabels = {'arr':'ALL RIGHTS RESERVED','cc-by':'CC BY 4.0','cc-by-sa':'CC BY-SA 4.0','cc-by-nc':'CC BY-NC 4.0','cc-by-nc-sa':'CC BY-NC-SA 4.0','cc-by-nd':'CC BY-ND 4.0','cc-by-nc-nd':'CC BY-NC-ND 4.0','cc0':'CC0 (Public Domain)','commercial':'Commercial License'};
          const isArr = nft.license === 'arr';
          badgeRow.innerHTML += '<div class="nft-chip ' + (isArr ? 'edition-limited' : 'license') + '">' + (licenseLabels[nft.license] || nft.license.toUpperCase()) + '</div>';
        }
        // RFC 3161 + C2PA badges (all certified editions)
        const attrs = nft.attributes || [];
        if (attrs.some(a => a.trait_type === 'RFC 3161 Timestamp')) {
          badgeRow.innerHTML += '<div class="nft-chip rfc3161">⏱ RFC 3161</div>';
        }
        if (attrs.some(a => a.trait_type === 'C2PA Provenance')) {
          badgeRow.innerHTML += '<div class="nft-chip c2pa">C2PA</div>';
        }
      }

      const rawImageUrl = (nft && (nft.imageUrl || nft.image)) ? String(nft.imageUrl || nft.image) : '';
      const _allUrls2 = rawImageUrl + (nft.arweaveUrl || '');
      const storageLabel = nft.storageType ? (nft.storageType === 'cloud' ? 'Encrypted Cloud' : nft.storageType === 'arweave' ? 'Arweave' : nft.storageType === 'onchain' ? 'On-Chain' : 'Decentralized') : (isStealthCloudUrl(_allUrls2) ? 'Encrypted Cloud' : _allUrls2.includes('arweave.net') || _allUrls2.includes('akrd.net') ? 'Arweave' : 'Decentralized');

      const ownerFull = document.getElementById('nft-detail-owner-full');
      if (ownerFull) ownerFull.textContent = nft.ownerAddress || nftWalletAddress || '';

      // Populate copiable URI section
      const uriSection = document.getElementById('nft-uri-section');
      const imageUriText = document.getElementById('nft-image-uri-text');
      const metaBlock = document.getElementById('nft-metadata-uri-block');
      const metaUriText = document.getElementById('nft-metadata-uri-text');
      if (uriSection && imageUriText) {
        const imgUrl = rawImageUrl || '';
        if (imgUrl) {
          uriSection.style.display = '';
          imageUriText.textContent = imgUrl.startsWith('data:') ? 'data:image/svg+xml;base64,...' : imgUrl;
          imageUriText.dataset.fullUri = imgUrl;
        } else {
          uriSection.style.display = 'none';
        }
        const metaUrl = nft.metadataUrl || nft.uri || '';
        if (metaBlock && metaUriText && metaUrl) {
          metaBlock.style.display = '';
          const metaCid = extractIPFSCid(metaUrl);
          const displayMeta = metaCid ? 'https://ipfs.io/ipfs/' + metaCid : metaUrl;
          metaUriText.textContent = displayMeta;
          metaUriText.dataset.fullUri = displayMeta;
        } else if (metaBlock) {
          metaBlock.style.display = 'none';
        }
      }

      configureNFTDetailActions(currentDetailNFT, isCompressed, storageLabel);
      verifyNFTDetailOnOpen(currentDetailNFT);
      
      // Transfer button — only enabled for PhotoLynk ecosystem cNFTs
      const transferBtn = document.getElementById('nft-transfer-main-btn');
      if (transferBtn) {
        if (isPhotoLynkEcosystem(currentDetailNFT)) {
          transferBtn.disabled = false;
          transferBtn.style.background = '';
          transferBtn.style.cursor = 'pointer';
          transferBtn.style.opacity = '1';
          transferBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Transfer Original';
        } else {
          transferBtn.disabled = true;
          transferBtn.style.background = 'rgba(255,255,255,0.08)';
          transferBtn.style.cursor = 'not-allowed';
          transferBtn.style.opacity = '0.5';
          transferBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Not Transferrable';
        }
      }

      // Show overlay
      document.getElementById('nft-detail-overlay').classList.add('active');
    }
    
    function closeNFTDetail() {
      // Clean up decrypt status overlay if present
      const decryptStatus = document.getElementById('nft-decrypt-status');
      if (decryptStatus) decryptStatus.remove();
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
        text.textContent = 'Verified on Blockchain';
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
        left.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Explorer</span>';
      }

      if (right) {
        const label = storageLabel === 'Encrypted Cloud' ? 'Image' : storageLabel === 'Arweave' ? 'Arweave' : storageLabel === 'On-Chain' ? 'Metadata' : 'Image';
        right.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg><span>' + label + '</span>';
      }
    }

    function openNFTTokenView() {
      if (!currentDetailNFT) return;
      const nft = currentDetailNFT;
      const mintAddr = String(nft.mintAddress || nft.assetId || nft.mint || '');
      
      // Get real asset ID (strip cnft_ prefix, skip tx_ signatures)
      let assetId = String(nft.assetId || '').trim().replace(/^cnft_/, '');
      if (!assetId && mintAddr.startsWith('cnft_') && !mintAddr.startsWith('cnft_tx_')) {
        assetId = mintAddr.replace(/^cnft_/, '');
      }
      // For standard NFTs, the mintAddress IS the asset ID
      if (!assetId && !mintAddr.startsWith('tx_') && !mintAddr.startsWith('cnft_tx_') && mintAddr.length > 30) {
        assetId = mintAddr.replace(/^cnft_/, '');
      }
      
      // Valid asset ID (not a tx signature) → open Tensor
      if (assetId && assetId.length > 30 && !assetId.startsWith('tx_')) {
        console.log('[NFT Explorer] Opening Tensor:', assetId);
        require('electron').shell.openExternal('https://www.tensor.trade/item/' + assetId);
        return;
      }
      
      // Only have tx signature → Solscan fallback (Tensor will 404 on tx signatures)
      const txSig = mintAddr.replace(/^cnft_tx_/, '').replace(/^cnft_/, '').replace(/^tx_/, '') || String(nft.txSignature || '');
      if (txSig && txSig.length > 30) {
        console.log('[NFT Explorer] Opening Solscan (no asset ID):', txSig);
        require('electron').shell.openExternal('https://solscan.io/tx/' + txSig);
        return;
      }
      
      // Last resort
      console.log('[NFT Explorer] No valid ID found, opening Tensor with:', mintAddr);
      require('electron').shell.openExternal('https://www.tensor.trade/item/' + mintAddr);
    }

    async function openNFTStorageView() {
      if (!currentDetailNFT) return;
      const isCompressed = currentDetailNFT.isCompressed === true;
      

      const rawImageUrl = (currentDetailNFT && (currentDetailNFT.imageUrl || currentDetailNFT.image)) ? String(currentDetailNFT.imageUrl || currentDetailNFT.image) : '';
      const _allUrls3 = rawImageUrl + (currentDetailNFT.arweaveUrl || '');
      const isCloud = currentDetailNFT.storageType === 'cloud' || (!currentDetailNFT.storageType && isStealthCloudUrl(_allUrls3));
      const isArweave = currentDetailNFT.storageType === 'arweave' || rawImageUrl.includes('akrd.net') || rawImageUrl.includes('arweave.net');
      const isOnChain = currentDetailNFT.storageType === 'onchain' || rawImageUrl.startsWith('data:');
      if (isOnChain) {
        // On-chain SVG is embedded in metadata — show the metadata URL instead
        const metaUrl = currentDetailNFT.metadataUrl || currentDetailNFT.uri || '';
        if (metaUrl) require('electron').shell.openExternal(metaUrl.startsWith('http') ? metaUrl : 'https://ipfs.io/ipfs/' + metaUrl);
        return;
      }
      if (isCloud || isArweave) {
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
    
    function isPhotoLynkEcosystem(nft) {
      if (!nft) return false;
      if (nft.merkleTree === '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS') return true;
      if (nft.creatorWallet === 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU') return true;
      const attrs = nft.metadata?.attributes || nft.attributes || [];
      const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
      const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
      if (hasContentHash && hasExifHash) return true;
      const metaCert = nft.metadata?.properties?.certificate;
      if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
      if (nft.name && nft.name.includes('PhotoLynk')) return true;
      return false;
    }

    async function openNFTTransfer() {
      if (!currentDetailNFT) return;
      if (!isPhotoLynkEcosystem(currentDetailNFT)) return;
      
      const isCompressed = currentDetailNFT.isCompressed === true;
      const imageUrl = currentDetailNFT.cachedPath ? 'file://' + currentDetailNFT.cachedPath : (currentDetailNFT.image || currentDetailNFT.imageUrl || '');
      
      document.getElementById('nft-transfer-img').src = imageUrl;
      document.getElementById('nft-transfer-name').textContent = currentDetailNFT.name || 'Unnamed Original';
      document.getElementById('nft-transfer-type').textContent = isPrivateNFTClassification(currentDetailNFT) ? 'Private' : isPublicNFTClassification(currentDetailNFT) ? 'Public' : isCompressed ? 'Public' : 'Private';
      
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

    function isRetryableCompressedTransferErrorMessage(error) {
      const text = String(error || '').toLowerCase();
      if (!text) return false;
      return (
        text.includes('failed to verify the merkle proof') ||
        text.includes('proof verification failed') ||
        text.includes('concurrent merkle tree') ||
        text.includes('leaf contents') ||
        text.includes('invalid root') ||
        text.includes('hashing mismatch') ||
        text.includes('stale proof') ||
        text.includes('root mismatch') ||
        text.includes('proof mismatch') ||
        (text.includes('proof') && (text.includes('merkle') || text.includes('root') || text.includes('hash') || text.includes('verify') || text.includes('canopy')))
      );
    }
    
    async function confirmNFTTransfer() {
      const recipient = document.getElementById('nft-transfer-recipient').value.trim();
      
      if (!recipient) {
        alert('Please enter a recipient address');
        return;
      }
      
      // Validate Solana address (base58, 32-44 chars)
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) {
        alert('Invalid recipient address');
        return;
      }
      
      if (!currentDetailNFT) {
        alert('No record selected');
        return;
      }
      
      if (!nftWalletAddress) {
        alert('Please connect your credentials first');
        return;
      }
      
      const confirmBtn = document.querySelector('.nft-transfer-actions .nft-action-btn.primary');
      
      try {
        confirmBtn.textContent = 'Building TX...';
        confirmBtn.disabled = true;
        
        const mintAddr = currentDetailNFT.mintAddress || currentDetailNFT.assetId || currentDetailNFT.mint;
        const isCompressed = currentDetailNFT.isCompressed === true;
        const actualMint = isCompressed ? mintAddr.replace('cnft_', '') : mintAddr;
        let retriedFreshProof = false;
        let transferPollInterval = null;
        let transferPollTimeout = null;
        const resetTransferPolling = () => {
          if (transferPollInterval) {
            clearInterval(transferPollInterval);
            transferPollInterval = null;
          }
          if (transferPollTimeout) {
            clearTimeout(transferPollTimeout);
            transferPollTimeout = null;
          }
        };
        const openTransferForSignature = async (buttonText) => {
          confirmBtn.textContent = buttonText;
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
          ipcRenderer.send('open-nft-transfer', {
            transaction: txResult.transaction,
            mint: actualMint,
            recipient: recipient,
            isVersioned: txResult.isVersioned || false
          });
        };
        const startTransferPolling = () => {
          resetTransferPolling();
          transferPollInterval = setInterval(async () => {
          try {
            const res = await fetch('http://localhost:3000/nft-transfer-status');
            const data = await res.json();
            if (data.completed) {
              resetTransferPolling();
              // Bring app window to front
              ipcRenderer.send('focus-window');
              if (data.success) {
                showTransferSuccessModal(data.signature);
                closeNFTTransfer();
                closeNFTDetail();
                // Remove transferred NFT and its certificate from local storage
                const transferredMintStored = mintAddr;
                const transferredMintStripped = actualMint;
                try {
                  // Transfer cert FIRST (before NFT removal) so encryptionData is still readable for nftKey unwrap
                  await ipcRenderer.invoke('transfer-certificate', transferredMintStored, recipient);
                  if (transferredMintStripped !== transferredMintStored) {
                    await ipcRenderer.invoke('transfer-certificate', transferredMintStripped, recipient);
                  }
                  // Now remove both forms to handle cNFT ids stored as 'cnft_<assetId>'
                  await ipcRenderer.invoke('remove-stored-nft', transferredMintStored);
                  await ipcRenderer.invoke('remove-stored-nft', transferredMintStripped);
                  // Also remove from in-memory caches
                  const norm = (transferredMintStripped || '').replace('cnft_', '');
                  if (window.allNFTs) window.allNFTs = window.allNFTs.filter(n => (n.mintAddress || '').replace('cnft_', '') !== norm);
                  cachedCerts = cachedCerts.filter(c => (c.mintAddress || '').replace('cnft_', '') !== norm);
                  console.log('[Transfer] Transferred cert + removed NFT from local storage:', transferredMintStored);
                } catch (removeErr) {
                  console.log('[Transfer] Local removal error:', removeErr.message);
                }
                // If certs overlay is open, re-render to avoid showing stale cached entries
                try {
                  const certsOverlay = document.getElementById('certs-overlay');
                  if (certsOverlay && certsOverlay.classList.contains('active')) {
                    loadCertificates();
                  }
                } catch (_) {}
                refreshNFTAlbum();
              } else {
                const errorText = String(data.error || '');
                const isCancelled = errorText.toLowerCase().includes('cancel') || errorText.toLowerCase().includes('rejected');
                if (isCompressed && !retriedFreshProof && isRetryableCompressedTransferErrorMessage(errorText)) {
                  retriedFreshProof = true;
                  try {
                    await openTransferForSignature('Refreshing Proof...');
                    startTransferPolling();
                    return;
                  } catch (retryErr) {
                    console.error('[NFT Transfer] Fresh-proof retry failed:', retryErr);
                    showTransferCancelledModal(false);
                  }
                } else {
                  showTransferCancelledModal(isCancelled);
                }
              }
              confirmBtn.innerHTML = 'Confirm Transfer';
              confirmBtn.disabled = false;
            }
          } catch (e) { /* Server not ready */ }
          }, 1000);
          
          transferPollTimeout = setTimeout(() => {
            resetTransferPolling();
            confirmBtn.innerHTML = 'Confirm Transfer';
            confirmBtn.disabled = false;
          }, 180000);
        };

        await openTransferForSignature('Preparing TX...');
        startTransferPolling();
        
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
    
    function copyToClipboard(text, onSuccess) {
      var cb = typeof onSuccess === 'function' ? onSuccess : function(){};
      // Use Electron native clipboard via IPC (works in data:text/html pages)
      ipcRenderer.invoke('clipboard-write', text).then(function(ok) {
        if (ok) { cb(); return; }
        // Fallback to execCommand
        var ta = document.createElement('textarea'); ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); cb();
      }).catch(function() {
        var ta = document.createElement('textarea'); ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); cb();
      });
    }
    function copyNFTImageUri() {
      const el = document.getElementById('nft-image-uri-text');
      const uri = el?.dataset?.fullUri || el?.textContent || '';
      if (uri) {
        copyToClipboard(uri, () => { el.style.color = '#22c55e'; setTimeout(() => { el.style.color = ''; }, 1200); });
      }
    }
    function copyNFTMetadataUri() {
      const el = document.getElementById('nft-metadata-uri-text');
      const uri = el?.dataset?.fullUri || el?.textContent || '';
      if (uri) {
        copyToClipboard(uri, () => { el.style.color = '#22c55e'; setTimeout(() => { el.style.color = ''; }, 1200); });
      }
    }

    function openNFTGuide() {
      document.getElementById('nft-guide-overlay').style.display = 'flex';
      document.getElementById('nft-guide-dontshow').checked = false;
    }
    function closeNFTGuide() {
      const dontShow = document.getElementById('nft-guide-dontshow').checked;
      if (dontShow) {
        ipcRenderer.invoke('store-set', 'nftGuideDismissed', true).catch(() => {});
      }
      document.getElementById('nft-guide-overlay').style.display = 'none';
    }
    async function maybeShowNFTWelcome() {
      try {
        const dismissed = await ipcRenderer.invoke('store-get', 'nftGuideDismissed');
        if (!dismissed) openNFTGuide();
      } catch (_) {
        openNFTGuide();
      }
    }

    function copyCertCommand(id) {
      var el = document.getElementById('cert-cmd-' + id);
      if (!el) return;
      var spans = el.querySelectorAll('span');
      var textSpan = spans.length > 0 ? spans[0] : null;
      var hintSpan = spans.length > 1 ? spans[spans.length - 1] : null;
      var text = textSpan ? textSpan.textContent.trim() : '';
      if (!text) return;
      copyToClipboard(text, function() {
        if (hintSpan) { var orig = hintSpan.textContent; hintSpan.textContent = '✓ Copied!'; el.style.borderColor = '#f59e0b'; setTimeout(function() { hintSpan.textContent = orig; el.style.borderColor = 'rgba(245,158,11,0.2)'; }, 1500); }
      });
    }

    function toggleRfcExpand(platform) {
      var cert = window._rfcCertData;
      if (!cert) return;
      var toggleEl = document.getElementById('rfc-' + platform + '-toggle');
      var textEl = document.getElementById('rfc-' + platform + '-step1-text');
      if (!toggleEl || !textEl) return;
      var dq = String.fromCharCode(34);
      var sq = String.fromCharCode(39);
      var token = cert.rfc3161Token || '';
      var isHidden = textEl.style.fontStyle === 'italic';
      if (isHidden) {
        var cmd = platform === 'mac'
          ? 'printf ' + sq + '%s' + sq + ' ' + dq + token + dq + ' | base64 -d > token.tsr'
          : '[System.Convert]::FromBase64String(' + dq + token + dq + ') | Set-Content token.tsr -Encoding Byte';
        textEl.textContent = cmd;
        textEl.style.fontStyle = 'normal';
        textEl.style.color = '#a1a1aa';
        textEl.style.wordBreak = 'break-all';
        textEl.style.whiteSpace = 'pre-wrap';
        toggleEl.textContent = 'Hide';
      } else {
        textEl.textContent = '(token hidden \u2014 click Show to preview, click row to copy)';
        textEl.style.fontStyle = 'italic';
        textEl.style.color = '#6b7280';
        textEl.style.wordBreak = '';
        textEl.style.whiteSpace = '';
        toggleEl.textContent = 'Show';
      }
    }

    function copyRfcCmd(id) {
      var cert = window._rfcCertData;
      if (!cert) return;
      var dq = String.fromCharCode(34);
      var sq = String.fromCharCode(39);
      var token = cert.rfc3161Token || '';
      var hash = (cert.contentHash || '').replace(/^SHA256:/, '') || '<sha256_hash>';
      var cmds = {
        mac1: 'printf ' + sq + '%s' + sq + ' ' + dq + token + dq + ' | base64 -d > token.tsr',
        mac2: 'curl -o cacert.pem https://freetsa.org/files/cacert.pem',
        mac3: 'openssl ts -verify -in token.tsr -digest ' + hash + ' -CAfile cacert.pem',
        win1: '[System.Convert]::FromBase64String(' + dq + token + dq + ') | Set-Content token.tsr -Encoding Byte',
        win2: 'Invoke-WebRequest https://freetsa.org/files/cacert.pem -OutFile cacert.pem',
        win3: 'openssl ts -verify -in token.tsr -digest ' + hash + ' -CAfile cacert.pem'
      };
      var text = cmds[id];
      if (!text) return;
      // Find the clicked row to show feedback
      var rowEl = document.getElementById('rfc-' + id.replace(/[0-9]/g, '') + '-step' + id.slice(-1));
      if (!rowEl) {
        // Try generic lookup: mac1->rfc-mac-step1, win2->no specific id, use parent
        var parts = id.match(/^(mac|win)(\d)$/);
        if (parts) rowEl = document.getElementById('rfc-' + parts[1] + '-step' + parts[2]);
      }
      copyToClipboard(text, function() {
        if (rowEl) {
          var clipSpan = rowEl.querySelector('span:last-child');
          if (clipSpan) { var orig = clipSpan.textContent; clipSpan.textContent = '✓'; clipSpan.style.color = '#22c55e'; setTimeout(function() { clipSpan.textContent = orig; clipSpan.style.color = '#10b981'; }, 1500); }
        }
      });
    }

    function viewCertNFT(mintAddress) {
      // Close certs overlay, open NFT album, and try to find the NFT
      closeCertificates();
      openNFTAlbum();
      // Try to scroll to the NFT page containing this mint address
      if (mintAddress && allNFTs.length > 0) {
        const normId = normalizeNFTId(mintAddress);
        const idx = allNFTs.findIndex(n => normalizeNFTId(n.mintAddress || n.assetId) === normId);
        if (idx >= 0) {
          nftPageIndex = Math.floor(idx / NFT_PAGE_SIZE);
          renderNFTPage();
        }
      }
    }
    window.viewCertNFT = viewCertNFT;

    window.toggleRfcExpand = toggleRfcExpand;
    window.copyRfcCmd = copyRfcCmd;
    window.copyCertCommand = copyCertCommand;
    window.openNFTGuide = openNFTGuide;
    window.closeNFTGuide = closeNFTGuide;
    window.openNFTDetail = openNFTDetail;
    window.closeNFTDetail = closeNFTDetail;
    window.verifyNFTOnChain = verifyNFTOnChain;
    window.openNFTTokenView = openNFTTokenView;
    window.openNFTStorageView = openNFTStorageView;
    window.handleNFTVerifyClick = handleNFTVerifyClick;
    window.copyNFTImageUri = copyNFTImageUri;
    window.copyNFTMetadataUri = copyNFTMetadataUri;
    window.openNFTTransfer = openNFTTransfer;
    window.closeNFTTransfer = closeNFTTransfer;
    window.confirmNFTTransfer = confirmNFTTransfer;
    
    function showTransferSuccessModal(signature) {
      const solscanUrl = 'https://solscan.io/tx/' + signature;
      const shortSig = signature.slice(0, 16) + '...' + signature.slice(-16);
      
      // Create modal overlay
      const modal = document.createElement('div');
      modal.id = 'transfer-success-modal';
      modal.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = \`
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(20,241,149,0.3);box-shadow:0 20px 60px rgba(20,241,149,0.2);">
          <div style="font-size:56px;margin-bottom:16px;">✅</div>
          <h2 style="color:#14F195;font-size:22px;margin-bottom:8px;">Transfer Successful!</h2>
          <p style="color:#888;font-size:13px;margin-bottom:20px;">Your original has been transferred to the new owner.</p>
          
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
      modal.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = \`
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(255,255,255,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.4);">
          <div style="font-size:56px;margin-bottom:16px;">\${isCancelled ? '🚫' : '⚠️'}</div>
          <h2 style="color:#fff;font-size:20px;margin-bottom:8px;">\${isCancelled ? 'Transfer Cancelled' : 'Transfer Failed'}</h2>
          <p style="color:#888;font-size:13px;margin-bottom:24px;">\${isCancelled ? 'You cancelled the transaction in your credentials app.' : 'Something went wrong. Please try again.'}</p>
          <button onclick="document.getElementById('transfer-cancelled-modal').remove()" style="width:100%;padding:14px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:transparent;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
            OK
          </button>
        </div>
      \`;
      document.body.appendChild(modal);
    }
    window.showTransferCancelledModal = showTransferCancelledModal;
    
    // Decrypt result cache: maps imageUrl → base64 dataUrl (survives page navigation)
    const _decryptCache = {};
    
    // Decrypt queue: serialize encrypted NFT image decryption to avoid 429 rate limits
    const _decryptQueue = [];
    let _decryptRunning = false;
    function enqueueDecrypt(fn) {
      _decryptQueue.push(fn);
      if (!_decryptRunning) _drainDecryptQueue();
    }
    async function _drainDecryptQueue() {
      _decryptRunning = true;
      while (_decryptQueue.length > 0) {
        const task = _decryptQueue.shift();
        try { await task(); } catch (_) {}
        // Small delay between decrypts to avoid rate limits
        await new Promise(r => setTimeout(r, 100));
      }
      _decryptRunning = false;
    }

    // IPFS fetch queue: fetch images via IPC (Node.js main process) to avoid browser rate-limits.
    // Concurrency of 3 to avoid flooding gateways.
    const _ipfsCache = {};
    const _ipfsQueue = [];
    let _ipfsActive = 0;
    const IPFS_CONCURRENCY = 6;
    function enqueueIPFSFetch(cid, img, spinner) {
      if (_ipfsCache[cid]) {
        img.src = _ipfsCache[cid];
        img.style.opacity = '1';
        img.dataset.loaded = '1';
        if (spinner) spinner.style.display = 'none';
        return;
      }
      _ipfsQueue.push({ cid, img, spinner });
      _drainIPFSQueue();
    }
    async function _drainIPFSQueue() {
      while (_ipfsActive < IPFS_CONCURRENCY && _ipfsQueue.length > 0) {
        _ipfsActive++;
        const { cid, img, spinner } = _ipfsQueue.shift();
        (async () => {
          try {
            if (_ipfsCache[cid]) {
              img.src = _ipfsCache[cid];
              img.style.opacity = '1';
              img.dataset.loaded = '1';
              if (spinner) spinner.style.display = 'none';
              return;
            }
            const result = await ipcRenderer.invoke('fetch-ipfs-image', { cid });
            if (result && result.success && result.dataUrl) {
              _ipfsCache[cid] = result.dataUrl;
              img.src = result.dataUrl;
              img.style.opacity = '1';
              img.dataset.loaded = '1';
              if (spinner) spinner.style.display = 'none';
            } else {
              img.style.opacity = '0.3';
              if (spinner) spinner.style.display = 'none';
            }
          } catch (e) {
            img.style.opacity = '0.3';
            if (spinner) spinner.style.display = 'none';
          } finally {
            _ipfsActive--;
            _drainIPFSQueue();
          }
        })();
      }
    }

    function sortNFTsNewestFirst() {
      allNFTs.sort((a, b) => {
        const da = getNFTEffectiveDateValue(a);
        const db = getNFTEffectiveDateValue(b);
        if (da && db) return db - da;
        if (da) return -1;
        if (db) return 1;
        return 0;
      });
    }

    function renderNFTPage() {
      sortNFTsNewestFirst();
      const grid = document.getElementById('nft-grid');
      grid.innerHTML = '';
      // Clear any pending tasks from previous page
      _decryptQueue.length = 0;
      _ipfsQueue.length = 0;
      
      const filtered = getFilteredNFTs();
      const visibleCount = filtered.length;
      const totalPages = visibleCount > 0 ? Math.ceil(visibleCount / NFT_PAGE_SIZE) : 0;
      if (nftPageIndex > totalPages - 1) nftPageIndex = Math.max(0, totalPages - 1);
      // Pre-build index map for O(1) lookup instead of O(n) indexOf per card
      const _nftIndexMap = new Map();
      for (let k = 0; k < allNFTs.length; k++) _nftIndexMap.set(allNFTs[k], k);
      const startIdx = nftPageIndex * NFT_PAGE_SIZE;
      const batch = filtered.slice(startIdx, startIdx + NFT_PAGE_SIZE);
      
      batch.forEach((nft, i) => {
        // Map back to allNFTs index for detail/retry
        const globalIdx = _nftIndexMap.get(nft) ?? -1;
        const item = document.createElement('div');
        const isCompressed = nft.isCompressed === true;
        item.className = 'nft-item ' + (isCompressed ? 'compressed' : 'standard');
        item.onclick = () => openNFTDetail(globalIdx);
        // Treat any encrypted NFT with encryptionData as having keys — master key is derived from credentials
        const hasEncKeys = !!(nft.encrypted && nft.encryptionData);
        const isCached = !!nft.cachedPath && !hasEncKeys;
        const imageUrl = isCached ? nft.cachedPath : (nft.image || nft.imageUrl || '');
        const originalUrl = nft.ipfsThumbnailUrl || nft.imageUrl || nft.image || '';  // Prefer IPFS thumb as fallback (tiny ~30KB)
        const nftName = nft.name || 'Original #' + (globalIdx + 1);
        const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

        // Limited Edition — fall through to normal image loading (app has auth/keys for all storage types)
        // Normal image loading below already builds proper badges for limited/open/encrypted

        if (!imageUrl) {
          // Show spinner and try to fetch image from metadata URL
          const metadataUrl = nft.metadataUrl || '';
          const nftIndex = globalIdx;
          // Always try to fetch if we have metadata URL (even if previous attempt failed)
          if (metadataUrl) {
            item.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div><div style="position:absolute;bottom:40px;left:0;right:0;text-align:center;font-size:9px;color:var(--text-muted);">Loading...</div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
            grid.appendChild(item);
            // Try to fetch image from metadata in background
            console.log('[NFT Album] No image for', nftName, '- retrying from metadata:', metadataUrl.slice(0, 50));
            retryNFTImageFromMetadata(nftIndex, metadataUrl, item, nftName, isCompressed);
          } else {
            // No metadata URL either - show placeholder with retry button
            item.innerHTML = '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);cursor:pointer;" onclick="retrySingleNFT(' + globalIdx + ')"><div style="padding:8px;text-align:center;font-size:10px;color:var(--text-muted);">No image</div><div style="font-size:9px;color:var(--accent);">Tap to retry</div></div><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div></div>';
            grid.appendChild(item);
          }
          return;
        }
        
        // Use cached local file if available, otherwise use IPFS gateway
        let primaryUrl = imageUrl;
        const isDataUri = imageUrl.startsWith('data:');
        let ipfsCidForQueue = null;
        if (isCached) {
          // Local file path - use file:// protocol
          primaryUrl = 'file://' + imageUrl;
          console.log('[NFT Album] Using cached:', nftName);
        } else if (isDataUri) {
          // data: URIs (on-chain SVG) load instantly — no gateway needed
          console.log('[NFT Album] Using data URI:', nftName);
        } else {
          const cid = extractIPFSCid(imageUrl);
          if (cid) {
            // Use IPC fetch queue to avoid browser rate-limits on IPFS gateways
            ipfsCidForQueue = cid;
            primaryUrl = TRANSPARENT_PIXEL;
          }
          console.log('[NFT Album] Loading', nftName, (isCompressed ? '(cNFT)' : ''), ipfsCidForQueue ? '(IPC)' : '', ':', (ipfsCidForQueue || primaryUrl).slice(0, 50) + '...');
        }
        
        // Build inline badge pills for bottom overlay (matches mobile Solana style)
        const rawImg = (nft.imageUrl || nft.image || '');
        const stType = nft.storageType || (rawImg.startsWith('data:') ? 'onchain' : (rawImg.includes('stealthlynk.io') || rawImg.includes('stealthcloud')) ? 'cloud' : (rawImg.includes('akrd.net') || rawImg.includes('arweave.net')) ? 'arweave' : 'ipfs');
        let badgeRow = '<div class="nft-badge-row">';
        // Certification mode badge (Private/Public) — replaces legacy Open/Limited
        if (isPrivateNFTClassification(nft)) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(99,102,241,0.3);color:#818cf8;">🔐 Private</span>';
        } else if (isPublicNFTClassification(nft)) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(34,197,94,0.3);color:#22c55e;">🌍 Public</span>';
        } else if (isCompressed) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(34,197,94,0.3);color:#22c55e;">cNFT</span>';
        } else {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(153,69,255,0.3);color:#9945FF;">⬡</span>';
        }
        // Encrypted badge
        if (nft.encrypted) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(153,69,255,0.3);color:#9945FF;">🔒</span>';
        }
        // Storage badge
        if (stType === 'cloud') {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(59,130,246,0.3);color:#3b82f6;">☁️</span>';
        } else if (stType === 'onchain') {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(245,158,11,0.3);color:#f59e0b;">⟨/⟩</span>';
        } else if (stType === 'arweave') {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(34,197,94,0.3);color:#22c55e;">📦</span>';
        } else {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(153,69,255,0.3);color:#9945FF;">🌐</span>';
        }
        badgeRow += '</div>';
        item.innerHTML = '<div class="nft-spinner" style="position:absolute;top:50%;left:50%;margin-left:-12px;margin-top:-12px;"></div><img style="opacity:0;transition:opacity 0.3s;" data-original-url="' + originalUrl + '" data-fallback-url="' + originalUrl + '" data-gateway-index="0" data-retry-count="0" data-source="primary" data-compressed="' + (isCompressed ? '1' : '0') + '" data-cached="' + (isCached ? '1' : '0') + '" src="' + (hasEncKeys ? TRANSPARENT_PIXEL : primaryUrl) + '"><div class="nft-item-overlay"><div class="nft-item-name">' + nftName + '</div>' + badgeRow + '</div>';
        grid.appendChild(item);

        const img = item.querySelector('img');
        const spinner = item.querySelector('.nft-spinner');
        if (img) {
          // data: URIs (on-chain SVG) — mark as loaded immediately, no retry/timeout
          // (matches solana-seeker which renders SVG data URIs via a separate SvgXml path)
          if (isDataUri) {
            img.dataset.loaded = '1';
            img.style.opacity = '1';
            if (spinner) spinner.style.display = 'none';
          } else {
          img.dataset.loaded = '0';
          img.onload = () => { 
            img.dataset.loaded = '1'; 
            img.style.opacity = '1';
            if (spinner) spinner.style.display = 'none';
            clearNFTImageTimeout(img); 
          };
          img.onerror = () => { clearNFTImageTimeout(img); handleNFTImageError(img, false); };
          // Encrypted thumbnails are decrypted manually; don't start network timeout/fallback loop.
          // Skip timeout for cached images - they load instantly
          if (!isCached && !hasEncKeys && !ipfsCidForQueue) scheduleNFTImageTimeout(img);

          if (ipfsCidForQueue && !hasEncKeys) {
            // IPFS images: fetch via IPC (Node.js main process) to avoid browser rate-limits
            enqueueIPFSFetch(ipfsCidForQueue, img, spinner);
          } else if (hasEncKeys) {
            // Use decrypt queue to serialize — prevents 429 rate limits from concurrent downloads
            const cacheKey = nft.thumbnailUrl || originalUrl || nft.mintAddress;
            // Check decrypt cache first
            if (cacheKey && _decryptCache[cacheKey]) {
              img.src = _decryptCache[cacheKey];
              img.style.opacity = '1';
              img.dataset.loaded = '1';
              if (spinner) spinner.style.display = 'none';
            } else {
            enqueueDecrypt(async () => {
              try {
                // Re-check cache (may have been populated while queued)
                if (cacheKey && _decryptCache[cacheKey]) {
                  img.src = _decryptCache[cacheKey];
                  img.style.opacity = '1';
                  img.dataset.loaded = '1';
                  if (spinner) spinner.style.display = 'none';
                  return;
                }
                const decryptUrl = (typeof originalUrl === 'string' && originalUrl.startsWith('http')) ? originalUrl : '';
                const hasThumb = !!(nft.thumbnailUrl && nft.encryptionData?.thumbnailNonce);
                if (!decryptUrl && !hasThumb) {
                  // No network URL and no encrypted thumbnail — show lock icon
                  img.style.opacity = '0.3';
                  if (spinner) spinner.style.display = 'none';
                  return;
                }
                const result = await ipcRenderer.invoke('decrypt-nft-image', { imageUrl: decryptUrl, thumbnailUrl: nft.thumbnailUrl || null, encryptionData: nft.encryptionData });
                if (result && result.success && result.dataUrl) {
                  img.src = result.dataUrl;
                  img.style.opacity = '1';
                  img.dataset.loaded = '1';
                  if (spinner) spinner.style.display = 'none';
                  // Cache the result
                  if (cacheKey) _decryptCache[cacheKey] = result.dataUrl;
                } else {
                  // Decryption failed — show error message instead of falling back to encrypted .bin URL
                  img.style.opacity = '0.3';
                  if (spinner) spinner.style.display = 'none';
                  console.log('[NFT Album] Decrypt failed for', nftName, ':', result?.error);
                }
              } catch (e) {
                img.style.opacity = '0.3';
                if (spinner) spinner.style.display = 'none';
                console.log('[NFT Album] Decrypt error for', nftName, ':', e.message);
              }
            });
            }
          }
          } // close else (non-data-URI path)
        }
      });
      
      updateNFTNavigation();
      
      // Scroll to show the grid and navigation after content renders
      setTimeout(() => scrollToNFTGrid(), 50);
    }
    
    function updateNFTNavigation() {
      let navContainer = document.getElementById('nft-nav');
      if (!navContainer) return;
      
      const filtered = getFilteredNFTs();
      const visibleCount = filtered.length;
      const totalPages = visibleCount > 0 ? Math.ceil(visibleCount / NFT_PAGE_SIZE) : 0;
      if (nftPageIndex > totalPages - 1) nftPageIndex = Math.max(0, totalPages - 1);
      if (visibleCount === 0) {
        navContainer.innerHTML = '';
        return;
      }
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
      const totalPages = Math.ceil(getFilteredNFTs().length / NFT_PAGE_SIZE);
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

    // Bind all inline onclick handlers to window
    window.showView = showView;
    window.toggleSettings = toggleSettings;
    window.closeSettings = closeSettings;
    window.toggleCredentials = toggleCredentials;
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
    window.openNFTMint = openNFTMint;
    window.closeNFTMint = closeNFTMint;
    window.selectNFTType = selectNFTType;
    window.selectNFTEdition = selectNFTEdition;
    window.selectNFTStorage = selectNFTStorage;
    window.selectNFTPhoto = selectNFTPhoto;
    window.removeNFTPhoto = removeNFTPhoto;
    window.connectNFTWallet = connectNFTWallet;
    window.doMintNFT = doMintNFT;
    window.openNFTAlbum = openNFTAlbum;
    window.closeNFTAlbum = closeNFTAlbum;
    window.refreshNFTAlbum = refreshNFTAlbum;
    window.handleNFTImageError = handleNFTImageError;
    
    ipcRenderer.on('wallet-connected', async (e, address) => {
      // Skip if the polling path already handled this wallet connect
      // (the broadcast from wallet-connected-from-browser comes back to this renderer)
      if (walletHandledByPoll && nftWalletAddress === address) {
        walletHandledByPoll = false;
        return;
      }
      walletHandledByPoll = false;
      const walletChanged = nftWalletAddress !== address;
      nftWalletAddress = address;
      updateMintWalletUI();
      if (walletChanged) {
        // Wallet switched: purge persisted NFTs/certs so old owner's items don't appear
        allNFTs = [];
        cachedCerts = [];
        nftPageIndex = 0;
        stopNFTAutoRefresh();
        // Immediately clear certs UI so old wallet's certs don't flash
        const cl = document.getElementById('certs-list');
        const cld = document.getElementById('certs-loading');
        const ce = document.getElementById('certs-empty');
        if (cl) cl.innerHTML = '';
        if (cld) cld.style.display = 'block';
        if (ce) ce.style.display = 'none';
        try { await ipcRenderer.invoke('purge-nft-storage'); } catch (_) {}
        try { await ipcRenderer.invoke('clear-nft-cache'); } catch (_) {}
        loadNFTAlbum();
      } else {
        checkForNewNFTsOnce();
        startNFTAutoRefresh();
      }
      // Reload certs if certs overlay is open (wallet just connected from certs screen)
      const certsOverlay = document.getElementById('certs-overlay');
      if (certsOverlay && certsOverlay.classList.contains('active')) {
        loadCertificates();
      }
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
  
  
  mainWindow.webContents.on('console-message', (e, level, msg) => {
    if (msg.startsWith('[NFT]')) safeConsole('log', '[Renderer]', msg);
  });
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
      --bg-primary: #060608;
      --bg-card: rgba(17, 17, 20, 0.9);
      --accent: #03E1FF;           /* Ocean blue - main accent */
      --text-primary: #F0F0F5;
      --text-secondary: #8888A0;
      --text-muted: #55556A;
      --border: rgba(37, 37, 48, 0.8);
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
    try { fs.mkdirSync(folderPath, { recursive: true }); } catch (e) {}
    shell.openPath(folderPath).then(err => {
      if (err) console.error('[open-folder] shell.openPath error:', err);
    });
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
  // Caches are warmed on-demand by refreshNFTPricesRealtime in the renderer
  
  // Pre-warm macOS file dialog: read Pictures dir to cache UTI metadata and reduce NSOpenPanel cold-start
  if (process.platform === 'darwin') {
    setTimeout(() => {
      try {
        const picturesDir = app.getPath('pictures') || app.getPath('home');
        fs.readdir(picturesDir, { withFileTypes: true }, () => {});
      } catch (e) { /* ignore */ }
    }, 3000);
  }
});

ipcMain.on('open-nft-mint', () => {
  const credentials = store.get('backupCredentials') || {};
  nftDesktop.openNFTMintWindow(app.getPath('userData'), credentials);
});

ipcMain.on('open-nft-album', () => {
  nftDesktop.openNFTAlbumWindow(app.getPath('userData'), connectedWalletAddress);
});

ipcMain.on('open-wallet-connect', () => {
  const { shell } = require('electron');
  shell.openExternal('http://localhost:3000/wallet-connect');
  // Notify user to unlock Phantom if it doesn't auto-pop
  setTimeout(() => {
    try {
      new Notification({
        title: 'Connect Credentials',
        body: 'A browser tab opened. If the wallet extension didn\'t pop up, click its icon in your browser and approve the connection.',
        silent: false
      }).show();
    } catch (e) { /* Notification not supported */ }
  }, 1500);
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
  const defaultDir = app.getPath('pictures') || app.getPath('home');
  const result = await dialog.showOpenDialog(parentWindow, {
    properties: ['openFile'],
    defaultPath: defaultDir,
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'avif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2'] }
    ],
    title: 'Select Photo to Certify'
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

ipcMain.handle('open-pictures-folder', async () => {
  const picturesDir = app.getPath('pictures') || app.getPath('home');
  try { require('fs').mkdirSync(picturesDir, { recursive: true }); } catch (e) {}
  await shell.openPath(picturesDir);
  return picturesDir;
});

ipcMain.handle('fetch-user-nfts', async (event, walletAddress, limit) => {
  // Pass StealthCloud auth headers so cached images from stealthlynk.io can be downloaded
  let authHeaders = null;
  const credentials = store.get('backupCredentials') || {};
  if (credentials.baseUrl && credentials.token) {
    const authToken = String(credentials.token).startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
    authHeaders = { Authorization: authToken };
    if (credentials.deviceUuid) authHeaders['X-Device-UUID'] = credentials.deviceUuid;
  }
  return await nftDesktop.fetchUserNFTs(walletAddress, limit, authHeaders);
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

// Save minted NFT to local storage + server sync (post-mint, matches solana-seeker)
ipcMain.handle('save-minted-nft', async (event, nftData) => {
  try {
    await nftDesktop.saveNFTToStorage(nftData);
    // Sync to server
    const credentials = store.get('backupCredentials') || {};
    if (credentials.baseUrl && credentials.token) {
      const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
      try {
        const axios = require('axios');
        await axios.post(`${credentials.baseUrl}/api/nft/sync`, {
          action: 'add', nft: nftData,
        }, { headers: { Authorization: authHeader, ...(credentials.deviceUuid ? { 'X-Device-UUID': credentials.deviceUuid } : {}) }, timeout: 10000 });
        safeConsole('log', '[NFT] Synced to server:', nftData.mintAddress);
      } catch (syncErr) {
        safeConsole('log', '[NFT] Server sync failed:', syncErr.message);
      }
    }
    return { success: true };
  } catch (e) {
    safeConsole('log', '[NFT] Save failed:', e.message);
    return { success: false, error: e.message };
  }
});

// Generate + save + sync certificate for all editions (post-mint)
ipcMain.handle('generate-certificate', async (event, data) => {
  try {
    safeConsole('log', '[NFT] generate-certificate IPC: tsaToken?', !!data?.tsaToken, 'c2pa?', !!data?.c2paManifest, 'edition:', data?.edition);
    const cert = nftDesktop.generateCertificate(data);
    if (!cert) return { success: false, error: 'Certificate generation returned null' };
    safeConsole('log', '[NFT] Certificate generated: rfc3161Token?', !!cert.rfc3161Token, 'hasRfc3161:', cert.hasRfc3161, 'hasC2pa:', cert.hasC2pa);
    
    // Save to tray's own local file
    await nftDesktop.saveCertificateLocal(cert);
    
    // Also save directly to server-side cert file (tray IS the server)
    try {
      const nftBaseDir = path.join(app.getPath('userData'), 'cloud', 'nft');
      if (fs.existsSync(nftBaseDir)) {
        const userDirs = fs.readdirSync(nftBaseDir);
        for (const dir of userDirs) {
          const certFile = path.join(nftBaseDir, dir, 'certificates.json');
          let certs = [];
          if (fs.existsSync(certFile)) {
            try { certs = JSON.parse(fs.readFileSync(certFile, 'utf8')); } catch (_) {}
          }
          if (!certs.find(c => c.id === cert.id)) {
            certs.push(cert);
            fs.writeFileSync(certFile, JSON.stringify(certs, null, 2));
            safeConsole('log', '[NFT] Certificate also saved to server file:', certFile);
          }
        }
      }
    } catch (serverFileErr) {
      safeConsole('log', '[NFT] Server-side cert file save failed:', serverFileErr.message);
    }
    
    // Sync to StealthCloud
    const credentials = store.get('backupCredentials') || {};
    if (credentials.baseUrl && credentials.token) {
      const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
      try {
        const axios = require('axios');
        // Strip large fields to avoid 413 — keep boolean flags only
        const syncCert = { ...cert };
        if (syncCert.rfc3161Token) { syncCert.hasRfc3161 = true; delete syncCert.rfc3161Token; }
        if (syncCert.c2paManifest) { syncCert.hasC2pa = true; delete syncCert.c2paManifest; }
        await axios.post(`${credentials.baseUrl}/api/nft/certificates`, {
          action: 'add', certificate: syncCert,
        }, { headers: { Authorization: authHeader, ...(credentials.deviceUuid ? { 'X-Device-UUID': credentials.deviceUuid } : {}) }, timeout: 10000 });
        safeConsole('log', '[NFT] Certificate synced to StealthCloud:', cert.id);
      } catch (syncErr) {
        safeConsole('log', '[NFT] Certificate StealthCloud sync failed:', syncErr.message);
      }
    }
    return { success: true, certId: cert.id, certificate: cert };
  } catch (e) {
    safeConsole('log', '[NFT] Certificate generation failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('mint-nft', async (event, data) => {
  safeConsole('log', '[NFT] Mint request:', data);
  
  // Get credentials for StealthCloud upload
  let credentials = store.get('backupCredentials') || {};
  
  // Re-authenticate to get fresh token for StealthCloud upload
  if (credentials.baseUrl && credentials.email && credentials.password) {
    try {
      const axios = require('axios');
      const loginResp = await axios.post(`${credentials.baseUrl}/api/login`, {
        email: credentials.email,
        password: credentials.password,
        device_uuid: credentials.deviceUuid || '',
      }, { timeout: 10000 });
      if (loginResp.data && loginResp.data.token) {
        credentials = { ...credentials, token: loginResp.data.token };
        store.set('backupCredentials', credentials);
        safeConsole('log', '[NFT] Token refreshed for StealthCloud upload');
      }
    } catch (loginErr) {
      safeConsole('log', '[NFT] Token refresh failed:', loginErr.message);
    }
  }
  
  const mintParams = {
    ...data,
    credentials: credentials.baseUrl ? {
      baseUrl: credentials.baseUrl,
      token: credentials.token,
      deviceUuid: credentials.deviceUuid,
    } : null,
  };
  
  // Derive master key from credentials if encryption is requested
  // Use legacy MK creds for migrated wallet users (encryption key = original email+password)
  if (data.encrypt && credentials.email && credentials.password) {
    const mkEmail = (credentials.mk_email || credentials.email).toLowerCase().trim();
    const mkPassword = credentials.mk_password || credentials.password;
    mintParams.masterKey = new Uint8Array(crypto.pbkdf2Sync(mkPassword, mkEmail, 30000, 32, 'sha256'));
  }
  
  // Use nftDesktop.mintNFT which handles upload and opens wallet for payment
  const result = await nftDesktop.mintNFT(mintParams, (progress) => {
    // Send progress to renderer
    event.sender.send('mint-progress', progress);
  });
  
  // Invalidate DAS cache so next refresh does full re-scan to pick up new NFT
  if (result && result.success) {
    nftDesktop.invalidateDasCache();
  }
  
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

ipcMain.handle('bulk-save-nfts', async (event, nfts) => {
  await nftDesktop.bulkSaveNFTs(nfts);
});

ipcMain.handle('remove-stored-nft', async (event, mintAddress) => {
  try {
    const credentials = store.get('backupCredentials') || {};
    const serverUrl = credentials.baseUrl || null;
    const authHeader = credentials.token ? (String(credentials.token).startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`) : null;
    const authHeaders = authHeader ? { Authorization: authHeader, ...(credentials.deviceUuid ? { 'X-Device-UUID': credentials.deviceUuid } : {}) } : null;
    await nftDesktop.removeNFTFromStorage(mintAddress, serverUrl, authHeaders);
    return { success: true };
  } catch (e) {
    safeConsole('log', '[NFT] Remove failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remove-certificate', async (event, mintAddress) => {
  try {
    await nftDesktop.removeCertificateLocal(mintAddress);
    return { success: true };
  } catch (e) {
    safeConsole('log', '[NFT] Remove cert failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('transfer-certificate', async (event, mintAddress, newOwnerAddress) => {
  try {
    const credentials = store.get('backupCredentials') || {};
    const serverUrl = credentials.baseUrl || null;
    const authHeader = credentials.token ? (String(credentials.token).startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`) : null;
    const authHeaders = authHeader ? { Authorization: authHeader, ...(credentials.deviceUuid ? { 'X-Device-UUID': credentials.deviceUuid } : {}) } : null;
    if (!serverUrl || !authHeaders || !newOwnerAddress) {
      await nftDesktop.removeCertificateLocal(mintAddress);
      return { success: true, transferred: false, reason: 'no server/auth/recipient' };
    }
    // Read full cert from local storage before removing
    const certsPath = nftDesktop.getCertsFilePath();
    let certs = [];
    if (fs.existsSync(certsPath)) {
      try { certs = JSON.parse(fs.readFileSync(certsPath, 'utf8')); } catch (_) {}
    }
    const normMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const target = normMint(mintAddress);
    const toTransfer = certs.filter(c => normMint(c.mintAddress) === target);
    // For encrypted NFTs: unwrap the per-NFT key so new owner can decrypt
    let transferNftKey = null;
    try {
      const nft = await nftDesktop.getNFTByMintAddress(mintAddress) || await nftDesktop.getNFTByMintAddress(`cnft_${target}`);
      const encData = nft?.encryptionData;
      if (encData?.wrappedKey && encData?.wrapNonce) {
        const mkEmail = (credentials.mk_email || credentials.email || '').toLowerCase().trim();
        const mkPassword = credentials.mk_password || credentials.password || '';
        if (mkEmail && mkPassword) {
          const masterKey = new Uint8Array(crypto.pbkdf2Sync(mkPassword, mkEmail, 30000, 32, 'sha256'));
          const nacl = require('tweetnacl');
          const naclUtil = require('tweetnacl-util');
          const wk = naclUtil.decodeBase64(encData.wrappedKey);
          const wn = naclUtil.decodeBase64(encData.wrapNonce);
          const nftKey = nacl.secretbox.open(wk, wn, masterKey);
          if (nftKey) {
            transferNftKey = naclUtil.encodeBase64(nftKey);
            safeConsole('log', '[Transfer] Unwrapped nftKey for encrypted NFT transfer');
          }
        }
      }
    } catch (unwrapErr) {
      safeConsole('log', '[Transfer] Could not unwrap nftKey:', unwrapErr.message);
    }
    let transferred = 0;
    for (const cert of toTransfer) {
      try {
        const fullCert = { ...cert };
        if (transferNftKey) fullCert.transferNftKey = transferNftKey;
        const axios = require('axios');
        await axios.post(`${serverUrl}/api/nft/certificates`, {
          action: 'transfer',
          certificate: fullCert,
          newOwnerAddress,
        }, { headers: authHeaders, timeout: 15000 });
        transferred++;
        safeConsole('log', `[Transfer] Cert transferred to ${newOwnerAddress.slice(0, 8)}...: ${cert.id || cert.mintAddress}`);
      } catch (syncErr) {
        safeConsole('log', '[Transfer] Cert transfer sync failed:', syncErr.message);
      }
    }
    // Remove locally only if at least one cert was successfully transferred (prevents cert loss on server failure)
    if (transferred > 0) {
      await nftDesktop.removeCertificateLocal(mintAddress);
    }
    return { success: true, transferred };
  } catch (e) {
    safeConsole('log', '[NFT] Transfer cert failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('update-certificate-mint', async (event, oldMintAddress, newMintAddress) => {
  try {
    const certsPath = nftDesktop.getCertsFilePath();
    if (!fs.existsSync(certsPath)) return { success: false, error: 'No certs file' };
    let certs = [];
    try { certs = JSON.parse(fs.readFileSync(certsPath, 'utf8')); } catch (_) {}
    let updated = false;
    for (const cert of certs) {
      if (cert.mintAddress === oldMintAddress) {
        cert.mintAddress = newMintAddress;
        cert.id = `cert_${newMintAddress}`;
        updated = true;
      }
    }
    if (updated) {
      fs.writeFileSync(certsPath, JSON.stringify(certs, null, 2));
      safeConsole('log', '[NFT] Certificate mintAddress updated:', oldMintAddress, '->', newMintAddress);
    }
    return { success: true, updated };
  } catch (e) {
    safeConsole('log', '[NFT] Update cert mint failed:', e.message);
    return { success: false, error: e.message };
  }
});

// Generic store get/set for renderer preferences (e.g. nftGuideDismissed)
ipcMain.handle('store-get', async (event, key) => {
  return store.get(key);
});
ipcMain.handle('store-set', async (event, key, value) => {
  store.set(key, value);
});

ipcMain.handle('purge-nft-storage', async () => {
  try {
    // Clear image cache mappings + files
    try { nftDesktop.clearCache(); } catch (_) {}
    // Overwrite persisted NFT list with []
    try {
      const appDataPath = app.getPath('userData');
      const nftFile = path.join(appDataPath, 'photolynk_nfts.json');
      fs.writeFileSync(nftFile, JSON.stringify([], null, 2));
    } catch (_) {}
    // Overwrite persisted certificates list with []
    try {
      const appDataPath = app.getPath('userData');
      const certFile = path.join(appDataPath, 'nft_certificates.json');
      fs.writeFileSync(certFile, JSON.stringify([], null, 2));
    } catch (_) {}
    return { success: true };
  } catch (e) {
    safeConsole('log', '[NFT] Purge storage failed:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-nft-by-mint', async (event, mintAddress) => {
  return await nftDesktop.getNFTByMintAddress(mintAddress);
});

ipcMain.handle('fetch-ipfs-image', async (event, { cid }) => {
  const gateways = [
    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://w3s.link/ipfs/',
    'https://dweb.link/ipfs/',
  ];
  for (const gw of gateways) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(gw + cid, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(t);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get('content-type') || 'image/jpeg';
        return { success: true, dataUrl: `data:${ct};base64,${buf.toString('base64')}` };
      }
    } catch (e) { /* next gateway */ }
  }
  return { success: false, error: 'All gateways failed' };
});

ipcMain.handle('decrypt-nft-image', async (event, { imageUrl, thumbnailUrl, encryptionData }) => {
  try {
    if (!encryptionData || !encryptionData.wrappedKey) {
      return { success: false, error: 'Missing encryption data (no wrappedKey)' };
    }
    // Derive master key from credentials (same PBKDF2 as mobile + backup-client)
    const credentials = store.get('backupCredentials') || {};
    let masterKey = null;
    if (credentials.email && credentials.password) {
      // Use legacy MK creds for migrated wallet users (encryption key = original email+password)
      const mkEmail2 = (credentials.mk_email || credentials.email).toLowerCase().trim();
      const mkPassword2 = credentials.mk_password || credentials.password;
      masterKey = new Uint8Array(crypto.pbkdf2Sync(mkPassword2, mkEmail2, 30000, 32, 'sha256'));
    } else if (!encryptionData.transferNftKey) {
      return { success: false, error: 'Login credentials not available — log in first' };
    }

    // Prefer encrypted thumbnail (small, fast) over full image (may be data URI or multi-MB)
    const useThumb = !!(thumbnailUrl && encryptionData.thumbnailNonce);
    const downloadUrl = useThumb ? thumbnailUrl : imageUrl;
    const decryptNonce = useThumb ? encryptionData.thumbnailNonce : encryptionData.nonce;
    
    if (!downloadUrl || downloadUrl.startsWith('data:')) {
      // data: URIs can't be downloaded — need thumbnailUrl for on-chain encrypted
      if (!useThumb) {
        return { success: false, error: 'On-chain encrypted — no thumbnail available for decryption' };
      }
    }
    
    safeConsole('log', '[NFT] Decrypt:', useThumb ? 'encrypted thumbnail' : 'full image', downloadUrl?.slice(0, 80));

    // Download encrypted .bin from URL (with auth for StealthCloud URLs, IPFS gateway fallback)
    const axios = require('axios');
    const os = require('os');
    const tempPath = path.join(os.tmpdir(), `nft_dec_${Date.now()}.bin`);
    const downloadHeaders = {};
    const isCloud = downloadUrl.includes('stealthlynk.io') || downloadUrl.includes('nft.stealthlynk.io') || downloadUrl.includes('localhost');
    if (isCloud) {
      // Re-use cached token if still fresh (5 min TTL) to avoid 429 on /api/login
      const now = Date.now();
      if (global._scDecryptToken && global._scDecryptTokenTs && (now - global._scDecryptTokenTs) < 300000) {
        downloadHeaders['Authorization'] = `Bearer ${global._scDecryptToken}`;
      } else {
        try {
          if (credentials.baseUrl) {
            const loginResp = await axios.post(`${credentials.baseUrl}/api/login`, {
              email: credentials.email,
              password: credentials.password,
              device_uuid: credentials.deviceUuid || '',
            }, { timeout: 10000 });
            if (loginResp.data && loginResp.data.token) {
              global._scDecryptToken = loginResp.data.token;
              global._scDecryptTokenTs = Date.now();
              downloadHeaders['Authorization'] = `Bearer ${loginResp.data.token}`;
            }
          }
        } catch (authErr) {
          safeConsole('log', '[NFT] Decrypt auth failed:', authErr.message);
          // Use stale token as fallback if available
          if (global._scDecryptToken) {
            downloadHeaders['Authorization'] = `Bearer ${global._scDecryptToken}`;
          }
        }
      }
    }

    // Build list of URLs to try (IPFS gateway fallback for 403/429 errors)
    const _extractCid = (u) => { if (!u) return null; if (u.startsWith('ipfs://')) return u.slice(7).split('/')[0]; const idx = u.indexOf('/ipfs/'); return idx !== -1 ? u.slice(idx + 6).split('/')[0] : null; };
    const _cid = _extractCid(downloadUrl);
    const _fallbackGateways = ['https://w3s.link/ipfs/', 'https://nftstorage.link/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
    const urlsToTry = [downloadUrl];
    if (_cid && !isCloud) {
      for (const gw of _fallbackGateways) {
        const gwUrl = gw + _cid;
        if (gwUrl !== downloadUrl) urlsToTry.push(gwUrl);
      }
    }

    let downloaded = false;
    for (const tryUrl of urlsToTry) {
      try {
        safeConsole('log', '[NFT] Decrypt download try:', tryUrl.slice(0, 80));
        const response = await axios.get(tryUrl, { responseType: 'arraybuffer', timeout: 30000, headers: isCloud ? downloadHeaders : {} });
        fs.writeFileSync(tempPath, Buffer.from(response.data));
        downloaded = true;
        break;
      } catch (dlErr) {
        const status = dlErr.response?.status;
        safeConsole('log', '[NFT] Decrypt download failed:', status || dlErr.message, tryUrl.slice(0, 60));
        // Invalidate cached token on 401/403/429 so next attempt re-authenticates
        if (isCloud && (status === 401 || status === 403 || status === 429)) {
          global._scDecryptToken = null;
          global._scDecryptTokenTs = 0;
        }
        if (status !== 403 && status !== 429) break; // Only retry on 403/429 (IPFS gateways)
      }
    }
    if (!downloaded) {
      return { success: false, error: 'All download attempts failed (403/429)' };
    }

    // Decrypt
    const result = await nftDesktop.decryptNFTImage(
      tempPath,
      encryptionData.wrappedKey,
      encryptionData.wrapNonce,
      decryptNonce,
      masterKey,
      encryptionData.transferNftKey || null
    );

    // Clean up temp encrypted file
    try { fs.unlinkSync(tempPath); } catch (_) {}

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Return decrypted image as base64 data URL
    const decryptedData = fs.readFileSync(result.decryptedPath);
    const base64 = decryptedData.toString('base64');
    try { fs.unlinkSync(result.decryptedPath); } catch (_) {}

    return { success: true, dataUrl: 'data:image/jpeg;base64,' + base64 };
  } catch (e) {
    safeConsole('log', '[NFT] Decrypt failed:', e.message);
    return { success: false, error: e.message };
  }
});

// Push local NFTs to server so encryptionData/thumbnailUrl reach other devices
async function pushLocalNFTsToServer(serverUrl, headers, walletAddress = null) {
  try {
    const axios = require('axios');
    const normalizeWallet = (value) => value ? String(value).trim() : '';
    const walletNorm = normalizeWallet(walletAddress);
    const localNFTs = await nftDesktop.getStoredNFTs();
    if (!localNFTs || localNFTs.length === 0) return;
    const eligibleNFTs = walletNorm
      ? localNFTs.filter(n => normalizeWallet(n.ownerAddress) === walletNorm)
      : localNFTs;
    if (eligibleNFTs.length === 0) return;
    // Only push NFTs that have encryptionData or thumbnailUrl (the critical fields)
    const toSync = eligibleNFTs.filter(n => n.mintAddress && (n.encryptionData || n.thumbnailUrl)).map(n => {
      const copy = { ...n };
      delete copy.exifData;
      delete copy.metadata;
      delete copy.attributes;
      if (copy.imageUrl && copy.imageUrl.startsWith('data:') && !copy.imageUrl.startsWith('data:image/svg') && copy.imageUrl.length > 5000) delete copy.imageUrl;
      if (copy.arweaveUrl && copy.arweaveUrl.startsWith('data:') && !copy.arweaveUrl.startsWith('data:image/svg') && copy.arweaveUrl.length > 5000) delete copy.arweaveUrl;
      return copy;
    });
    if (toSync.length === 0) return;
    const BATCH = 2;
    let pushed = 0;
    for (let i = 0; i < toSync.length; i += BATCH) {
      const batch = toSync.slice(i, i + BATCH);
      try {
        await axios.post(`${serverUrl}/api/nft/sync`, { action: 'backup', nfts: batch }, { headers, timeout: 30000 });
        pushed += batch.length;
      } catch (batchErr) {
        safeConsole('log', '[NFT Sync] Batch', Math.floor(i / BATCH) + 1, 'failed:', batchErr.message);
      }
    }
    safeConsole('log', '[NFT Sync] Pushed', pushed, '/', toSync.length, 'NFTs with encryption data to server');
  } catch (e) {
    safeConsole('log', '[NFT Sync] Push failed:', e.message);
  }
}

ipcMain.handle('sync-nfts-from-server', async () => {
  const credentials = store.get('backupCredentials') || {};
  if (!credentials.baseUrl || !credentials.email || !credentials.password) {
    return { success: false, error: 'Not authenticated' };
  }
  // Re-authenticate to get a fresh token (stored token may be expired)
  try {
    const axios = require('axios');
    const loginResp = await axios.post(`${credentials.baseUrl}/api/login`, {
      email: credentials.email,
      password: credentials.password,
      device_uuid: credentials.deviceUuid || '',
    }, { timeout: 10000 });
    if (loginResp.data && loginResp.data.token) {
      store.set('backupCredentials', { ...credentials, token: loginResp.data.token });
      const authHeader = `Bearer ${loginResp.data.token}`;
      const headers = { Authorization: authHeader };
      if (credentials.deviceUuid) headers['X-Device-UUID'] = credentials.deviceUuid;
      const walletAddress = connectedWalletAddress || null;
      const result = await nftDesktop.syncNFTsFromServer(credentials.baseUrl, headers, walletAddress);
      // Remove locally-cached NFTs that were transferred out (matches mobile apps)
      if (walletAddress) {
        try {
          await nftDesktop.removeTransferredNFTs(walletAddress, credentials.baseUrl, headers);
        } catch (e) {
          safeConsole('log', '[NFT Sync] removeTransferredNFTs failed:', e.message);
        }
      }
      // Push the pruned wallet-scoped local NFTs back to server
      pushLocalNFTsToServer(credentials.baseUrl, headers, walletAddress).catch(e => safeConsole('log', '[NFT Sync] Background push failed:', e.message));
      return result;
    }
  } catch (loginErr) {
    console.log('[NFT Sync] Re-auth failed:', loginErr.message);
  }
  // Fallback: try with existing token
  const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
  const fallbackHeaders = { Authorization: authHeader };
  if (credentials.deviceUuid) fallbackHeaders['X-Device-UUID'] = credentials.deviceUuid;
  const walletAddress = connectedWalletAddress || null;
  const result = await nftDesktop.syncNFTsFromServer(credentials.baseUrl, fallbackHeaders, walletAddress);
  // Remove locally-cached NFTs that were transferred out (matches mobile apps)
  if (walletAddress) {
    try {
      await nftDesktop.removeTransferredNFTs(walletAddress, credentials.baseUrl, fallbackHeaders);
    } catch (e) {
      safeConsole('log', '[NFT Sync] removeTransferredNFTs failed:', e.message);
    }
  }
  pushLocalNFTsToServer(credentials.baseUrl, fallbackHeaders, walletAddress).catch(e => safeConsole('log', '[NFT Sync] Background push failed:', e.message));
  return result;
});

// Native clipboard write (works in data:text/html pages where navigator.clipboard is blocked)
ipcMain.handle('clipboard-write', (event, text) => {
  try { clipboard.writeText(text); return true; } catch (_) { return false; }
});

// Fetch rfc3161Token from NFT metadata URI (IPFS/Arweave) when token was stripped
ipcMain.handle('fetch-rfc3161-token', async (event, metadataUrl, encryptionData) => {
  if (!metadataUrl) return { token: null };
  
  // Helper: download raw bytes from URL with timeout
  const downloadBuffer = (url) => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) { return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

  // Convert ipfs:// to gateway URL and build fallback list
  const _extractCid = (u) => {
    if (!u) return null;
    if (u.startsWith('ipfs://')) return u.slice(7).split('/')[0].split('?')[0];
    const idx = u.indexOf('/ipfs/');
    return idx !== -1 ? u.slice(idx + 6).split('/')[0].split('?')[0] : null;
  };
  const cid = _extractCid(metadataUrl);
  const gateways = ['https://ipfs.io/ipfs/', 'https://w3s.link/ipfs/', 'https://nftstorage.link/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
  let urlsToTry;
  if (cid) {
    urlsToTry = gateways.map(g => g + cid);
  } else if (metadataUrl.startsWith('http')) {
    urlsToTry = [metadataUrl];
  } else {
    safeConsole('log', '[Certs] fetch-rfc3161-token: unsupported URL scheme:', metadataUrl.slice(0, 60));
    return { token: null };
  }
  
  try {
    // Try each gateway until one succeeds
    let buf = null;
    for (const url of urlsToTry) {
      try {
        buf = await downloadBuffer(url);
        if (buf && buf.length > 0) {
          safeConsole('log', '[Certs] fetch-rfc3161-token downloaded', buf.length, 'bytes from', url.slice(0, 60));
          break;
        }
      } catch (dlErr) {
        safeConsole('log', '[Certs] fetch-rfc3161-token gateway failed:', url.slice(0, 50), dlErr.message);
        buf = null;
      }
    }
    if (!buf || buf.length === 0) return { token: null };
    
    // Try JSON parse first (unencrypted metadata)
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
    
    // If JSON parse fails and we have encryption data, try decrypting
    if (!json && encryptionData?.metadataNonce) {
      try {
        const credentials = store.get('backupCredentials') || {};
        // Derive masterKey from email/password via PBKDF2 (same as mint + decrypt paths)
        if (credentials.email && credentials.password) {
          // Use legacy MK creds for migrated wallet users
          const mkEmail3 = (credentials.mk_email || credentials.email).toLowerCase().trim();
          const mkPassword3 = credentials.mk_password || credentials.password;
          const masterKey = new Uint8Array(crypto.pbkdf2Sync(mkPassword3, mkEmail3, 30000, 32, 'sha256'));
          json = nftDesktop.decryptMetadataJSON(buf, encryptionData, masterKey);
          if (json) safeConsole('log', '[Certs] Decrypted encrypted metadata for RFC3161 recovery');
        } else {
          safeConsole('log', '[Certs] Cannot decrypt metadata — no login credentials stored');
        }
      } catch (decErr) {
        safeConsole('log', '[Certs] Metadata decryption failed:', decErr.message);
      }
    }
    
    if (!json) return { token: null };
    const token = json?.properties?.certificate?.rfc3161?.tsaTokenBase64 || null;
    const c2pa = json?.properties?.c2pa || null;
    // Also extract hashes from fetched metadata attributes (matches mobile recovery paths)
    const fAttrs = json?.attributes || [];
    const getAttrVal = (name) => { const a = fAttrs.find(x => x.trait_type === name); return a ? a.value : null; };
    return {
      token, c2pa,
      contentHash: getAttrVal('Content Hash'),
      exifRawHash: getAttrVal('EXIF Raw Hash'),
      exifHash: getAttrVal('EXIF Hash'),
      exifBindingHash: getAttrVal('EXIF Binding Hash'),
      cameraHash: getAttrVal('Camera Hash'),
    };
  } catch (e) {
    safeConsole('log', '[Certs] fetch-rfc3161-token error:', e.message);
    return { token: null };
  }
});

// Save enriched certs to local file (preserves rfc3161Token/c2paManifest after enrichment)
// IMPORTANT: merges enrichment INTO existing file — caller may have ownership-filtered subset
ipcMain.handle('save-enriched-certs', async (event, certs) => {
  try {
    const filePath = nftDesktop.getCertsFilePath ? nftDesktop.getCertsFilePath() : null;
    if (!filePath) return { success: false };
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Read existing certs so we don't destroy entries the caller didn't have (ownership-filtered)
    let existing = [];
    try {
      if (fs.existsSync(filePath)) existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) || [];
    } catch (_) {}
    // Build lookup from incoming enriched certs
    const enrichedById = {};
    const enrichedByMint = {};
    for (const c of certs) {
      if (c.id) enrichedById[c.id] = c;
      if (c.mintAddress) enrichedByMint[c.mintAddress] = c;
    }
    // Merge enrichment fields into existing certs (preserves certs not in the incoming set)
    const ENRICH_KEYS = ['rfc3161Token','c2paManifest','hasRfc3161','hasC2pa','contentHash','exifHash',
      'exifRawHash','exifBindingHash','cameraHash','storageType','encrypted','watermarked','license'];
    for (const ec of existing) {
      const src = (ec.id ? enrichedById[ec.id] : null) || (ec.mintAddress ? enrichedByMint[ec.mintAddress] : null);
      if (!src) continue;
      for (const k of ENRICH_KEYS) { if (src[k] && !ec[k]) ec[k] = src[k]; }
    }
    // Append any new certs that weren't in the existing file
    const existingIds = new Set(existing.map(c => c.id).filter(Boolean));
    const existingMints = new Set(existing.map(c => c.mintAddress).filter(Boolean));
    for (const c of certs) {
      if (c.id && existingIds.has(c.id)) continue;
      if (c.mintAddress && existingMints.has(c.mintAddress)) continue;
      existing.push(c);
    }
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    safeConsole('log', '[Certs] Saved', existing.length, 'enriched certs to', filePath);
    return { success: true };
  } catch (e) {
    safeConsole('log', '[Certs] Save enriched error:', e.message);
    return { success: false };
  }
});

// Certificates handlers
ipcMain.handle('get-certificates', async () => {
  // Helper: read local cert file + server-side cert file (tray IS the server)
  // Cross-enriches rfc3161Token/c2paManifest between sources so the token is never lost
  function readLocalCerts() {
    const allCerts = [];
    const seenIds = new Set();
    const certById = {};
    const ENRICH_FIELDS = ['rfc3161Token','c2paManifest','hasRfc3161','hasC2pa','contentHash','exifHash',
      'exifRawHash','exifBindingHash','cameraHash','storageType','encrypted','watermarked','license','metadataUrl'];
    // Helper: add cert or cross-enrich if duplicate
    const addOrEnrich = (c) => {
      if (!c.id) return;
      if (seenIds.has(c.id)) {
        // Cross-enrich: copy fields from this source into the already-seen cert (and vice-versa)
        const existing = certById[c.id];
        if (existing) {
          for (const k of ENRICH_FIELDS) {
            if (c[k] && !existing[k]) existing[k] = c[k];
          }
        }
        return;
      }
      allCerts.push(c); seenIds.add(c.id); certById[c.id] = c;
    };
    // 1. Tray's own local cert file
    try {
      const localPath = nftDesktop.getCertsFilePath ? nftDesktop.getCertsFilePath() : null;
      if (localPath && fs.existsSync(localPath)) {
        const certs = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        for (const c of certs) addOrEnrich(c);
      }
    } catch (_) {}
    // 2. Server-side cert files (cloud/nft/<userKey>/certificates.json) — tray has direct access
    //    These disk files preserve rfc3161Token + c2paManifest (DISK_SAFE_KEYS on server)
    try {
      const nftBaseDir = path.join(app.getPath('userData'), 'cloud', 'nft');
      if (fs.existsSync(nftBaseDir)) {
        const userDirs = fs.readdirSync(nftBaseDir);
        for (const dir of userDirs) {
          const certFile = path.join(nftBaseDir, dir, 'certificates.json');
          if (fs.existsSync(certFile)) {
            try {
              const certs = JSON.parse(fs.readFileSync(certFile, 'utf8'));
              for (const c of certs) addOrEnrich(c);
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    safeConsole('log', '[Certs IPC] readLocalCerts found', allCerts.length, 'total certs');
    return allCerts;
  }
  try {
    const credentials = store.get('backupCredentials') || {};
    if (credentials.baseUrl && credentials.token) {
      const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
      const reqHeaders = { Authorization: authHeader };
      if (credentials.deviceUuid) reqHeaders['X-Device-UUID'] = credentials.deviceUuid;
      const https = require('https');
      const http = require('http');
      const url = new URL(`${credentials.baseUrl}/api/nft/certificates`);
      const mod = url.protocol === 'https:' ? https : http;
      const serverCerts = await new Promise((resolve) => {
        const req = mod.get(url.href, { headers: reqHeaders, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.certificates || []);
            } catch (e) { resolve([]); }
          });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
      });
      // Merge: LOCAL disk certs are primary (they preserve rfc3161Token + c2paManifest).
      // Server API certs are secondary — the API strips large blobs for mobile OOM safety.
      const localCerts = readLocalCerts();
      safeConsole('log', '[Certs IPC] Server returned', serverCerts.length, 'certs, local file has', localCerts.length, 'certs');
      const localById = {};
      const localByMint = {};
      for (const lc of localCerts) {
        if (lc.id) localById[lc.id] = lc;
        if (lc.mintAddress) localByMint[lc.mintAddress] = lc;
      }
      // Enrich local certs with any fields the server has that local doesn't (e.g. new fields added server-side)
      for (const sc of serverCerts) {
        const lc = (sc.id ? localById[sc.id] : null) || (sc.mintAddress ? localByMint[sc.mintAddress] : null);
        if (!lc) continue;
        // Fill gaps in local from server (but NEVER overwrite local rfc3161Token/c2paManifest with empty)
        if (sc.hasRfc3161 && !lc.hasRfc3161) lc.hasRfc3161 = true;
        if (sc.hasC2pa && !lc.hasC2pa) lc.hasC2pa = true;
        if (sc.encrypted && !lc.encrypted) lc.encrypted = true;
        if (sc.watermarked && !lc.watermarked) lc.watermarked = true;
        if (sc.license && !lc.license) lc.license = sc.license;
        if (sc.storageType && !lc.storageType) lc.storageType = sc.storageType;
        if (sc.contentHash && !lc.contentHash) lc.contentHash = sc.contentHash;
        if (sc.exifHash && !lc.exifHash) lc.exifHash = sc.exifHash;
        if (sc.cameraHash && !lc.cameraHash) lc.cameraHash = sc.cameraHash;
        // If local has hasRfc3161 flag but server doesn't have it (and local has no token), clear the stale flag
        // This prevents the permanent "Recovering..." state when the flag was set but token is unrecoverable
        if (lc.hasRfc3161 && !lc.rfc3161Token && !sc.hasRfc3161) { lc.hasRfc3161 = false; }
      }
      // Add server-only certs that don't exist locally (e.g. minted on another device)
      const localIds = new Set(localCerts.map(c => c.id));
      const localMints = new Set(localCerts.map(c => c.mintAddress).filter(Boolean));
      const serverOnly = serverCerts.filter(c => !localIds.has(c.id) && !(c.mintAddress && localMints.has(c.mintAddress)));
      safeConsole('log', '[Certs IPC] Server-only certs:', serverOnly.length);
      const merged = [...localCerts, ...serverOnly];
      // Sort by newest first before returning
      merged.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
      return { certificates: merged };
    }
    // No server credentials — return local only
    const localOnly = readLocalCerts();
    safeConsole('log', '[Certs IPC] No server credentials, local-only:', localOnly.length);
    // Sort by newest first before returning
    localOnly.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
    return { certificates: localOnly };
  } catch (e) {
    safeConsole('log', '[Certs] Fetch error:', e.message);
    const fallbackCerts = readLocalCerts();
    // Sort by newest first before returning
    fallbackCerts.sort((a, b) => new Date(b.createdAt || b.issuedAt || 0) - new Date(a.createdAt || a.issuedAt || 0));
    return { certificates: fallbackCerts };
  }
});

// Backup all local+server-side certificates to StealthCloud (bidirectional sync)
ipcMain.handle('backup-certificates', async () => {
  try {
    // Gather certs from all local sources (tray file + server-side files)
    const allCerts = [];
    const seenIds = new Set();
    // 1. Tray's own local cert file
    try {
      const localPath = nftDesktop.getCertsFilePath ? nftDesktop.getCertsFilePath() : null;
      if (localPath && fs.existsSync(localPath)) {
        const c = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        for (const cert of c) { if (cert.id && !seenIds.has(cert.id)) { allCerts.push(cert); seenIds.add(cert.id); } }
      }
    } catch (_) {}
    // 2. Server-side cert files
    try {
      const nftBaseDir = path.join(app.getPath('userData'), 'cloud', 'nft');
      if (fs.existsSync(nftBaseDir)) {
        for (const dir of fs.readdirSync(nftBaseDir)) {
          const certFile = path.join(nftBaseDir, dir, 'certificates.json');
          if (fs.existsSync(certFile)) {
            try {
              const c = JSON.parse(fs.readFileSync(certFile, 'utf8'));
              for (const cert of c) { if (cert.id && !seenIds.has(cert.id)) { allCerts.push(cert); seenIds.add(cert.id); } }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    if (allCerts.length === 0) return { success: true, count: 0 };
    const credentials = store.get('backupCredentials') || {};
    if (!credentials.baseUrl || !credentials.token) return { success: false, error: 'No credentials' };
    const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
    const axios = require('axios');
    // Whitelist only slim fields to avoid 413 and prevent server-side bloat
    const SLIM_KEYS = ['id','name','mintAddress','txSignature','creatorWallet','ownerAddress',
      'issuedAt','createdAt','edition','license','contentHash','exifHash','cameraHash',
      'exifRawHash','exifBindingHash','rfc3161Policy','mintedAt',
      'hasRfc3161','hasC2pa','encrypted','watermarked','storageType','nftType','isCompressed',
      'rfc3161Tsa','metadataUrl','description','version','type','imageUrl','certificationMode'];
    const lightCerts = allCerts.map(c => {
      const lc = {};
      for (const k of SLIM_KEYS) { if (c[k] !== undefined) lc[k] = c[k]; }
      if (c.rfc3161Token) lc.hasRfc3161 = true;
      if (c.c2paManifest) lc.hasC2pa = true;
      return lc;
    });
    await axios.post(`${credentials.baseUrl}/api/nft/certificates`, {
      action: 'backup', certificates: lightCerts,
    }, { headers: { Authorization: authHeader, ...(credentials.deviceUuid ? { 'X-Device-UUID': credentials.deviceUuid } : {}) }, timeout: 10000 });
    safeConsole('log', '[Certs] Backed up', allCerts.length, 'certs to StealthCloud');
    return { success: true, count: allCerts.length };
  } catch (e) {
    safeConsole('log', '[Certs] Backup failed:', e.message);
    return { success: false, error: e.message };
  }
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
    const rpcUrl = process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    
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

// Real-time NFT cost estimate — fully synchronous, never blocks main process
ipcMain.handle('estimate-nft-costs', (event, { nftType, storageOption, filePath, edition } = {}) => {
  try {
    let fileSizeBytes = 0;
    if (filePath) {
      try {
        fileSizeBytes = fs.statSync(filePath).size;
      } catch (e) {
        fileSizeBytes = 0;
      }
    }
    return nftDesktop.estimateNftCostsRealtime({ nftType, storageOption, fileSizeBytes, edition });
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
      --bg-primary: #060608;
      --bg-card: rgba(17, 17, 20, 0.9);
      --bg-input: rgba(6, 6, 8, 0.9);
      --accent: #03E1FF;           /* Ocean blue - main accent */
      --accent-hover: #02C4E0;
      --text-primary: #F0F0F5;
      --text-secondary: #8888A0;
      --text-muted: #55556A;
      --border: rgba(37, 37, 48, 0.8);
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
  exifBackfillBusy();
  try {
    // Save credentials for next time (preserve pairing fields: device_uuid, mk_email, mk_password)
    const prevCreds = store.get('backupCredentials') || {};
    store.set('backupCredentials', {
      email: config.email,
      password: config.password,
      remoteAddress: config.remoteAddress,
      remotePort: config.remotePort,
      ...(prevCreds.device_uuid ? { device_uuid: prevCreds.device_uuid } : {}),
      ...(prevCreds.mk_email ? { mk_email: prevCreds.mk_email } : {}),
      ...(prevCreds.mk_password ? { mk_password: prevCreds.mk_password } : {}),
    });
    // Inject pairing fields into config so backup-client gets correct UUID + MK creds
    if (prevCreds.device_uuid && !config.device_uuid) config.device_uuid = prevCreds.device_uuid;
    if (prevCreds.mk_email && !config.mk_email) config.mk_email = prevCreds.mk_email;
    if (prevCreds.mk_password && !config.mk_password) config.mk_password = prevCreds.mk_password;
    
    // For StealthCloud, check subscription first
    if (config.destination === 'stealthcloud') {
      const { DesktopBackupClient } = require('./backup-client');
      const checkClient = new DesktopBackupClient(config, (progress) => {
        event.reply('backup-progress', progress);
      });
      
      // Login first to get token
      await checkClient.login();
      
      // Store token and baseUrl for NFT StealthCloud uploads
      const stealthCloudBaseUrl = 'https://stealthlynk.io';
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
        exifBackfillIdle();
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
    const extensions = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf', '.pef', '.srw', '.raw', '.psd', '.psb', '.exr', '.hdr',
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
      exifBackfillIdle();
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
    exifBackfillIdle();
    event.reply('backup-complete', { 
      message: `Backup Complete\nUploaded: ${result.uploaded}\nSkipped: ${totalSkipped}`
    });
    maybeStartExifBackfill();
    
  } catch (error) {
    exifBackfillIdle();
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
  exifBackfillIdle();
});

// IPC handlers for sync
let activeSyncClient = null;

ipcMain.on('start-desktop-sync', async (event, config) => {
  exifBackfillBusy();
  try {
    safeConsole('log', `[SYNC] Config received:`, JSON.stringify({ source: config.source, email: config.email, downloadPath: config.downloadPath, hasPassword: !!config.password }));
    
    // Save credentials (preserve pairing fields: device_uuid, mk_email, mk_password)
    const prevSyncCreds = store.get('backupCredentials') || {};
    store.set('backupCredentials', {
      email: config.email,
      password: config.password,
      remoteAddress: config.remoteAddress,
      remotePort: config.remotePort,
      ...(prevSyncCreds.device_uuid ? { device_uuid: prevSyncCreds.device_uuid } : {}),
      ...(prevSyncCreds.mk_email ? { mk_email: prevSyncCreds.mk_email } : {}),
      ...(prevSyncCreds.mk_password ? { mk_password: prevSyncCreds.mk_password } : {}),
    });
    // Inject pairing fields into config so sync-client gets correct UUID + MK creds
    if (prevSyncCreds.device_uuid && !config.device_uuid) config.device_uuid = prevSyncCreds.device_uuid;
    if (prevSyncCreds.mk_email && !config.mk_email) config.mk_email = prevSyncCreds.mk_email;
    if (prevSyncCreds.mk_password && !config.mk_password) config.mk_password = prevSyncCreds.mk_password;
    
    // Use device_uuid from pairing if available (critical for wallet-migrated users),
    // otherwise compute from email:password
    const userUuid = config.device_uuid || computeUserUuidSync(config.email, config.password);
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
      const stealthCloudBaseUrl = 'https://stealthlynk.io';
      store.set('backupCredentials', {
        ...store.get('backupCredentials'),
        baseUrl: stealthCloudBaseUrl,
        token: activeSyncClient.token,
        deviceUuid: activeSyncClient.deviceUuid,
      });
    }
    activeSyncClient = null;
    
    stopBackupPowerSaveBlocker();
    
    exifBackfillIdle();
    event.reply('sync-complete', {
      message: `Sync Complete\nDownloaded: ${result.downloaded}\nSkipped: ${result.skipped}`
    });
    maybeStartExifBackfill();
    
  } catch (error) {
    exifBackfillIdle();
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
  exifBackfillIdle();
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

// Hide dock icon on macOS (tray-only app). File picker now uses HTML <input type="file">
// in the renderer so it works even with dock hidden (no NSOpenPanel dependency).
if (process.platform === 'darwin' && app.dock) {
  try {
    app.dock.hide();
  } catch (e) {
    // Ignore - dock may not be available
  }
}
