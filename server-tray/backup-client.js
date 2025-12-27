/**
 * Desktop Backup Client
 * Implements the same encryption, chunking, and upload logic as the mobile app
 * Uses StealthCloud API: /api/cloud/chunks and /api/cloud/manifests
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks (same as mobile)
const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // Same as mobile app

const MAX_PARALLEL_CHUNK_UPLOADS = 4;
const MAX_PARALLEL_FILE_UPLOADS = 2;

function createConcurrencyLimiter(maxParallel) {
  const max = Math.max(1, Number(maxParallel) || 1);
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < max && queue.length) {
      const next = queue.shift();
      if (!next) break;
      active += 1;
      Promise.resolve().then(next.fn).then(next.resolve, next.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

async function trackInFlightPromise(inFlight, p, maxInFlight) {
  inFlight.add(p);
  const cleanup = () => { try { inFlight.delete(p); } catch (e) {} };
  p.then(cleanup, cleanup);
  if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
}

async function drainInFlightPromises(inFlight) {
  if (!inFlight || inFlight.size === 0) return;
  await Promise.all(Array.from(inFlight));
}

// UUID v5 implementation (SHA-1 based, same as mobile app's uuidv5)
function uuidv5(name, namespace) {
  // Parse namespace UUID to bytes
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  
  // Create SHA-1 hash of namespace + name
  const hash = crypto.createHash('sha1');
  hash.update(namespaceBytes);
  hash.update(name);
  const bytes = hash.digest();
  
  // Set version (5) and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  
  // Format as UUID string
  const hex = bytes.slice(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

class DesktopBackupClient {
  constructor(config, progressCallback) {
    this.config = config;
    this.progressCallback = progressCallback || (() => {});
    this.token = null;
    this.masterKey = null;
    this.deviceUuid = null;
    this.cancelled = false;
  }

  normalizeFilenameForCompare(name) {
    if (!name || typeof name !== 'string') return null;
    const base = path.basename(name);
    const trimmed = (base || '').trim();
    if (!trimmed) return null;
    return trimmed.toLowerCase();
  }

  getBaseUrl() {
    if (this.config.destination === 'stealthcloud') {
      return STEALTHCLOUD_BASE_URL;
    } else if (this.config.destination === 'remote') {
      const host = this.config.remoteAddress || '';
      const port = this.config.remotePort || '3000';
      
      // Detect if host is an IP address (use HTTP with port) or domain (use HTTPS without port)
      // IP addresses connect directly to server on port 3000 (HTTP)
      // Domains go through Nginx reverse proxy on port 443 (HTTPS)
      const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || 
                          host === 'localhost' || 
                          host.startsWith('192.168.') ||
                          host.startsWith('10.') ||
                          host.startsWith('172.');
      
      if (isIpAddress) {
        // Direct connection to server - HTTP with port
        return `http://${host}:${port}`;
      } else {
        // Domain with Nginx/Certbot - HTTPS on standard port 443 (no port in URL)
        return `https://${host}`;
      }
    } else {
      throw new Error('Invalid destination (expected remote or stealthcloud)');
    }
  }

  async login() {
    const baseUrl = this.getBaseUrl();
    this.progressCallback({ message: 'Logging in...', progress: 0.02 });

    try {
      const response = await axios.post(`${baseUrl}/api/login`, {
        email: this.config.email,
        password: this.config.password,
        device_uuid: this.getDeviceId(),
        device_name: this.getDeviceName()
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data && response.data.token) {
        this.token = response.data.token;
        this.deviceUuid = this.getDeviceId(); // Store UUID for subsequent requests
        return true;
      }
      throw new Error('No token received');
    } catch (error) {
      if (error.response && error.response.status === 401) {
        throw new Error('Invalid email or password');
      }
      throw new Error('Login failed: ' + (error.message || 'Unknown error'));
    }
  }

  // Check subscription status before allowing backup
  async checkSubscription() {
    const baseUrl = this.getBaseUrl();
    this.progressCallback({ message: 'Checking subscription...', progress: 0.03 });

    try {
      const response = await axios.get(`${baseUrl}/api/cloud/usage`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Device-UUID': this.deviceUuid
        },
        timeout: 30000
      });

      const data = response.data || {};
      const subscription = data.subscription || {};
      const planGb = data.planGb;
      const status = subscription.status;

      // Check if user has an active subscription or trial
      if (status === 'active' || status === 'trial') {
        return {
          allowed: true,
          planGb,
          status,
          usedBytes: data.usedBytes || 0,
          remainingBytes: data.remainingBytes || 0,
          quotaBytes: data.quotaBytes || 0
        };
      }

      // No active subscription
      return {
        allowed: false,
        planGb: null,
        status: status || 'none',
        reason: this.getSubscriptionMessage(status),
        remainingBytes: 0
      };
    } catch (error) {
      // If we can't check subscription, allow backup to proceed (fail gracefully)
      console.error('Subscription check failed:', error.message);
      return { allowed: true, status: 'unknown', remainingBytes: null };
    }
  }

  checkSpaceForFiles(files, remainingBytes) {
    if (remainingBytes === null || remainingBytes === undefined) {
      return { hasSpace: true, totalSize: 0, remainingBytes: null };
    }

    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    // Add 10% buffer for encryption overhead
    const requiredSpace = Math.ceil(totalSize * 1.1);

    return {
      hasSpace: requiredSpace <= remainingBytes,
      totalSize,
      requiredSpace,
      remainingBytes
    };
  }

  getSubscriptionMessage(status) {
    switch (status) {
      case 'none':
        return 'No active subscription. Open PhotoLynk on your mobile device to subscribe.';
      case 'trial_expired':
        return 'Your free trial has expired. Open PhotoLynk on your mobile device to subscribe.';
      case 'grace':
      case 'grace_expired':
        return 'Your subscription has expired. Open PhotoLynk on your mobile device to renew.';
      case 'deleted':
        return 'Your account data has been deleted due to expired subscription.';
      default:
        return 'Subscription required. Open PhotoLynk on your mobile device to subscribe.';
    }
  }

  // Generate device UUID same way as mobile app: uuidv5(email:password, namespace)
  getDeviceId() {
    const normalizedEmail = (this.config.email || '').trim().toLowerCase();
    const password = this.config.password || '';
    return uuidv5(`${normalizedEmail}:${password}`, UUID_NAMESPACE);
  }

  getDeviceName() {
    const os = require('os');
    const hostname = os.hostname() || 'Desktop';
    const platform = os.platform();
    const platformName = platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Linux';
    return `${hostname} (${platformName} Desktop)`;
  }

  // Derive master key from password (same as mobile app)
  deriveMasterKey(password, email) {
    const salt = email.toLowerCase().trim();
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    return new Uint8Array(key);
  }

  // Create chunk nonce from base nonce + chunk index (same as mobile)
  // Mobile uses little-endian byte order for the chunk index
  makeChunkNonce(baseNonce16, chunkIndex) {
    const nonce = new Uint8Array(24);
    nonce.set(baseNonce16, 0);
    // Write chunk index as little-endian 64-bit at bytes 16-23 (matching mobile)
    let x = BigInt(chunkIndex);
    for (let i = 0; i < 8; i++) {
      nonce[16 + i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return nonce;
  }

  // Upload encrypted chunk to StealthCloud
  async uploadChunk(chunkId, encryptedBytes) {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/cloud/chunks`;

    try {
      await axios.post(url, Buffer.from(encryptedBytes), {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Id': chunkId,
          'X-Device-UUID': this.deviceUuid
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
    } catch (error) {
      if (error.response) {
        console.error('Chunk upload error:', error.response.status, error.response.data);
      }
      throw error;
    }
  }

  async uploadClassicRawFile(file) {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/upload/raw`;
    const filePath = file && file.path ? file.path : null;
    const fileName = file && file.name ? file.name : null;
    if (!filePath || !fileName) throw new Error('Invalid file');

    const stream = fs.createReadStream(filePath);
    const response = await axios.post(url, stream, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'X-Device-UUID': this.deviceUuid,
        'X-Filename': fileName,
        'Content-Type': 'application/octet-stream'
      },
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    // Check for server-side hash duplicate
    if (response.data && response.data.duplicate) {
      return { duplicate: true };
    }
    return { duplicate: false };
  }

  async getExistingClassicFilenames() {
    const baseUrl = this.getBaseUrl();
    const out = new Set();
    const pageLimit = 500;
    let offset = 0;

    while (true) {
      const response = await axios.get(`${baseUrl}/api/files`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Device-UUID': this.deviceUuid
        },
        params: { offset, limit: pageLimit },
        timeout: 30000
      });

      const files = (response.data && response.data.files) ? response.data.files : [];
      for (const f of files) {
        const n = this.normalizeFilenameForCompare(f && f.filename ? f.filename : null);
        if (n) out.add(n);
      }

      if (!files || files.length < pageLimit) break;
      offset += files.length;
      const total = typeof response.data?.total === 'number' ? response.data.total : null;
      if (typeof total === 'number' && offset >= total) break;
    }

    return out;
  }

  // Upload manifest to StealthCloud
  async uploadManifest(manifestId, encryptedManifest, chunkCount) {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/cloud/manifests`;

    await axios.post(url, {
      manifestId,
      encryptedManifest,
      chunkCount
    }, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-Device-UUID': this.deviceUuid
      },
      timeout: 30000
    });
  }

  // Get existing manifests to skip already backed up files
  async getExistingManifests() {
    const baseUrl = this.getBaseUrl();
    try {
      const response = await axios.get(`${baseUrl}/api/cloud/manifests`, {
        headers: { 
          'Authorization': `Bearer ${this.token}`,
          'X-Device-UUID': this.deviceUuid
        },
        timeout: 30000
      });
      return (response.data && response.data.manifests) || [];
    } catch (error) {
      console.error('Failed to get existing manifests:', error.message);
      return [];
    }
  }

  async uploadFile(file, fileIndex, totalFiles) {
    const filePath = file.path;
    const fileName = file.name;
    const fileSize = file.size;

    // Generate manifest ID from file path (deterministic)
    const manifestId = crypto.createHash('sha256').update(`desktop:${filePath}`).digest('hex');

    // Generate per-file key and base nonce
    const fileKey = new Uint8Array(32);
    crypto.randomFillSync(fileKey);
    const baseNonce16 = new Uint8Array(16);
    crypto.randomFillSync(baseNonce16);

    // Wrap fileKey with masterKey
    const wrapNonce = new Uint8Array(24);
    crypto.randomFillSync(wrapNonce);
    const wrappedKey = nacl.secretbox(fileKey, wrapNonce, this.masterKey);

    const chunkIds = [];
    const chunkSizes = [];
    const runChunkUpload = this._runChunkUpload || (this._runChunkUpload = createConcurrencyLimiter(MAX_PARALLEL_CHUNK_UPLOADS));
    const inFlight = new Set();
    let chunkIndex = 0;
    let position = 0;
    let uploadedChunks = 0;
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      stream.on('error', reject);
      stream.on('data', (buf) => {
        stream.pause();
        (async () => {
          if (this.cancelled) throw new Error('Backup cancelled');

          const plaintext = new Uint8Array(buf);
          const nonce = this.makeChunkNonce(baseNonce16, chunkIndex);
          const boxed = nacl.secretbox(plaintext, nonce, fileKey);
          const chunkId = crypto.createHash('sha256').update(Buffer.from(boxed)).digest('hex');

          chunkIds.push(chunkId);
          chunkSizes.push(plaintext.length);

          const p = runChunkUpload(async () => {
            await this.uploadChunk(chunkId, boxed);
            uploadedChunks++;
            this.progressCallback({
              message: `Uploading ${fileName} (${uploadedChunks}/${totalChunks} chunks)`,
              progress: 0.1 + ((fileIndex + Math.min(1, (position / Math.max(1, fileSize)))) / Math.max(1, totalFiles)) * 0.85
            });
          });

          await trackInFlightPromise(inFlight, p, MAX_PARALLEL_CHUNK_UPLOADS);

          chunkIndex++;
          position += plaintext.length;
          stream.resume();
        })().catch((e) => {
          try { stream.destroy(); } catch (e2) {}
          reject(e);
        });
      });
      stream.on('end', () => resolve());
    });

    await drainInFlightPromises(inFlight);

    // Build manifest
    const manifest = {
      v: 1,
      assetId: `desktop:${filePath}`,
      filename: fileName,
      mediaType: this.getMediaType(fileName),
      originalSize: fileSize,
      baseNonce16: naclUtil.encodeBase64(baseNonce16),
      wrapNonce: naclUtil.encodeBase64(wrapNonce),
      wrappedFileKey: naclUtil.encodeBase64(wrappedKey),
      chunkIds,
      chunkSizes
    };

    // Encrypt manifest with masterKey
    const manifestPlain = naclUtil.decodeUTF8(JSON.stringify(manifest));
    const manifestNonce = new Uint8Array(24);
    crypto.randomFillSync(manifestNonce);
    const manifestBox = nacl.secretbox(manifestPlain, manifestNonce, this.masterKey);
    const encryptedManifest = JSON.stringify({
      manifestNonce: naclUtil.encodeBase64(manifestNonce),
      manifestBox: naclUtil.encodeBase64(manifestBox)
    });

    // Upload manifest
    await this.uploadManifest(manifestId, encryptedManifest, chunkIds.length);

    return { uploaded: true, manifestId };
  }

  getMediaType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.webm'];
    return videoExts.includes(ext) ? 'video' : 'photo';
  }

  async backup(mediaFiles) {
    if (!mediaFiles || mediaFiles.length === 0) {
      throw new Error('No files to backup');
    }

    // Login first
    await this.login();

    const isStealthCloud = this.config.destination === 'stealthcloud';

    let existingIds = null;
    let existingClassic = null;

    if (isStealthCloud) {
      // Derive master key (same as mobile app)
      this.masterKey = this.deriveMasterKey(this.config.password, this.config.email);
      this.progressCallback({ message: 'Checking existing backups...', progress: 0.05 });
      const existingManifests = await this.getExistingManifests();
      existingIds = new Set(existingManifests.map(m => m.manifestId));
    } else {
      this.progressCallback({ message: 'Checking existing backups...', progress: 0.05 });
      existingClassic = await this.getExistingClassicFilenames();
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    const toUpload = [];
    for (let i = 0; i < mediaFiles.length; i++) {
      const file = mediaFiles[i];
      if (!file) continue;

      if (isStealthCloud) {
        const manifestId = crypto.createHash('sha256').update(`desktop:${file.path}`).digest('hex');
        if (existingIds && existingIds.has(manifestId)) {
          skipped++;
          continue;
        }
        toUpload.push(file);
        continue;
      }

      const normalized = this.normalizeFilenameForCompare(file && file.name ? file.name : null);
      if (normalized && existingClassic && existingClassic.has(normalized)) {
        skipped++;
        continue;
      }
      toUpload.push(file);
    }

    if (isStealthCloud && this.config && this.config._subscriptionStatus) {
      const remainingBytes = this.config._subscriptionStatus.remainingBytes;
      const spaceCheck = this.checkSpaceForFiles(toUpload, remainingBytes);
      if (!spaceCheck.hasSpace) {
        const err = new Error('Not enough cloud storage. Please upgrade your plan in the PhotoLynk mobile app.');
        err.code = 'INSUFFICIENT_SPACE';
        err.requiredSpace = spaceCheck.requiredSpace;
        err.remainingBytes = spaceCheck.remainingBytes;
        throw err;
      }
    }

    const totalFiles = Math.max(1, toUpload.length);
    const runFileUpload = createConcurrencyLimiter(MAX_PARALLEL_FILE_UPLOADS);
    let processed = 0;

    const tasks = toUpload.map((file, idx) => runFileUpload(async () => {
      if (this.cancelled) return;
      try {
        if (isStealthCloud) {
          const res = await this.uploadFile(file, idx, totalFiles);
          if (existingIds && res && res.manifestId) existingIds.add(res.manifestId);
          uploaded++;
        } else {
          this.progressCallback({
            message: `Uploading ${file.name}`,
            progress: 0.1 + (idx / totalFiles) * 0.9
          });
          const res = await this.uploadClassicRawFile(file);
          const normalized = this.normalizeFilenameForCompare(file && file.name ? file.name : null);
          if (normalized && existingClassic) existingClassic.add(normalized);
          // Server-side hash duplicate detection
          if (res && res.duplicate) {
            skipped++;
          } else {
            uploaded++;
          }
        }
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error.message);
        failed++;
      } finally {
        processed++;
        this.progressCallback({
          message: `Uploading ${processed}/${totalFiles}`,
          progress: 0.1 + (processed / totalFiles) * 0.9
        });
      }
    }));

    await Promise.all(tasks);

    // Final progress callback with complete stats
    this.progressCallback({
      message: `Uploaded: ${uploaded} | Skipped: ${skipped} | Failed: ${failed}`,
      progress: 1.0
    });

    return {
      total: mediaFiles.length,
      uploaded,
      skipped,
      failed
    };
  }

  cancel() {
    this.cancelled = true;
  }
}

module.exports = { DesktopBackupClient };
