const { app, Tray, Menu, shell, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let tray = null;
let serverProcess = null;
let serverPath = null;
let uploadsPath = null;

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
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  
  // Also kill any node process on port 3000 (in case it's still running)
  const { exec } = require('child_process');
  exec('lsof -ti:3000 | xargs kill -9', (error) => {
    if (error) {
      console.log('No server process found on port 3000');
    } else {
      console.log('Server stopped');
    }
    
    // Update menu after a delay to ensure port is released
    setTimeout(() => {
      updateTrayMenu();
    }, 500);
  });
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
  });
}

app.whenReady().then(() => {
  // Create tray icon
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  
  // Resize for tray (16x16 or 32x32)
  const trayIcon = icon.resize({ width: 16, height: 16 });
  
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
