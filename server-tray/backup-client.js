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
      const host = this.config.remoteAddress;
      const port = this.config.remotePort || '3000';
      return `https://${host}:${port}`;
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
    await axios.post(url, stream, {
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

  // Upload a single file with encryption (same logic as mobile app)
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

    // Read file and encrypt chunks
    const fileBuffer = fs.readFileSync(filePath);
    const chunkIds = [];
    const chunkSizes = [];
    let chunkIndex = 0;
    let position = 0;

    while (position < fileBuffer.length) {
      if (this.cancelled) {
        throw new Error('Backup cancelled');
      }

      const end = Math.min(position + CHUNK_SIZE, fileBuffer.length);
      const plaintext = new Uint8Array(fileBuffer.slice(position, end));

      // Encrypt chunk with NaCl secretbox
      const nonce = this.makeChunkNonce(baseNonce16, chunkIndex);
      const boxed = nacl.secretbox(plaintext, nonce, fileKey);

      // Chunk ID = SHA256 of encrypted data
      const chunkId = crypto.createHash('sha256').update(Buffer.from(boxed)).digest('hex');

      // Upload chunk
      this.progressCallback({
        message: `Uploading ${fileName} (chunk ${chunkIndex + 1})`,
        progress: 0.1 + ((fileIndex + (position / fileSize)) / totalFiles) * 0.9
      });

      await this.uploadChunk(chunkId, boxed);

      chunkIds.push(chunkId);
      chunkSizes.push(plaintext.length);
      chunkIndex++;
      position = end;
    }

    if (chunkIds.length === 0) {
      throw new Error('No chunks created for file');
    }

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

    for (let i = 0; i < mediaFiles.length; i++) {
      if (this.cancelled) {
        break;
      }

      const file = mediaFiles[i];

      if (isStealthCloud) {
        const manifestId = crypto.createHash('sha256').update(`desktop:${file.path}`).digest('hex');
        if (existingIds && existingIds.has(manifestId)) {
          skipped++;
          this.progressCallback({
            message: `Skipping ${file.name} (already backed up)`,
            progress: 0.1 + (i / mediaFiles.length) * 0.9
          });
          continue;
        }
      } else {
        const normalized = this.normalizeFilenameForCompare(file && file.name ? file.name : null);
        if (normalized && existingClassic && existingClassic.has(normalized)) {
          skipped++;
          this.progressCallback({
            message: `Skipping ${file.name} (already backed up)`,
            progress: 0.1 + (i / mediaFiles.length) * 0.9
          });
          continue;
        }
      }

      try {
        if (isStealthCloud) {
          const res = await this.uploadFile(file, i, mediaFiles.length);
          if (existingIds && res && res.manifestId) existingIds.add(res.manifestId);
        } else {
          this.progressCallback({
            message: `Uploading ${file.name}`,
            progress: 0.1 + (i / mediaFiles.length) * 0.9
          });
          await this.uploadClassicRawFile(file);
          const normalized = this.normalizeFilenameForCompare(file && file.name ? file.name : null);
          if (normalized && existingClassic) existingClassic.add(normalized);
        }
        uploaded++;
      } catch (error) {
        console.error(`Failed to upload ${file.name}:`, error.message);
        failed++;
      }

      this.progressCallback({
        message: `Processed ${i + 1}/${mediaFiles.length} files`,
        progress: 0.1 + ((i + 1) / mediaFiles.length) * 0.9
      });
    }

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
