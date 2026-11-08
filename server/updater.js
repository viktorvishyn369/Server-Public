const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CURRENT_VERSION = '2.0.0';
// Releases moved to Server-Public; PhotoLynk-PoC-v1 still hosts older releases.
const GITHUB_REPOS = ['viktorvishyn369/Server-Public', 'viktorvishyn369/PhotoLynk-PoC-v1'];
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

class Updater {
  constructor() {
    this.updateAvailable = false;
    this.latestVersion = null;
    this.downloadUrl = null;
  }

  // Check for updates from GitHub releases
  async checkForUpdates() {
    let best = null;
    for (const repo of GITHUB_REPOS) {
      const release = await this.fetchLatestRelease(repo);
      if (release && release.tag_name) {
        const v = release.tag_name.replace('v', '');
        if (!best || this.isNewerVersion(v, best.version)) {
          best = { release, version: v, repo };
        }
      }
    }

    if (!best) {
      console.log('ℹ️  No releases found on GitHub yet');
      return {
        available: false,
        version: CURRENT_VERSION
      };
    }

    console.log(`Current version: ${CURRENT_VERSION}`);
    console.log(`Latest version: ${best.version} (${best.repo})`);

    if (this.isNewerVersion(best.version, CURRENT_VERSION)) {
      this.updateAvailable = true;
      this.latestVersion = best.version;
      this.downloadUrl = best.release.zipball_url;

      console.log('✨ Update available!');
      return {
        available: true,
        version: best.version,
        url: this.downloadUrl
      };
    }

    console.log('✅ Already on latest version');
    return {
      available: false,
      version: CURRENT_VERSION
    };
  }

  fetchLatestRelease(repo) {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': 'PhotoLynk-Server'
        }
      };

      https.get(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            console.error('Error parsing release data:', error);
            resolve(null);
          }
        });
      }).on('error', (error) => {
        console.error('Error checking for updates:', error);
        resolve(null);
      });
    });
  }

  // Compare version numbers
  isNewerVersion(latest, current) {
    const latestParts = latest.split('.').map(Number);
    const currentParts = current.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (latestParts[i] > currentParts[i]) return true;
      if (latestParts[i] < currentParts[i]) return false;
    }
    return false;
  }

  // Download and apply update
  async downloadAndInstall() {
    if (!this.updateAvailable) {
      console.log('No update available');
      return false;
    }

    console.log(`📥 Downloading update ${this.latestVersion}...`);

    try {
      const projectRoot = path.join(__dirname, '..');
      const backupDir = path.join(projectRoot, 'backup');
      
      // Create backup of current version
      console.log('Creating backup...');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      // Backup critical files
      const filesToBackup = ['server/server.js', 'server/package.json'];
      filesToBackup.forEach(file => {
        const src = path.join(projectRoot, file);
        const dest = path.join(backupDir, path.basename(file));
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      });

      // Pull latest from git
      console.log('Pulling latest changes...');
      execSync('git pull origin main', { 
        cwd: projectRoot,
        stdio: 'inherit'
      });

      // Install dependencies
      console.log('Installing dependencies...');
      execSync('npm install', { 
        cwd: path.join(projectRoot, 'server'),
        stdio: 'inherit'
      });

      console.log('✅ Update installed successfully!');
      console.log('🔄 Please restart the server to apply changes');
      
      return true;
    } catch (error) {
      console.error('❌ Update failed:', error);
      
      // Restore backup
      console.log('Restoring backup...');
      try {
        const projectRoot = path.join(__dirname, '..');
        const backupDir = path.join(projectRoot, 'backup');
        
        const filesToRestore = ['server.js', 'package.json'];
        filesToRestore.forEach(file => {
          const src = path.join(backupDir, file);
          const dest = path.join(__dirname, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          }
        });
        
        console.log('✅ Backup restored');
      } catch (restoreError) {
        console.error('❌ Failed to restore backup:', restoreError);
      }
      
      return false;
    }
  }

  // Start automatic update checks
  startAutoCheck(callback) {
    // Check immediately
    this.checkForUpdates()
      .then(result => {
        if (callback) callback(result);
      })
      .catch(error => {
        console.error('Update check failed:', error);
      });

    // Check periodically
    setInterval(() => {
      this.checkForUpdates()
        .then(result => {
          if (callback) callback(result);
        })
        .catch(error => {
          console.error('Update check failed:', error);
        });
    }, UPDATE_CHECK_INTERVAL);
  }
}

module.exports = new Updater();
