const { app, Tray, Menu, shell, nativeImage, Notification, clipboard } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

let tray = null;
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

const store = new Store({ name: 'photosync-tray' });

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
          'Name=PhotoSync Server',
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
        title: 'PhotoSync Server',
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
    if (hay.includes('/PhotoSync/server/server.js')) return true;
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
      safeConsole('log', 'Stopped PhotoSync listener on port 3000 (PID:', pid, ')');
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
    shell.openExternal('https://github.com/viktorvishyn369/PhotoSync/releases');
  } catch (e) {
    // ignore
  }
}

function installUpdate() {
  // Packaged apps should update as an app (not via git/npm scripts).
  // Open GitHub Releases so the user can download the latest installer.
  try {
    shell.openExternal('https://github.com/viktorvishyn369/PhotoSync/releases');
  } catch (e) {
    // ignore
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

    const ipSubmenu = ips.length > 0
      ? [
          { label: 'Click an address to copy', enabled: false },
          { type: 'separator' },
          ...ips.map((ip) => ({
            label: ip,
            click: () => {
              clipboard.writeText(ip);
              notifyCopied(ip);
            }
          }))
        ]
      : [{ label: 'No local IPv4 address detected', enabled: false }];

    const menuTemplate = [
      {
        label: currentVersion ? `PhotoSync Server v${currentVersion}` : 'PhotoSync Server',
        enabled: false
      },
      {
        label: isRunning ? 'Status: Running' : 'Status: Stopped',
        enabled: false
      },
      {
        label: updateStatus,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Local IP Addresses',
        submenu: ipSubmenu
      },
      { type: 'separator' },
      {
        label: 'Open Files Location',
        click: openUploadsFolder
      },
      { type: 'separator' },
      {
        label: 'Server',
        submenu: [
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
        ]
      },
      {
        label: 'Start on Boot',
        type: 'checkbox',
        checked: !!startOnBoot,
        click: (menuItem) => {
          setAutostart(!!menuItem.checked);
          updateTrayMenu();
        }
      },
      { type: 'separator' },
      
    ];
    
    // Add update menu items
    if (updateAvailable) {
      menuTemplate.push({
        label: `Update Available (v${latestVersion})`,
        click: installUpdate
      });
    }
    
    menuTemplate.push({
      label: 'Check for Updates…',
      click: checkForUpdates
    });
    
    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({
      label: 'Quit',
      click: () => {
        stopServer();
        app.quit();
      }
    });

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    tray.setContextMenu(contextMenu);
    
    // Update tooltip
    let tooltip = currentVersion ? `PhotoSync Server v${currentVersion}` : 'PhotoSync Server';
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
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  
  // Resize for tray - macOS menu bar icons are typically 22x22 points
  const trayIcon = icon.resize({ width: 22, height: 22 });
  
  tray = new Tray(trayIcon);
  tray.setToolTip('PhotoSync Server');
  
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
  stopServer();
});

// Hide dock icon on macOS
if (process.platform === 'darwin') {
  app.dock.hide();
}
