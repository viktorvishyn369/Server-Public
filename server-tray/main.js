const { app, Tray, Menu, shell, nativeImage, Notification } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

let tray = null;
let serverProcess = null;
let serverPath = null;
let uploadsPath = null;
let updateAvailable = false;
let latestVersion = null;
let updateStatus = 'Not checked yet';
let startOnBoot = false;

const store = new Store({ name: 'photosync-tray' });

// Always use the actual server directory (not the bundled one)
// This ensures uploads folder is in the right place
serverPath = path.join(__dirname, '..', 'server');
uploadsPath = path.join(serverPath, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

console.log('Server path:', serverPath);
console.log('Uploads path:', uploadsPath);

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

  console.log('Starting server from:', serverPath);
  
  // Use pipe for stdio to keep process alive
  serverProcess = spawn('node', ['server.js'], {
    cwd: serverPath,
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
  
  // Force kill any node process on port 3000
  const { execSync } = require('child_process');
  try {
    const pid = execSync('lsof -ti:3000').toString().trim();
    if (pid) {
      execSync(`kill -9 ${pid}`);
      console.log('Server stopped (PID:', pid, ')');
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

function checkForUpdates() {
  console.log('Checking for updates...');
  try {
    const result = execSync('npm run check-update', { 
      cwd: serverPath,
      encoding: 'utf8'
    });
    
    const match = result.match(/"version":"([^"]+)"/);
    if (match && result.includes('"available":true')) {
      latestVersion = match[1];
      updateAvailable = true;
      updateStatus = `Update available: v${latestVersion}`;
      
      new Notification({
        title: 'PhotoSync Update Available',
        body: `Version ${latestVersion} is available!`,
        silent: false
      }).show();
      
      console.log(`Update available: v${latestVersion}`);
    } else {
      updateAvailable = false;
      updateStatus = 'Up to date';
      new Notification({
        title: 'PhotoSync Up to Date',
        body: 'You are running the latest version',
        silent: false
      }).show();
      console.log('Already on latest version');
    }
    
    updateTrayMenu();
  } catch (error) {
    console.error('Error checking for updates:', error);
    updateStatus = 'Update check failed';
  }
}

function installUpdate() {
  console.log('Installing update...');
  
  new Notification({
    title: 'PhotoSync Update',
    body: 'Installing update... Server and tray will restart.',
    silent: false
  }).show();
  
  stopServer();
  
  setTimeout(() => {
    try {
      // Project root (contains server and server-tray)
      const projectRoot = path.join(serverPath, '..');

      console.log('Pulling latest code for full project...');
      execSync('git pull origin main', {
        cwd: projectRoot,
        stdio: 'inherit'
      });

      console.log('Installing server dependencies...');
      execSync('npm install --production', {
        cwd: serverPath,
        stdio: 'inherit'
      });

      console.log('Installing tray dependencies...');
      const trayDir = __dirname; // server-tray directory
      execSync('npm install', {
        cwd: trayDir,
        stdio: 'inherit'
      });

      new Notification({
        title: 'PhotoSync Updated',
        body: 'Update installed. Restarting tray and server...',
        silent: false
      }).show();

      // Relaunch the tray app so new code is loaded on all platforms
      updateAvailable = false;
      updateTrayMenu();

      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 2000);
    } catch (error) {
      console.error('Update failed:', error);
      new Notification({
        title: 'PhotoSync Update Failed',
        body: 'Failed to install update. Check logs.',
        silent: false
      }).show();
      // Try to restart server with existing version
      startServer();
    }
  }, 1000);
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
        label: startOnBoot ? '🟢 Start on Boot' : '🔴 Start on Boot',
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
  
  // Check for updates on startup (after 5 seconds)
  setTimeout(() => {
    checkForUpdates();
  }, 5000);
  
  // Check for updates every 24 hours
  setInterval(() => {
    checkForUpdates();
  }, 24 * 60 * 60 * 1000);
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
