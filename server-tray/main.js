const { app, Tray, Menu, shell, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray = null;
let serverProcess = null;
let serverPath = null;
let uploadsPath = null;

// Determine if we're in development or production
const isDev = !app.isPackaged;

if (isDev) {
  // Development: use ../server
  serverPath = path.join(__dirname, '..', 'server');
} else {
  // Production: server is in resources
  serverPath = path.join(process.resourcesPath, 'server');
}

uploadsPath = path.join(serverPath, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
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

  updateTrayMenu();
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    console.log('Server stopped');
    updateTrayMenu();
  }
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

function updateTrayMenu() {
  const isRunning = serverProcess !== null;
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRunning ? '● Server Running' : '○ Server Stopped',
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
      label: 'Quit',
      click: () => {
        stopServer();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  
  // Update tooltip
  tray.setToolTip(isRunning ? 'PhotoSync Server - Running' : 'PhotoSync Server - Stopped');
}

app.whenReady().then(() => {
  // Create tray icon
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  
  // Resize for tray (16x16 or 32x32)
  const trayIcon = icon.resize({ width: 16, height: 16 });
  
  tray = new Tray(trayIcon);
  tray.setToolTip('PhotoSync Server');
  
  updateTrayMenu();
  
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
