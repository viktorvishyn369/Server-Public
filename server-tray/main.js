const { app, Tray, Menu, shell, nativeImage, Notification } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray = null;
let serverProcess = null;
let serverPath = null;
let uploadsPath = null;
let updateAvailable = false;
let latestVersion = null;

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
      
      new Notification({
        title: 'PhotoSync Update Available',
        body: `Version ${latestVersion} is available!`,
        silent: false
      }).show();
      
      console.log(`Update available: v${latestVersion}`);
    } else {
      updateAvailable = false;
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
  }
}

function installUpdate() {
  console.log('Installing update...');
  
  new Notification({
    title: 'PhotoSync Update',
    body: 'Installing update... Server will restart.',
    silent: false
  }).show();
  
  stopServer();
  
  setTimeout(() => {
    try {
      execSync('npm run update', { 
        cwd: serverPath,
        stdio: 'inherit'
      });
      
      new Notification({
        title: 'PhotoSync Updated',
        body: 'Update installed successfully! Restarting server...',
        silent: false
      }).show();
      
      setTimeout(() => {
        startServer();
        updateAvailable = false;
        updateTrayMenu();
      }, 2000);
    } catch (error) {
      console.error('Update failed:', error);
      new Notification({
        title: 'PhotoSync Update Failed',
        body: 'Failed to install update. Check logs.',
        silent: false
      }).show();
      startServer(); // Restart with old version
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
