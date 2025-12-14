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
let updateAvailable = false;
let latestVersion = null;
let updateStatus = 'Updates: GitHub Releases';
let startOnBoot = false;

const store = new Store({ name: 'photosync-tray' });

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

  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }

  if (!fs.existsSync(cloudUsersPath)) {
    fs.mkdirSync(cloudUsersPath, { recursive: true });
  }

  console.log('Server path:', serverPath);
  console.log('Uploads path:', uploadsPath);
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
      console.log('Login item settings updated. openAtLogin =', enabled);
    } catch (err) {
      console.error('Failed to update login item settings:', err);
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
        console.log('Created autostart entry at', desktopFile);
      } else {
        if (fs.existsSync(desktopFile)) {
          fs.unlinkSync(desktopFile);
          console.log('Removed autostart entry at', desktopFile);
        }
      }
    } catch (err) {
      console.error('Failed to configure Linux autostart:', err);
    }
  }
}

function startServer() {
  if (serverProcess) {
    console.log('Server already running');
    return;
  }

  if (!serverPath || !uploadsPath || !dbPath) {
    initPaths();
  }

  console.log('Starting server from:', serverPath);
  
  const serverEntry = path.join(serverPath, 'server.js');
  const nodeModulesPaths = (app && app.isPackaged)
    ? [
        path.join(process.resourcesPath, 'app.asar', 'node_modules'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
      ]
    : [path.join(__dirname, 'node_modules')];

  const nodePath = [...nodeModulesPaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    NODE_PATH: nodePath,
    UPLOAD_DIR: uploadsPath,
    DB_PATH: dbPath,
    CLOUD_DIR: path.join(getDataRoot(), 'cloud')
  };

  // Use Electron's embedded Node runtime so system Node is not required.
  // `--runAsNode` makes Electron behave like Node.js.
  serverProcess = spawn(process.execPath, ['--runAsNode', serverEntry], {
    cwd: serverPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  // Log server output
  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
    serverProcess = null;
    updateTrayMenu();
  });

  serverProcess.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
    updateTrayMenu();
  });

  // Update menu after a delay to ensure server is fully started
  setTimeout(() => {
    updateTrayMenu();
  }, 2000);
}

function stopServer() {
  console.log('Stopping server...');
  
  // Kill the server process
  if (serverProcess) {
    try {
      serverProcess.kill('SIGKILL');
      serverProcess = null;
    } catch (e) {
      console.error('Error killing server process:', e);
    }
  }
  
  // Force kill any process on port 3000 (best-effort)
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
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          console.log('Server stopped (PID:', pid, ')');
        } catch (e) {
          // ignore
        }
      }
      if (pids.size === 0) console.log('No server process found on port 3000');
    } else {
      const pid = execSync('lsof -ti:3000', { encoding: 'utf8' }).toString().trim();
      if (pid) {
        execSync(`kill -9 ${pid}`);
        console.log('Server stopped (PID:', pid, ')');
      } else {
        console.log('No server process found on port 3000');
      }
    }
  } catch (error) {
    console.log('No server process found on port 3000');
  }
  
  // Update menu after a delay to ensure port is released
  setTimeout(() => {
    updateTrayMenu();
  }, 1000);
}

function restartServer() {
  console.log('Restarting server...');
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
  const ips = [];
  Object.keys(nets || {}).forEach((name) => {
    const entries = nets[name] || [];
    entries.forEach((net) => {
      if (!net) return;
      if (net.family !== 'IPv4') return;
      if (net.internal) return;
      if (!net.address) return;
      ips.push(net.address);
    });
  });
  return Array.from(new Set(ips)).sort();
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
    const ips = getLocalIpAddresses();
    const menuTemplate = [
      {
        label: isRunning ? '🟢 Server Running' : '⚪ Server Stopped',
        enabled: false
      },
      {
        label: `Update status: ${updateStatus}`,
        enabled: false
      },
      { type: 'separator' },
      ...(ips.length > 0
        ? [
            { label: 'Local IP (click to copy)', enabled: false },
            ...ips.map((ip) => ({
              label: ip,
              click: () => {
                clipboard.writeText(ip);
                notifyCopied(ip);
              }
            }))
          ]
        : [
            { label: 'No local IPv4 address detected', enabled: false }
          ]),
      { type: 'separator' },
      {
        label: 'Open Files Location',
        click: openUploadsFolder
      },
      { type: 'separator' },
      {
        label: 'Restart Server',
        click: restartServer,
        enabled: isRunning
      },
      {
        label: 'Stop Server',
        click: stopServer,
        enabled: isRunning
      },
      {
        label: 'Start Server',
        click: startServer,
        enabled: !isRunning
      },
      { type: 'separator' },
      {
        label: startOnBoot ? 'Start on Boot: ON ✅' : 'Start on Boot: OFF ⛔',
        click: () => {
          const newValue = !startOnBoot;
          setAutostart(newValue);
          updateTrayMenu();
        }
      },
      { type: 'separator' }
    ];
    
    // Add update menu items
    if (updateAvailable) {
      menuTemplate.push({
        label: `✨ Update Available (v${latestVersion})`,
        click: installUpdate
      });
    }
    
    menuTemplate.push({
      label: 'Check for Updates',
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
    let tooltip = isRunning ? 'PhotoSync Server - Running' : 'PhotoSync Server - Stopped';
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
