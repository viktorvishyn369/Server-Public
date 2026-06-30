    // Global error handler
    window.onerror = function(msg, url, line, col, error) {
      console.error('JS Error:', msg, 'at line', line, 'col', col);
      return false;
    };
    
    const { ipcRenderer } = require('electron');
    let selectedFolders = [];
    let serverBusy = false;
    let currentDestination = 'stealthcloud';
    let currentOperation = 'backup';
    
    // Populate from main-process injected data
    function applyRendererData() {
      const data = window.__PHOTOLYNK_DATA__ || {};
      if (data.version) {
        const vb = document.querySelector('.version-badge');
        if (vb) vb.textContent = 'v' + data.version;
      }
      if (data.email) {
        const qa = document.getElementById('qs-account');
        if (qa) qa.textContent = data.email;
        const em = document.getElementById('email');
        if (em) em.value = data.email;
      }
      if (data.password) {
        const pw = document.getElementById('password');
        if (pw) pw.value = data.password;
      }
      if (data.photoFolders && data.photoFolders.length) {
        selectedFolders = data.photoFolders;
        renderFolders();
      }
      if (data.uploadsPath) {
        const up = document.getElementById('uploads-path');
        if (up) up.value = data.uploadsPath;
      }
      if (data.qrImage) {
        const qr = document.querySelector('.qr-code');
        if (qr) qr.src = data.qrImage;
      }
      if (data.pairingIp && data.pairingPort) {
        const ipb = document.querySelector('.ip-badge span');
        if (ipb) ipb.textContent = data.pairingIp + ':' + data.pairingPort;
      }
      if (data.deviceUuid) {
        window.__PHOTOLYNK_DATA__.deviceUuid = data.deviceUuid;
      }
    }
    window.onRendererDataInjected = applyRendererData;
    
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
      // Update top nav buttons
      document.querySelectorAll('.top-nav-btn').forEach(b => b.classList.remove('active'));
      const topBtn = document.querySelector('.top-nav-btn[data-tab="' + tabName + '"]');
      if (topBtn) topBtn.classList.add('active');
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
    const baseUploadsPath = (window.__PHOTOLYNK_DATA__ || {}).baseUploadsPath || '';
    
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
    const initialPath = (window.__PHOTOLYNK_DATA__ || {}).uploadsPath || '';;
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
    if ((window.__PHOTOLYNK_DATA__ || {}).deviceUuid) {
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
    
    function hideInlineProgress(success, message, isBackup = false) {
      const hero = document.getElementById('status-hero');
      const progressTitle = document.getElementById('qs-progress-title');
      const statusMsg = document.getElementById('inline-status-message');

      // Show completion message briefly
      if (success) {
        progressTitle.textContent = '✓ Complete!';
        progressTitle.className = 'qs-progress-title';
        progressTitle.style.color = '#10B981';
        document.getElementById('inline-progress-fill').style.width = '100%';
        // Update last backup stat only for backup, not sync
        if (isBackup) updateLastBackupStat(message);
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
      try { localStorage.setItem('last_backup_time', hhmm); } catch (e) {}
    }

    // Restore saved last backup time on UI load
    try {
      const savedBackupTime = localStorage.getItem('last_backup_time');
      if (savedBackupTime) {
        const el = document.getElementById('qs-backup');
        if (el) el.textContent = savedBackupTime;
      }
    } catch (e) {}

    function updateQsNfts(count) {
      const el = document.getElementById('qs-nfts');
      if (el) el.textContent = count != null ? String(count) : '—';
    }

    function syncQuickInfoNfts() {
      updateQsNfts(nftWalletAddress ? allNFTs.length : null);
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
    ipcRenderer.on('backup-complete', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(true, d.message, true); });
    ipcRenderer.on('backup-error', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(false, 'Error: ' + d.message); });
    ipcRenderer.on('sync-progress', (e, d) => { updateInlineProgress(d.progress * 100, d.message); });
    ipcRenderer.on('sync-complete', (e, d) => { setActionButtonsDisabled(false); hideInlineProgress(true, d.message, false); });
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
      
      // Detect CORS errors specifically
      if (img.dataset.originalUrl) {
        const url = img.dataset.originalUrl;
        const isExternal = !url.startsWith('data:') && !url.startsWith('file://') && !url.includes('localhost');
        if (isExternal) {
          console.log('[NFT Album] CORS/external URL failed, use Image button to open in browser:', url.slice(0, 60));
        }
      }
    }
    
    // NFT State
    let nftWalletAddress = null;
    // Deduplicates concurrent fetch-user-nfts calls — all callers share one in-flight DAS request
    // TTL cache: reuse last successful result for 5 minutes to avoid DAS spam on auto-refresh
    let _fetchNFTsInFlight = null;
    let _fetchNFTsCache = null;
    let _fetchNFTsCacheWallet = null;
    let _fetchNFTsCacheTs = 0;
    const _FETCH_NFTS_TTL_MS = 300000; // 5 minutes
    async function invalidateNFTFetchCaches(resetDas = false) {
      _fetchNFTsCache = null;
      _fetchNFTsCacheWallet = null;
      _fetchNFTsCacheTs = 0;
      if (resetDas) {
        try { await ipcRenderer.invoke('invalidate-das-cache'); } catch (_) { }
      }
    }
    async function fetchUserNFTsCached(limit = 1000, forceRefresh = false) {
      if (!nftWalletAddress) return { success: false, nfts: [] };
      if (_fetchNFTsCacheWallet && _fetchNFTsCacheWallet !== nftWalletAddress) {
        await invalidateNFTFetchCaches(false);
      }
      if (forceRefresh) {
        await invalidateNFTFetchCaches(true);
      }
      // Return cached result if still fresh
      if (!forceRefresh && _fetchNFTsCache && _fetchNFTsCacheWallet === nftWalletAddress && (Date.now() - _fetchNFTsCacheTs) < _FETCH_NFTS_TTL_MS) {
        return _fetchNFTsCache;
      }
      if (_fetchNFTsInFlight && !forceRefresh) return _fetchNFTsInFlight;
      _fetchNFTsInFlight = ipcRenderer.invoke('fetch-user-nfts', nftWalletAddress, limit)
        .then(result => { _fetchNFTsCache = result; _fetchNFTsCacheWallet = nftWalletAddress; _fetchNFTsCacheTs = Date.now(); return result; })
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
      console.log('[NFT] handleNFTPhotoSelected called with:', filePath, 'type:', typeof filePath);
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
        console.log('[NFT] Drop event files:', files, 'length:', files?.length);
        if (files && files.length > 0) {
          const file = files[0];
          console.log('[NFT] Dropped file:', file.name, 'path:', file?.path, 'type:', file?.type);
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
              syncQuickInfoNfts();
              try { await ipcRenderer.invoke('purge-nft-storage'); } catch (_) {}
              try { await ipcRenderer.invoke('clear-nft-cache'); } catch (_) {}
              await invalidateNFTFetchCaches(true);
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
      syncQuickInfoNfts();
      updateMintButton();
    }
    
    function updateMintButton() {
      const btn = document.getElementById('nft-mint-btn');
      btn.disabled = !selectedNFTPhoto || !nftWalletAddress || isMinting;
      if (!btn.disabled && lastNftEstimate && lastNftEstimate.total) {
        btn.innerHTML = 'Certify Photo (~$' + (lastNftEstimate.total.usd || 0).toFixed(2) + ')';
      } else if (!isMinting) {
        btn.innerHTML = 'Certify Photo';
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
      console.log('[NFT Mint] selectedNFTPhoto:', selectedNFTPhoto, 'type:', typeof selectedNFTPhoto);
      const selectedPath = (typeof selectedNFTPhoto === 'string')
        ? selectedNFTPhoto
        : (selectedNFTPhoto && typeof selectedNFTPhoto.path === 'string')
          ? selectedNFTPhoto.path
          : String(selectedNFTPhoto || '');
      console.log('[NFT Mint] resolved selectedPath:', selectedPath);
      const name = nameInputVal || (selectedPath ? selectedPath.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() : '') || 'My Photo';
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
        console.error('[NFT Mint] Error during mint:', e);
        btn.innerHTML = '<span>✕</span> ' + (e.message || 'Failed');
        btn.style.background = 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)';
        setTimeout(() => {
          isMinting = false;
          btn.style.background = '';
          btn.innerHTML = 'Certify Photo';
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
        '<h2 style="color:#14F195;font-size:24px;margin-bottom:8px;">Photo Certified!</h2>' +
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
            name: data.name || 'Certified Photo',
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
            name: data.name || 'Certified Photo',
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
            name: data.name || 'Certified Photo',
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
                      name: data.name || 'Certified Photo',
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
                    try { await ipcRenderer.invoke('save-minted-nft', { mintAddress: newMint, assetId: realId, ownerAddress: data.wallet || nftWalletAddress, name: data.name || 'Certified Photo', imageUrl: displayImageUrl, metadataUrl: data.metadataUrl || null, txSignature: data.mintTx || data.paymentTx || null, storageType: data.storageOption || 'ipfs', isCompressed: true, nftType: 'compressed', edition: data.edition || 'open', license: data.license || 'arr', watermarked: data.watermark === 'true', encrypted: data.encrypt === 'true', encryptionData: pendingEncData, thumbnailUrl: savedThumbUrl, ipfsThumbnailUrl: window._pendingMintIpfsThumbnailUrl || null, createdAt: new Date().toISOString(), contentHash: data.contentHash || null, exifHash: data.exifHash || null, exifRawHash: data.exifRawHash || null, exifBindingHash: data.exifBindingHash || null, certificationMode: data.certificationMode || null }); } catch (_) {}
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
        checkForNewNFTsOnce(true);
        startNFTAutoRefresh();
      } else {
        loadNFTAlbum(true);
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
        if (!c.encrypted && hasUsableWrappedEncryptionPayload(nft.encryptionData)) { c.encrypted = true; enriched = true; }
        if (!c.watermarked && nft.watermarked) { c.watermarked = true; enriched = true; }
        const metaCert = nft.metadata?.properties?.certificate;
        if (!c.rfc3161Token && metaCert?.rfc3161?.tsaTokenBase64) { c.rfc3161Token = metaCert.rfc3161.tsaTokenBase64; c.hasRfc3161 = true; enriched = true; }
        if (!c.c2paManifest && nft.metadata?.properties?.c2pa) { c.c2paManifest = nft.metadata.properties.c2pa; c.hasC2pa = true; enriched = true; }
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
              const encData = hasUsableWrappedEncryptionPayload(nft?.encryptionData) ? (nft?.encryptionData || null) : null;
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
            if (s.encryptionData && !nftMap[key].encryptionData) nftMap[key].encryptionData = s.encryptionData;
            if (s.thumbnailUrl && !nftMap[key].thumbnailUrl) nftMap[key].thumbnailUrl = s.thumbnailUrl;
            if (s.edition && !nftMap[key].edition) nftMap[key].edition = s.edition;
            if (s.certificationMode && !nftMap[key].certificationMode) nftMap[key].certificationMode = s.certificationMode;
            if (hasUsableWrappedEncryptionPayload(s.encryptionData) && !nftMap[key].encrypted) nftMap[key].encrypted = true;
          }
        }
      } catch (_) {}
      return nftMap;
    }

    function hasFullCertEvidence(item) {
      if (!item) return false;
      const attrs = item.metadata?.attributes || item.attributes || [];
      const hasAttrVal = (trait) => attrs.some(a => a && a.trait_type === trait && a.value);
      const metaCert = item.metadata?.properties?.certificate;
      return !!(
        item.contentHash ||
        item.exifHash ||
        item.exifRawHash ||
        item.exifBindingHash ||
        item.cameraHash ||
        item.rfc3161Token ||
        item.c2paManifest ||
        metaCert?.rfc3161?.tsaTokenBase64 ||
        item.metadata?.properties?.c2pa ||
        hasAttrVal('Content Hash') ||
        hasAttrVal('EXIF Hash') ||
        hasAttrVal('EXIF Raw Hash') ||
        hasAttrVal('EXIF Binding Hash') ||
        hasAttrVal('Camera Hash') ||
        hasAttrVal('RFC 3161 Timestamp') ||
        hasAttrVal('C2PA Provenance')
      );
    }

    function filterDisplayablePhotoLynkCerts(certs, nftMap = {}) {
      return (certs || []).filter(cert => {
        if (!cert?.id) return false;
        const mint = (cert.mintAddress || '').replace(/^cnft_/, '');
        const nft = mint ? nftMap[mint] : null;
        const merged = nft ? {
          ...cert,
          metadata: cert.metadata || nft.metadata,
          attributes: cert.attributes?.length ? cert.attributes : (nft.attributes || []),
          contentHash: cert.contentHash || nft.contentHash,
          exifHash: cert.exifHash || nft.exifHash,
          exifRawHash: cert.exifRawHash || nft.exifRawHash,
          exifBindingHash: cert.exifBindingHash || nft.exifBindingHash,
          cameraHash: cert.cameraHash || nft.cameraHash,
          rfc3161Token: cert.rfc3161Token || nft.rfc3161Token,
          c2paManifest: cert.c2paManifest || nft.c2paManifest,
        } : cert;
        if (nft && !isPhotoLynkEcosystem(nft)) return false;
        if (!nft && !isPhotoLynkEcosystem(merged)) return false;
        return hasFullCertEvidence(merged);
      });
    }

    function shouldAutoGenerateFullCertificate(nft) {
      return isPhotoLynkEcosystem(nft) && hasFullCertEvidence(nft);
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
        if (p.exifRawHash && !c.exifRawHash) c.exifRawHash = p.exifRawHash;
        if (p.exifHash && !c.exifHash) c.exifHash = p.exifHash;
        if (p.exifBindingHash && !c.exifBindingHash) c.exifBindingHash = p.exifBindingHash;
        if (p.cameraHash && !c.cameraHash) c.cameraHash = p.cameraHash;
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
        certs = filterDisplayablePhotoLynkCerts(certs, nftMap);
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
      serverCerts = filterDisplayablePhotoLynkCerts(serverCerts, nftMap);

      // Auto-generate certificates for ecosystem NFTs that don't have one yet
      // Only PhotoLynk-created NFTs get proofs — external NFTs are skipped
      // (matches mobile discoverAndImportNFTs auto-cert generation)
      if (Object.keys(nftMap).length > 0) {
        try {
          const certMints = new Set(serverCerts.map(c => (c.mintAddress || '').replace(/^cnft_/, '')));
          let autoGenerated = 0;
          for (const [mint, nft] of Object.entries(nftMap)) {
            if (!certMints.has(mint) && shouldAutoGenerateFullCertificate(nft)) {
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
      
      serverCerts = filterDisplayablePhotoLynkCerts(serverCerts, nftMap);
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
        
        card.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <div style="width:32px;height:32px;border-radius:8px;background:rgba(245,158,11,0.15);display:flex;align-items:center;justify-content:center;font-size:16px;">🏆</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${cert.name || 'Untitled'}</div>
              <div style="font-size:10px;color:#888;">${dateStr}</div>
            </div>
          </div>
          <div style="font-size:9px;color:#6b7280;margin-bottom:6px;">SHA-256 anchored · Immutable · Timestamped</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${tags.join('')}</div>
          ${cert.mintAddress ? '<div style="font-size:9px;color:#666;font-family:monospace;">' + cert.mintAddress.slice(0,20) + '...' + cert.mintAddress.slice(-8) + '</div>' : ''}
        `;
        card.onclick = () => showCertDetail(cert);
        listEl.appendChild(card);
      }
    }
    
    function showCertDetail(cert) {
      const listEl = document.getElementById('certs-list');
      if (!listEl) return;
      window._rfcCertData = cert;
      const dateStr = cert.issuedAt ? new Date(cert.issuedAt).toLocaleString('en', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : 'N/A';
      
      listEl.innerHTML = `
        <div style="margin-bottom:12px;">
          <button onclick="loadCertificates()" style="background:transparent;border:1px solid #333;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">← Back</button>
        </div>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:16px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            <span style="font-size:28px;">🏆</span>
            <span style="font-size:15px;font-weight:700;color:#f59e0b;">Certificate of Authenticity</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">
            <span style="font-size:10px;padding:2px 6px;border:1px solid rgba(99,102,241,0.3);border-radius:4px;color:#818cf8;">${isPublicNFTClassification(cert) ? '🌍 Public' : '🔐 Private'}</span>
            ${cert.encrypted ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(153,69,255,0.3);border-radius:4px;color:#9945FF;">🔒 Encrypted</span>' : ''}
            ${cert.watermarked ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(34,197,94,0.3);border-radius:4px;color:#22c55e;">Watermarked</span>' : ''}
            ${(cert.rfc3161Token || cert.hasRfc3161) ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(16,185,129,0.4);border-radius:4px;color:#10b981;background:rgba(16,185,129,0.08);">⏱ RFC 3161</span>' : ''}
            ${(cert.c2paManifest || cert.hasC2pa) ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.4);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.08);">C2PA</span>' : ''}
            ${cert.storageType === 'onchain' ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(245,158,11,0.3);border-radius:4px;color:#f59e0b;background:rgba(245,158,11,0.08);">Embedded</span>' : ''}
            ${cert.storageType === 'cloud' ? '<span style="font-size:10px;padding:2px 6px;border:1px solid rgba(59,130,246,0.3);border-radius:4px;color:#3b82f6;background:rgba(59,130,246,0.08);">Encrypted Cloud</span>' : ''}
          </div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Certification</span><span style="color:#fff;font-size:12px;">${isPublicNFTClassification(cert) ? 'Public Certified' : 'Private Certified'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">License</span><span style="color:#fff;font-size:12px;">${({'arr':'All Rights Reserved','cc-by':'CC BY 4.0','cc-by-sa':'CC BY-SA 4.0','cc-by-nc':'CC BY-NC 4.0','cc-by-nc-sa':'CC BY-NC-SA 4.0','cc-by-nd':'CC BY-ND 4.0','cc-by-nc-nd':'CC BY-NC-ND 4.0','cc0':'CC0 1.0 (Public Domain)','commercial':'Commercial License'})[cert.license] || cert.license || 'All Rights Reserved'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Issued</span><span style="color:#fff;font-size:12px;">${dateStr}</span></div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">AUTHENTICITY PROOF</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Record ID</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cert.mintAddress || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">TX</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cert.txSignature || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Certified By</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${cert.creatorWallet || 'N/A'}</span></div>
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Integrity</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Content Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cert.contentHash || 'N/A'}">${cert.contentHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Raw EXIF Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cert.exifRawHash || 'N/A'}">${cert.exifRawHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">EXIF Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cert.exifHash || 'N/A'}">${cert.exifHash || 'N/A'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Binding Hash</span><span style="color:#fff;font-size:10px;font-family:monospace;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${cert.exifBindingHash || 'N/A'}">${cert.exifBindingHash || 'N/A'}</span></div>
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
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Watermarked</span><span style="color:#fff;font-size:12px;">${cert.watermarked ? 'Yes' : 'No'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Encrypted</span><span style="color:#fff;font-size:12px;">${cert.encrypted ? 'Yes' : 'No'}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:12px;">Storage</span><span style="color:#fff;font-size:12px;">${cert.storageType === 'cloud' ? 'Encrypted Cloud' : cert.storageType === 'arweave' ? 'Arweave (Permanent)' : cert.storageType === 'onchain' ? 'Embedded' : 'Decentralized'}</span></div>
          ${(cert.rfc3161Token || cert.hasRfc3161) ? `
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
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">openssl ts -verify -in token.tsr -digest ${(cert.contentHash || '').replace('SHA256:','') || '&lt;sha256_hash&gt;'} -CAfile cacert.pem</span>
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
                <span style="font-size:9px;color:#a1a1aa;font-family:monospace;flex:1;word-break:break-all;">openssl ts -verify -in token.tsr -digest ${(cert.contentHash || '').replace('SHA256:','') || '&lt;sha256_hash&gt;'} -CAfile cacert.pem</span>
                <span style="color:#10b981;font-size:10px;">📋</span>
              </div>
            </div>
            <div style="font-size:9px;color:#6b7280;margin-top:4px;">Expected: <span style="color:#10b981;font-weight:600;">Verification: OK</span></div>
          </div>
          ` : ''}
          ${(cert.rfc3161Token || cert.hasRfc3161) && !cert.rfc3161Token ? `
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px;padding:0 4px;">
            <span style="color:#10b981;font-size:12px;">✓</span>
            <span style="font-size:10px;color:#6b7280;">Full token stored on-chain — verified via metadata</span>
          </div>
          ` : ''}
          ${(cert.c2paManifest || cert.hasC2pa) ? `
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">C2PA Provenance</div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Standard</span><span style="color:#3b82f6;font-size:11px;">C2PA / Coalition for Content Provenance</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Claim Generator</span><span style="color:#3b82f6;font-size:11px;">${cert.c2paManifest?.claim_generator || 'PhotoLynk/' + (app && typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0').trim()}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#888;font-size:11px;">Created</span><span style="color:#3b82f6;font-size:11px;">${cert.c2paManifest?.claim?.created || cert.issuedAt || 'N/A'}</span></div>
          ` : ''}
          ${cert.mintAddress ? `
          <div style="height:1px;background:#333;margin:12px 0;"></div>
          <div onclick="window.viewCertNFT('${cert.mintAddress}')" style="cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(153,69,255,0.15);border-radius:10px;padding:12px;margin-top:8px;">
            <span style="font-size:14px;">🖼️</span>
            <span style="color:#9945FF;font-weight:600;font-size:13px;">View in Collection</span>
          </div>
          ` : ''}
        </div>
      `;
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
      const mintPlatform = String(nft.mintPlatform || '').toLowerCase();
      if (mintPlatform.includes('photolynk') || mintPlatform === 'nft-service') return true;
      if (nft.contentHash && nft.exifHash) return true;
      const attrs = nft.metadata?.attributes || nft.attributes || [];
      const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
      const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
      if (hasContentHash && hasExifHash) return true;
      const metaCert = nft.metadata?.properties?.certificate;
      if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
      return false;
    }

    function hasUsableWrappedEncryptionPayload(encryptionData) {
      return !!(encryptionData?.wrappedKey && encryptionData?.wrapNonce && (encryptionData?.nonce || encryptionData?.thumbnailNonce));
    }

    function shouldUseEncryptedRendering(nft) {
      return nft?.encrypted === true && hasUsableWrappedEncryptionPayload(nft?.encryptionData);
    }

    function isPrivateNFTClassification(nft) {
      // Match solana-seeker NFTGallery.js isPrivateNFTTabMatch exactly
      const isPhotoLynk = isPhotoLynkEcosystemNFT(nft);
      const mode = String(nft?.certificationMode || '').toLowerCase();
      const edition = String(nft?.edition || '').toLowerCase();
      if (!isPhotoLynk) return shouldUseEncryptedRendering(nft);
      if (mode === 'public') return false;
      if (mode === 'private') return true;
      if (edition === 'limited') return true;  // Limited → Private
      return shouldUseEncryptedRendering(nft);  // Encrypted → Private
    }

    function isPublicNFTClassification(nft) {
      // Match solana-seeker NFTGallery.js isPublicNFTTabMatch exactly
      if (!isPhotoLynkEcosystemNFT(nft)) return false;
      const mode = String(nft?.certificationMode || '').toLowerCase();
      const edition = String(nft?.edition || '').toLowerCase();
      if (mode === 'private') return false;
      if (mode === 'public') return true;
      return edition === 'open';  // Open → Public
    }

    function isPhotoLynkCertifiedNFT(nft) {
      // Match solana-seeker NFTGallery.js isPhotoLynkCertifiedNFT exactly
      if (!nft) return false;
      if (!isPhotoLynkEcosystemNFT(nft)) return false;
      const mode = String(nft?.certificationMode || '').toLowerCase();
      const edition = String(nft?.edition || '').toLowerCase();
      if (mode === 'public' || mode === 'private') return true;
      if (edition === 'open' || edition === 'limited') return true;
      return shouldUseEncryptedRendering(nft);
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
      if (shouldUseEncryptedRendering(nft)) tags.push('encrypted');
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
      // Match solana-seeker NFTGallery.js filtering exactly
      let result = allNFTs;
      if (nftFilter === 'private') {
        // Private tab: show ecosystem NFTs OR any certified/encrypted NFT (broader check for synced NFTs)
        result = result.filter(nft => {
          const isEcosystem = isPhotoLynkEcosystemNFT(nft) || isPhotoLynkCertifiedNFT(nft);
          const isPrivate = isPrivateNFTClassification(nft) || shouldUseEncryptedRendering(nft);
          return (isEcosystem && isPrivate) || shouldUseEncryptedRendering(nft);
        });
      } else if (nftFilter === 'public') {
        // Public tab: show ecosystem NFTs OR certified NFTs that are public
        result = result.filter(nft => (isPhotoLynkEcosystemNFT(nft) || isPhotoLynkCertifiedNFT(nft)) && isPublicNFTClassification(nft));
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
          if (shouldUseEncryptedRendering(nft) && !existing.encrypted) existing.encrypted = true;
          if (nft.watermarked && !existing.watermarked) existing.watermarked = nft.watermarked;
          if (nft.license && !existing.license) existing.license = nft.license;
          if (nft.storageType && (!existing.storageType || existing.storageType === 'ipfs')) existing.storageType = nft.storageType;
          if (nft.createdAt && !existing.createdAt) existing.createdAt = nft.createdAt;
          if (shouldUseEncryptedRendering(nft) && nft.imageUrl && hasUsableWrappedEncryptionPayload(existing.encryptionData)) {
            // Don't overwrite imageUrl if existing already has encryption keys
          } else if (shouldUseEncryptedRendering(nft) && nft.imageUrl) {
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
            if (hasUsableWrappedEncryptionPayload(old.encryptionData) && !nft.encrypted) nft.encrypted = true;
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

    async function checkForNewNFTsOnce(forceRefresh = false) {
      if (!nftWalletAddress) return 0;
      try {
        const result = await fetchUserNFTsCached(1000, forceRefresh);
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
                  if (hasUsableWrappedEncryptionPayload(stored.encryptionData) && !nft.encrypted) nft.encrypted = true;
                  if (stored.watermarked && !nft.watermarked) nft.watermarked = stored.watermarked;
                  if (stored.license && !nft.license) nft.license = stored.license;
                  if (stored.storageType && (!nft.storageType || nft.storageType === 'ipfs' || nft.storageType === 'unknown')) nft.storageType = stored.storageType;
                  if (hasUsableWrappedEncryptionPayload(stored.encryptionData) && stored.imageUrl) {
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
          syncQuickInfoNfts();
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
    
    async function loadNFTAlbum(forceRefresh = false) {
      try {
        const grid = document.getElementById('nft-grid');
        const loading = document.getElementById('nft-loading');
        const empty = document.getElementById('nft-empty');

        if (!nftWalletAddress) {
          syncQuickInfoNfts();
          grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#888;">' +
            '<div style="font-size:32px;margin-bottom:8px;">🖼️</div>' +
            '<div style="font-weight:600;color:#fff;margin-bottom:4px;">Connect Credentials</div>' +
            '<div style="font-size:12px;margin-bottom:16px;">Connect your credentials to view your certified photos</div>' +
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
              syncQuickInfoNfts();
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
          fetchUserNFTsCached(1000, forceRefresh),
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
                if (hasUsableWrappedEncryptionPayload(stored.encryptionData) && !nft.encrypted) nft.encrypted = true;
                if (stored.certificationMode && !nft.certificationMode) nft.certificationMode = stored.certificationMode;
                if (stored.watermarked && !nft.watermarked) nft.watermarked = stored.watermarked;
                if (stored.license && !nft.license) nft.license = stored.license;
                if (stored.storageType && (!nft.storageType || nft.storageType === 'ipfs')) nft.storageType = stored.storageType;
                if (stored.createdAt && !nft.createdAt) nft.createdAt = stored.createdAt;
                // For encrypted NFTs: DAS imageUrl is a proxied URL that can't be decrypted.
                // Use the original upload URL from local storage (Pinata/StealthCloud) instead.
                if (hasUsableWrappedEncryptionPayload(stored.encryptionData) && stored.imageUrl) {
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
            syncQuickInfoNfts();
            renderNFTPage();
          } else {
            const added = appendNewNFTs(result.nfts);
            if (added > 0) {
              console.log('[NFT Album] Appended', added, 'new NFT(s). Total:', allNFTs.length);
              updateNFTNavigation();
            }
            syncQuickInfoNfts();
          }
          // Start auto-refresh to detect new NFTs
          startNFTAutoRefresh();
        } else {
          syncQuickInfoNfts();
          if (allNFTs.length === 0) {
            empty.innerHTML = '<span>No certified photos yet. Certify your first photo!</span>';
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
      const nftName = nft.name || 'Photo #' + (nftIndex + 1);
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

      if (shouldUseEncryptedRendering(nft)) {
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
            const result = await ipcRenderer.invoke('decrypt-nft-image', { imageUrl: nft.arweaveUrl || nft.imageUrl || nft.image, thumbnailUrl: nft.thumbnailUrl || null, encryptionData: nft.encryptionData });
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
      if (titleEl) titleEl.textContent = nft.name || 'Photo';

      // Rebuild badge row: certification mode + storage + encrypted + watermarked + license
      const badgeRow = document.getElementById('nft-detail-badge-row');
      if (badgeRow) {
        badgeRow.innerHTML = '';
        // Certification mode badge (Private/Public) — only for PhotoLynk ecosystem NFTs
        if (isPrivateNFTClassification(nft)) {
          badgeRow.innerHTML += '<div class="nft-chip cert-private">🔐 Private</div>';
        } else if (isPublicNFTClassification(nft)) {
          badgeRow.innerHTML += '<div class="nft-chip cert-public">🌍 Public</div>';
        } else if (isCompressed) {
          badgeRow.innerHTML += '<div class="nft-chip cnft">cNFT</div>';
        } else {
          // Non-PhotoLynk standard NFTs — show type based on storage
          const rawImg = (nft.imageUrl || nft.image || '');
          const isAr = rawImg.includes('arweave.net') || rawImg.includes('akrd.net') || nft.arweaveUrl;
          const isData = rawImg.startsWith('data:');
          const badgeText = isData ? 'On-Chain' : isAr ? 'Arweave' : nft.storageType === 'ipfs' ? 'IPFS' : 'Standard';
          badgeRow.innerHTML += '<div class="nft-chip standard">' + badgeText + '</div>';
        }
        // Storage chip
        const rawImageUrl = (nft && (nft.imageUrl || nft.image)) ? String(nft.imageUrl || nft.image) : '';
        const _allUrls = rawImageUrl + (nft.arweaveUrl || '');
        const storageLabel = nft.storageType ? (nft.storageType === 'cloud' ? (shouldUseEncryptedRendering(nft) ? 'Encrypted Cloud' : 'StealthCloud') : nft.storageType === 'arweave' ? 'Arweave' : nft.storageType === 'onchain' ? 'On-Chain' : 'Decentralized') : (isStealthCloudUrl(_allUrls) ? (shouldUseEncryptedRendering(nft) ? 'Encrypted Cloud' : 'StealthCloud') : _allUrls.includes('arweave.net') || _allUrls.includes('akrd.net') ? 'Arweave' : 'Decentralized');
        badgeRow.innerHTML += '<div class="nft-chip storage">' + storageLabel + '</div>';
        // Encrypted badge
        if (shouldUseEncryptedRendering(nft)) {
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
          transferBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Transfer Photo';
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
      
      // Get image URL from various sources
      let rawImageUrl = (currentDetailNFT && (currentDetailNFT.imageUrl || currentDetailNFT.image)) ? String(currentDetailNFT.imageUrl || currentDetailNFT.image) : '';
      
      // If no image URL but we have arweaveUrl, use that
      if (!rawImageUrl && currentDetailNFT.arweaveUrl) {
        rawImageUrl = currentDetailNFT.arweaveUrl;
      }
      
      const _allUrls3 = rawImageUrl + (currentDetailNFT.arweaveUrl || '');
      const isCloud = currentDetailNFT.storageType === 'cloud' || (!currentDetailNFT.storageType && isStealthCloudUrl(_allUrls3));
      const isArweave = currentDetailNFT.storageType === 'arweave' || rawImageUrl.includes('akrd.net') || rawImageUrl.includes('arweave.net') || (currentDetailNFT.arweaveUrl && !rawImageUrl);
      const isOnChain = currentDetailNFT.storageType === 'onchain' || rawImageUrl.startsWith('data:');
      
      if (isOnChain) {
        // On-chain SVG is embedded in metadata — show the metadata URL instead
        const metaUrl = currentDetailNFT.metadataUrl || currentDetailNFT.uri || '';
        if (metaUrl) require('electron').shell.openExternal(metaUrl.startsWith('http') ? metaUrl : 'https://ipfs.io/ipfs/' + metaUrl);
        return;
      }
      
      if (isCloud || isArweave) {
        const urlToOpen = rawImageUrl || currentDetailNFT.arweaveUrl;
        if (urlToOpen) require('electron').shell.openExternal(urlToOpen);
        return;
      }

      let imgUrl = rawImageUrl;
      let cid = extractIPFSCid(imgUrl);

      // If no image URL or CID, try to fetch from metadata
      if (!imgUrl && currentDetailNFT.metadataUrl) {
        try {
          console.log('[NFT Image] No image URL, fetching from metadata:', currentDetailNFT.metadataUrl);
          const result = await ipcRenderer.invoke('fetch-nft-image-from-metadata', currentDetailNFT.metadataUrl, isCompressed);
          if (result && result.imageUrl) {
            imgUrl = result.imageUrl;
            cid = extractIPFSCid(imgUrl);
            console.log('[NFT Image] Got image from metadata:', imgUrl.slice(0, 60));
          }
        } catch (e) {
          console.log('[NFT Image] Failed to fetch from metadata:', e.message);
        }
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
      const mintPlatform = String(nft.mintPlatform || '').toLowerCase();
      if (mintPlatform.includes('photolynk') || mintPlatform === 'nft-service') return true;
      if (nft.contentHash && nft.exifHash) return true;
      const attrs = nft.metadata?.attributes || nft.attributes || [];
      const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
      const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
      if (hasContentHash && hasExifHash) return true;
      const metaCert = nft.metadata?.properties?.certificate;
      if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
      return false;
    }

    async function openNFTTransfer() {
      if (!currentDetailNFT) return;
      if (!isPhotoLynkEcosystem(currentDetailNFT)) return;
      
      const isCompressed = currentDetailNFT.isCompressed === true;
      const imageUrl = currentDetailNFT.cachedPath ? 'file://' + currentDetailNFT.cachedPath : (currentDetailNFT.image || currentDetailNFT.imageUrl || '');
      
      document.getElementById('nft-transfer-img').src = imageUrl;
      document.getElementById('nft-transfer-name').textContent = currentDetailNFT.name || 'Unnamed Photo';
      document.getElementById('nft-transfer-type').textContent = isPrivateNFTClassification(currentDetailNFT) ? 'Private' : isPublicNFTClassification(currentDetailNFT) ? 'Public' : isCompressed ? 'Public' : 'Standard';
      
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
      modal.innerHTML = `
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(20,241,149,0.3);box-shadow:0 20px 60px rgba(20,241,149,0.2);">
          <div style="font-size:56px;margin-bottom:16px;">✅</div>
          <h2 style="color:#14F195;font-size:22px;margin-bottom:8px;">Transfer Successful!</h2>
          <p style="color:#888;font-size:13px;margin-bottom:20px;">Your photo has been transferred to the new owner.</p>
          
          <div style="background:rgba(0,0,0,0.3);border-radius:12px;padding:16px;margin-bottom:20px;text-align:left;">
            <div style="color:#888;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Transaction Signature</div>
            <div style="color:#fff;font-size:12px;font-family:monospace;word-break:break-all;">${shortSig}</div>
          </div>
          
          <button onclick="require('electron').shell.openExternal('${solscanUrl}')" style="width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,#14F195 0%,#0ea66a 100%);color:#000;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:12px;">
            <span>🔗</span> View on Solscan
          </button>
          
          <button onclick="document.getElementById('transfer-success-modal').remove()" style="width:100%;padding:12px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:transparent;color:#888;font-size:13px;cursor:pointer;">
            Close
          </button>
        </div>
      `;
      document.body.appendChild(modal);
    }
    window.showTransferSuccessModal = showTransferSuccessModal;
    
    function showTransferCancelledModal(isCancelled) {
      const existing = document.getElementById('transfer-cancelled-modal');
      if (existing) existing.remove();
      
      const modal = document.createElement('div');
      modal.id = 'transfer-cancelled-modal';
      modal.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = `
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:20px;padding:32px;max-width:360px;width:100%;text-align:center;border:1px solid rgba(255,255,255,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.4);">
          <div style="font-size:56px;margin-bottom:16px;">${isCancelled ? '🚫' : '⚠️'}</div>
          <h2 style="color:#fff;font-size:20px;margin-bottom:8px;">${isCancelled ? 'Transfer Cancelled' : 'Transfer Failed'}</h2>
          <p style="color:#888;font-size:13px;margin-bottom:24px;">${isCancelled ? 'You cancelled the transaction in your credentials app.' : 'Something went wrong. Please try again.'}</p>
          <button onclick="document.getElementById('transfer-cancelled-modal').remove()" style="width:100%;padding:14px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:transparent;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
            OK
          </button>
        </div>
      `;
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
        const hasEncKeys = shouldUseEncryptedRendering(nft);
        const isCached = !!nft.cachedPath && !hasEncKeys;
        const imageUrl = isCached ? nft.cachedPath : (nft.image || nft.imageUrl || '');
        const originalUrl = nft.ipfsThumbnailUrl || nft.imageUrl || nft.image || '';  // Prefer IPFS thumb as fallback (tiny ~30KB)
        const nftName = nft.name || 'Photo #' + (globalIdx + 1);
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
        const stType = nft.storageType || (rawImg.startsWith('data:') ? 'onchain' : (rawImg.includes('stealthlynk.io') || rawImg.includes('stealthcloud')) ? 'cloud' : (rawImg.includes('arweave.net') || rawImg.includes('akrd.net')) ? 'arweave' : 'ipfs');
        let badgeRow = '<div class="nft-badge-row">';
        // Certification mode badge (Private/Public) — only for PhotoLynk ecosystem NFTs
        if (isPrivateNFTClassification(nft)) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(99,102,241,0.3);color:#818cf8;">🔐 Private</span>';
        } else if (isPublicNFTClassification(nft)) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(34,197,94,0.3);color:#22c55e;">🌍 Public</span>';
        } else if (isCompressed) {
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(34,197,94,0.3);color:#22c55e;">cNFT</span>';
        } else {
          // Non-PhotoLynk standard NFTs — show storage type
          const isAr = rawImg.includes('arweave.net') || rawImg.includes('akrd.net') || nft.arweaveUrl;
          const isData = rawImg.startsWith('data:');
          const badgeLabel = isData ? 'On-Chain' : isAr ? 'Arweave' : stType === 'ipfs' ? 'IPFS' : 'Standard';
          badgeRow += '<span class="nft-badge-pill" style="background:rgba(153,69,255,0.3);color:#9945FF;">' + badgeLabel + '</span>';
        }
        // Encrypted badge
        if (shouldUseEncryptedRendering(nft)) {
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
                const decryptUrl = (typeof originalUrl === 'string' && originalUrl.startsWith('http')) ? originalUrl : (nft.arweaveUrl || '');
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
        await invalidateNFTFetchCaches(true);
        console.log('[NFT Album] Cache cleared');
      } catch (e) {
        console.log('[NFT Album] Cache clear failed:', e.message);
      }
      loadNFTAlbum(true); 
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
        syncQuickInfoNfts();
        // Immediately clear certs UI so old wallet's certs don't flash
        const cl = document.getElementById('certs-list');
        const cld = document.getElementById('certs-loading');
        const ce = document.getElementById('certs-empty');
        if (cl) cl.innerHTML = '';
        if (cld) cld.style.display = 'block';
        if (ce) ce.style.display = 'none';
        try { await ipcRenderer.invoke('purge-nft-storage'); } catch (_) {}
        try { await ipcRenderer.invoke('clear-nft-cache'); } catch (_) {}
        await invalidateNFTFetchCaches(true);
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