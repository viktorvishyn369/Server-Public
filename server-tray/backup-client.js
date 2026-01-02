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
const sharp = require('sharp');
const heicDecode = require('heic-decode');

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks (same as mobile)
const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // Same as mobile app

const MAX_PARALLEL_CHUNK_UPLOADS = 8;
const MAX_PARALLEL_FILE_UPLOADS = 6;
const MAX_PARALLEL_MANIFEST_FETCHES = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Retry helper with exponential backoff
async function withRetry(fn, maxRetries = MAX_RETRIES, baseDelay = RETRY_DELAY_MS) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.code === 'ETIMEDOUT' || 
                          error.code === 'ECONNRESET' || 
                          error.code === 'ECONNREFUSED' ||
                          error.code === 'ENOTFOUND' ||
                          error.message?.includes('timeout') ||
                          error.message?.includes('ETIMEDOUT') ||
                          (error.response && error.response.status >= 500);
      
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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

// Compute stable file identity from filename + size (same as mobile)
function computeFileIdentity(filename, originalSize) {
  if (!filename || typeof filename !== 'string') return null;
  const normalized = filename.trim().toLowerCase();
  if (!normalized) return null;
  const sizeStr = typeof originalSize === 'number' && !Number.isNaN(originalSize) ? String(originalSize) : '';
  return `${normalized}:${sizeStr}`;
}

// Compute exact file hash (SHA-256 of plaintext bytes) for deduplication
// Same logic as mobile app's computeExactFileHash
async function computeExactFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => reject(err));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Hamming distance for 16-char hex hash (64 bits) - for dHash cross-platform deduplication
function hammingDistance64(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < 16; i += 8) {
    const valA = parseInt(a.substring(i, i + 8), 16);
    const valB = parseInt(b.substring(i, i + 8), 16);
    let x = valA ^ valB;
    while (x) {
      dist += x & 1;
      x >>>= 1;
    }
  }
  return dist;
}

// Cross-platform deduplication threshold for 64-bit dHash
// Threshold of 6 bits to account for HEIC decoder differences across platforms
// (heic-convert on desktop vs native ImageIO on iOS vs ImageDecoder on Android)
// 6 bits = ~9% difference tolerance, still strict enough to avoid false positives
const CROSS_PLATFORM_DHASH_THRESHOLD = 6;

// Find a matching perceptual hash using Hamming distance (fuzzy matching)
// Returns { match: boolean, distance: number } for logging
function findPerceptualHashMatch(hash, hashSet, threshold = CROSS_PLATFORM_DHASH_THRESHOLD) {
  if (!hash || hash.length !== 16 || !hashSet || hashSet.size === 0) return { match: false, distance: -1 };
  
  // First check exact match (fast path)
  if (hashSet.has(hash)) return { match: true, distance: 0 };
  
  // Check Hamming distance for fuzzy match
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const existingHash of hashSet) {
    if (existingHash && existingHash.length === 16) {
      const dist = hammingDistance64(hash, existingHash);
      if (dist < bestDistance) bestDistance = dist;
      if (dist <= threshold) {
        return { match: true, distance: dist };
      }
    }
  }
  return { match: false, distance: bestDistance };
}

// Compute perceptual hash (dHash) for images - transcoding-resistant visual deduplication
// IDENTICAL implementation to mobile iOS/Android - custom bilinear scaling
// Returns { hash } for deduplication
async function computePerceptualHash(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif', '.avif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf'];
    
    if (!imageExts.includes(ext)) {
      return null; // Only process images
    }

    let srcData, srcWidth, srcHeight, srcChannels;
    
    // HEIC/HEIF files: use heic-decode for direct pixel access (no JPEG conversion)
    // CRITICAL: Canonicalize HEIC pixels for cross-platform consistency:
    // 1. Decode FIRST image only (ignore auxiliary images/depth/HDR)
    // 2. Apply EXIF orientation transform
    // 3. Ensure sRGB colorspace
    // 4. Then compute perceptual hash
    if (ext === '.heic' || ext === '.heif') {
      try {
        const inputBuffer = fs.readFileSync(filePath);
        // heic-decode automatically decodes the PRIMARY image (first image in container)
        // and ignores auxiliary images (depth maps, HDR gain maps, thumbnails)
        const decoded = await heicDecode({ buffer: inputBuffer });
        
        // heic-decode returns Uint8ClampedArray with RGBA pixels (straight alpha)
        // iOS uses CGContext with premultipliedLast, but since alpha is always 255 for HEIC,
        // premultiplied vs straight makes no difference: RGB_premul = RGB * (255/255) = RGB
        srcData = Buffer.from(decoded.data);
        srcWidth = decoded.width;
        srcHeight = decoded.height;
        srcChannels = 4; // RGBA
        
        // Apply EXIF orientation to canonicalize image
        // This ensures Desktop HEIC = iOS HEIC = Android HEIC regardless of orientation flags
        try {
          const exifData = await sharp(filePath).metadata();
          const orientation = exifData.orientation || 1;
          
          if (orientation !== 1 && orientation !== undefined) {
            // Need to apply orientation transform to pixel buffer
            // Use Sharp to apply orientation, then extract raw pixels
            const orientedBuffer = await sharp(srcData, {
              raw: {
                width: srcWidth,
                height: srcHeight,
                channels: srcChannels
              }
            })
            .rotate() // Apply EXIF orientation
            .raw()
            .toBuffer({ resolveWithObject: true });
            
            srcData = orientedBuffer.data;
            srcWidth = orientedBuffer.info.width;
            srcHeight = orientedBuffer.info.height;
            srcChannels = orientedBuffer.info.channels;
          }
        } catch (orientErr) {
          // If orientation fails, continue with original pixels
          // (better to have unoriented hash than no hash)
          console.warn(`[HEIC] Orientation failed for ${path.basename(filePath)}:`, orientErr.message);
        }
      } catch (heicErr) {
        console.warn(`[HEIC] Failed to decode ${path.basename(filePath)}:`, heicErr.message);
        return null;
      }
    } else {
      // For other formats (JPG/PNG/etc), use Sharp
      // Apply EXIF orientation for canonicalization (matches mobile behavior)
      const { data, info } = await sharp(filePath, { failOn: 'none' })
        .rotate() // Apply EXIF orientation
        .raw()
        .toBuffer({ resolveWithObject: true });
      srcData = data;
      srcWidth = info.width;
      srcHeight = info.height;
      srcChannels = info.channels;
    }
    
    // Custom bilinear scaling to 9x8 (IDENTICAL to iOS/Android implementation)
    const hashWidth = 9;
    const hashHeight = 8;
    const scaledPixels = new Uint8Array(hashWidth * hashHeight * 3); // RGB
    
    const xRatio = (srcWidth - 1) / (hashWidth - 1);
    const yRatio = (srcHeight - 1) / (hashHeight - 1);
    
    for (let y = 0; y < hashHeight; y++) {
      for (let x = 0; x < hashWidth; x++) {
        const srcX = x * xRatio;
        const srcY = y * yRatio;
        
        const x1 = Math.floor(srcX);
        const y1 = Math.floor(srcY);
        const x2 = Math.min(x1 + 1, srcWidth - 1);
        const y2 = Math.min(y1 + 1, srcHeight - 1);
        
        const xWeight = srcX - x1;
        const yWeight = srcY - y1;
        
        for (let c = 0; c < 3; c++) {
          const p11 = srcData[(y1 * srcWidth + x1) * srcChannels + c];
          const p21 = srcData[(y1 * srcWidth + x2) * srcChannels + c];
          const p12 = srcData[(y2 * srcWidth + x1) * srcChannels + c];
          const p22 = srcData[(y2 * srcWidth + x2) * srcChannels + c];
          
          // Match iOS two-step bilinear interpolation exactly
          const top = p11 * (1.0 - xWeight) + p21 * xWeight;
          const bottom = p12 * (1.0 - xWeight) + p22 * xWeight;
          const value = top * (1.0 - yWeight) + bottom * yWeight;
          
          // Match iOS rounding: UInt8(value + 0.5) = floor(value + 0.5) = round(value)
          scaledPixels[(y * hashWidth + x) * 3 + c] = Math.round(value);
        }
      }
    }
    
    // Compute grayscale values (IDENTICAL to iOS/Android)
    const grayValues = new Uint8Array(hashWidth * hashHeight);
    for (let i = 0; i < hashWidth * hashHeight; i++) {
      const r = scaledPixels[i * 3];
      const g = scaledPixels[i * 3 + 1];
      const b = scaledPixels[i * 3 + 2];
      grayValues[i] = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
    }
    
    // Build dHash: compare each pixel to its right neighbor (IDENTICAL to iOS/Android)
    const hashBytes = new Uint8Array(8);
    let bitIndex = 0;
    
    for (let y = 0; y < hashHeight; y++) {
      for (let x = 0; x < hashWidth - 1; x++) {
        const leftPixel = grayValues[y * hashWidth + x];
        const rightPixel = grayValues[y * hashWidth + x + 1];
        
        if (leftPixel < rightPixel) {
          const byteIndex = Math.floor(bitIndex / 8);
          const bitPos = 7 - (bitIndex % 8);
          hashBytes[byteIndex] |= (1 << bitPos);
        }
        bitIndex++;
      }
    }
    
    // Convert to hex string
    let hexHash = '';
    for (let i = 0; i < hashBytes.length; i++) {
      hexHash += hashBytes[i].toString(16).padStart(2, '0');
    }
    
    return { hash: hexHash };
  } catch (e) {
    console.warn('computePerceptualHash failed:', filePath, e.message);
    return null;
  }
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

  // Extract base filename for cross-platform variant deduplication
  // Handles iOS, Android/Google Photos, Windows, and Linux naming patterns:
  // iOS: IMG_1234_1_105_c.jpeg, IMG_1234_4_5005_c.jpeg
  // Android/Google: IMG_20231225_123456_1.jpg, PXL_20231225_123456~2.jpg
  // Windows: IMG_1234 (2).jpg, IMG_1234 - Copy.jpg
  // Linux: IMG_1234 (copy).jpg, IMG_1234_copy.jpg
  extractBaseFilename(name) {
    if (!name || typeof name !== 'string') return null;
    const base = path.basename(name);
    const trimmed = (base || '').trim().toLowerCase();
    if (!trimmed) return null;
    
    // Remove extension first
    const extMatch = trimmed.match(/^(.+)\.(\w+)$/);
    if (!extMatch) return trimmed;
    let nameWithoutExt = extMatch[1];
    
    // iOS variant patterns: _1_105_c, _4_5005_c, _1_201_a, _2_100_a, etc.
    // These are iOS thumbnail/preview suffixes - always strip
    nameWithoutExt = nameWithoutExt.replace(/_\d+_\d+_[a-z]$/, '');
    
    // Android/Google Photos burst/edit patterns:
    // Only match patterns that are clearly copy indicators, NOT image numbers
    // IMG_20231225_123456_1 -> IMG_20231225_123456 (burst copy after timestamp)
    // But IMG_5730 should stay as IMG_5730 (that's the image number, not a copy)
    nameWithoutExt = nameWithoutExt.replace(/(_\d{6,})_\d{1,2}$/, '$1'); // Strip _1, _2 only after 6+ digit timestamp
    nameWithoutExt = nameWithoutExt.replace(/~\d+$/, '');           // ~2, ~3 (Google edited)
    nameWithoutExt = nameWithoutExt.replace(/-(edit|edited|collage|animation)$/i, '');
    nameWithoutExt = nameWithoutExt.replace(/_burst\d*$/i, '');     // _BURST001
    
    // Windows patterns:
    nameWithoutExt = nameWithoutExt.replace(/ \(\d+\)$/, '');       // " (2)" with space
    nameWithoutExt = nameWithoutExt.replace(/\(\d+\)$/, '');        // "(2)" no space
    nameWithoutExt = nameWithoutExt.replace(/ - copy( \(\d+\))?$/i, ''); // " - Copy" or " - Copy (2)"
    
    // Linux patterns:
    nameWithoutExt = nameWithoutExt.replace(/ \(copy\)$/i, '');     // " (copy)"
    nameWithoutExt = nameWithoutExt.replace(/_copy\d*$/i, '');      // "_copy", "_copy2"
    nameWithoutExt = nameWithoutExt.replace(/\.bak$/i, '');         // ".bak" backup suffix
    
    // Generic patterns (all platforms):
    nameWithoutExt = nameWithoutExt.replace(/_backup$/i, '');       // "_backup"
    nameWithoutExt = nameWithoutExt.replace(/-backup$/i, '');       // "-backup"
    nameWithoutExt = nameWithoutExt.replace(/_original$/i, '');     // "_original"
    
    return nameWithoutExt.trim();
  }

  // Normalize date for comparison - extracts YYYY-MM-DD format
  // Handles various date formats: ISO strings, timestamps, Date objects
  normalizeDateForCompare(dateVal) {
    if (!dateVal) return null;
    try {
      let date;
      if (typeof dateVal === 'number') {
        // Unix timestamp (seconds or milliseconds)
        date = new Date(dateVal > 9999999999 ? dateVal : dateVal * 1000);
      } else if (typeof dateVal === 'string') {
        date = new Date(dateVal);
      } else if (dateVal instanceof Date) {
        date = dateVal;
      } else {
        return null;
      }
      if (isNaN(date.getTime())) return null;
      // Return YYYY-MM-DD format for comparison
      return date.toISOString().split('T')[0];
    } catch (e) {
      return null;
    }
  }

  // Normalize full timestamp for HEIC deduplication - extracts YYYY-MM-DDTHH:MM:SS format
  // This provides second-level precision for matching HEIC files across platforms
  // HEIC files from iPhone and desktop have identical EXIF timestamps even if bytes differ
  normalizeFullTimestamp(dateVal) {
    if (!dateVal) return null;
    try {
      let date;
      if (typeof dateVal === 'number') {
        // Unix timestamp (seconds or milliseconds)
        date = new Date(dateVal > 9999999999 ? dateVal : dateVal * 1000);
      } else if (typeof dateVal === 'string') {
        date = new Date(dateVal);
      } else if (dateVal instanceof Date) {
        date = dateVal;
      } else {
        return null;
      }
      if (isNaN(date.getTime())) return null;
      // Return YYYY-MM-DDTHH:MM:SS format (second-level precision, no milliseconds)
      return date.toISOString().slice(0, 19);
    } catch (e) {
      return null;
    }
  }

  // Extract real EXIF data from image file for cross-platform deduplication
  // Returns { captureTime, make, model } - the actual EXIF metadata from the file
  async extractExifForDedup(filePath) {
    const result = { captureTime: null, make: null, model: null };
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    try {
      // Use exifreader for HEIC files (Sharp can't read HEIC EXIF properly)
      // Use Sharp + exif-reader for other formats
      let tags;
      
      if (ext === '.heic' || ext === '.heif') {
        const ExifReader = require('exifreader');
        tags = await ExifReader.load(filePath);
        
        // Extract DateTimeOriginal
        const dateTimeOriginal = tags['DateTimeOriginal']?.description || tags['DateTime']?.description;
        if (dateTimeOriginal) {
          // EXIF format: "YYYY:MM:DD HH:MM:SS" -> ISO format: "YYYY-MM-DDTHH:MM:SS"
          const normalized = dateTimeOriginal.replace(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/, '$1-$2-$3T$4');
          result.captureTime = normalized;
        }
        
        // Extract Make - normalize to lowercase
        const make = tags['Make']?.description;
        if (make && typeof make === 'string') {
          result.make = make.trim().toLowerCase();
        }
        
        // Extract Model - normalize to lowercase
        const model = tags['Model']?.description;
        if (model && typeof model === 'string') {
          result.model = model.trim().toLowerCase();
        }
      } else {
        // For non-HEIC files, use Sharp + exif-reader
        const metadata = await sharp(filePath).metadata();
        
        if (metadata.exif) {
          const exifReader = require('exif-reader');
          const exifData = exifReader(metadata.exif);
          
          // Extract DateTimeOriginal from EXIF
          const exifDate = exifData?.exif?.DateTimeOriginal || exifData?.exif?.DateTimeDigitized || exifData?.image?.ModifyDate;
          if (exifDate instanceof Date && !isNaN(exifDate.getTime())) {
            result.captureTime = exifDate.toISOString().slice(0, 19);
          }
          
          // Extract Make (manufacturer) - normalize to lowercase
          if (exifData?.image?.Make && typeof exifData.image.Make === 'string') {
            result.make = exifData.image.Make.trim().toLowerCase();
          }
          
          // Extract Model - normalize to lowercase
          if (exifData?.image?.Model && typeof exifData.image.Model === 'string') {
            result.model = exifData.image.Model.trim().toLowerCase();
          }
        }
      }
    } catch (e) {
      console.warn(`[EXIF] Extraction failed for ${filePath}:`, e.message);
    }
    return result;
  }

  // Generate EXIF-based deduplication keys for matching across platforms
  // Priority: captureTime+make+model > captureTime+model > captureTime+make
  generateExifDedupKeys(exifData) {
    const { captureTime, make, model } = exifData || {};
    return {
      full: (captureTime && make && model) ? `${captureTime}|${make}|${model}` : null,
      timeModel: (captureTime && model) ? `${captureTime}|${model}` : null,
      timeMake: (captureTime && make) ? `${captureTime}|${make}` : null,
      timeOnly: captureTime || null,
    };
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

    return withRetry(async () => {
      try {
        const response = await axios.post(`${baseUrl}/api/login`, {
          email: this.config.email,
          password: this.config.password,
          device_uuid: this.getDeviceId(),
          device_name: this.getDeviceName()
        }, {
          timeout: 45000,
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
    });
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
    const key = crypto.pbkdf2Sync(password, salt, 30000, 32, 'sha256');
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

  // Upload encrypted chunk to StealthCloud with retry
  async uploadChunk(chunkId, encryptedBytes) {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/cloud/chunks`;

    return withRetry(async () => {
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
    }, 3, 2000); // 3 retries with 2s base delay for chunks
  }

  async uploadClassicRawFile(file) {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/upload/raw`;
    const filePath = file && file.path ? file.path : null;
    const fileName = file && file.name ? file.name : null;
    if (!filePath || !fileName) throw new Error('Invalid file');

    return withRetry(async () => {
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
    }, 3, 2000); // 3 retries with 2s base delay
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

    const response = await axios.post(url, {
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

    // Return server response for duplicate detection
    return response.data;
  }

  // Get existing manifests to skip already backed up files (with pagination and retry)
  async getExistingManifests() {
    const baseUrl = this.getBaseUrl();
    const allManifests = [];
    const pageLimit = 500;
    let offset = 0;

    try {
      while (true) {
        const response = await withRetry(async () => {
          return axios.get(`${baseUrl}/api/cloud/manifests`, {
            headers: { 
              'Authorization': `Bearer ${this.token}`,
              'X-Device-UUID': this.deviceUuid
            },
            params: { offset, limit: pageLimit },
            timeout: 60000
          });
        });

        const manifests = (response.data && response.data.manifests) || [];
        allManifests.push(...manifests);
        
        this.progressCallback({ message: `Found ${allManifests.length} existing backups...`, progress: 0.04 });

        if (!manifests || manifests.length < pageLimit) break;
        offset += manifests.length;
        const total = typeof response.data?.total === 'number' ? response.data.total : null;
        if (typeof total === 'number' && offset >= total) break;
      }

      return allManifests;
    } catch (error) {
      console.error('Failed to get existing manifests:', error.message);
      return allManifests; // Return what we have so far
    }
  }

  // Build deduplication sets by decrypting manifests (for cross-device duplicate detection)
  // Images: use perceptualHash only (ignore fileHash)
  // Videos: use fileHash only (no perceptualHash)
  // Also builds baseFilename+size and baseFilename+date maps for fallback matching
  // Uses parallel fetching for speed
  async buildDeduplicationSets(existingManifests) {
    const baseUrl = this.getBaseUrl();
    const alreadyFilenames = new Set();
    const alreadyBaseFilenames = new Set(); // For variant deduplication (iOS/Android/Windows/Linux)
    const alreadyFileHashes = new Set();
    const alreadyPerceptualHashes = new Set();
    const alreadyBaseNameSizes = new Map(); // baseFilename -> Set of sizes (fallback matching)
    const alreadyBaseNameDates = new Map(); // baseFilename -> Set of date strings (YYYY-MM-DD)
    const alreadyBaseNameTimestamps = new Map(); // baseFilename -> Set of full timestamps (YYYY-MM-DDTHH:MM:SS) for HEIC
    // EXIF-based deduplication sets for cross-platform HEIC matching
    const alreadyExifFull = new Set(); // captureTime|make|model (highest confidence)
    const alreadyExifTimeModel = new Set(); // captureTime|model
    const alreadyExifTimeMake = new Set(); // captureTime|make

    if (!existingManifests || existingManifests.length === 0) {
      return { alreadyFilenames, alreadyBaseFilenames, alreadyFileHashes, alreadyPerceptualHashes, alreadyBaseNameSizes, alreadyBaseNameDates, alreadyBaseNameTimestamps, alreadyExifFull, alreadyExifTimeModel, alreadyExifTimeMake };
    }

    const total = existingManifests.length;
    let processed = 0;
    const runFetch = createConcurrencyLimiter(MAX_PARALLEL_MANIFEST_FETCHES);

    const fetchManifest = async (m) => {
      try {
        const response = await withRetry(async () => {
          return axios.get(`${baseUrl}/api/cloud/manifests/${m.manifestId}`, {
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'X-Device-UUID': this.deviceUuid
            },
            timeout: 30000
          });
        }, 2, 500); // 2 retries with 500ms base delay for individual manifests

        const payload = response.data;
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const enc = JSON.parse(parsed.encryptedManifest);
        const manifestNonce = naclUtil.decodeBase64(enc.manifestNonce);
        const manifestBox = naclUtil.decodeBase64(enc.manifestBox);
        const manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, this.masterKey);

        if (manifestPlain) {
          const manifest = JSON.parse(naclUtil.encodeUTF8(manifestPlain));
          return manifest;
        }
      } catch (e) {
        // Skip manifests we can't decrypt or fetch
      }
      return null;
    };

    // Fetch all manifests in parallel with concurrency limit
    const tasks = existingManifests.map((m) => runFetch(async () => {
      const manifest = await fetchManifest(m);
      processed++;
      if (processed % 50 === 0 || processed === total) {
        this.progressCallback({ message: `Checking existing backups... ${processed}/${total}`, progress: 0.05 + (processed / total) * 0.03 });
      }
      return manifest;
    }));

    const results = await Promise.all(tasks);

    // Process results
    for (const manifest of results) {
      if (!manifest) continue;
      if (manifest.filename) {
        alreadyFilenames.add(this.normalizeFilenameForCompare(manifest.filename));
        // Extract base filename for variant matching (iOS/Android/Windows/Linux)
        const baseName = this.extractBaseFilename(manifest.filename);
        if (baseName) {
          alreadyBaseFilenames.add(baseName);
          
          // Build baseFilename -> sizes map for fallback matching
          if (manifest.originalSize || manifest.size) {
            if (!alreadyBaseNameSizes.has(baseName)) {
              alreadyBaseNameSizes.set(baseName, new Set());
            }
            alreadyBaseNameSizes.get(baseName).add(manifest.originalSize || manifest.size);
          }
          
          // Build baseFilename -> dates map for fallback matching
          // Use creationTime, modificationTime, or takenAt if available
          const dateVal = manifest.creationTime || manifest.modificationTime || manifest.takenAt;
          if (dateVal) {
            const dateStr = this.normalizeDateForCompare(dateVal);
            if (dateStr) {
              if (!alreadyBaseNameDates.has(baseName)) {
                alreadyBaseNameDates.set(baseName, new Set());
              }
              alreadyBaseNameDates.get(baseName).add(dateStr);
            }
            // Build full timestamp map for HEIC deduplication (second-level precision)
            const fullTimestamp = this.normalizeFullTimestamp(dateVal);
            if (fullTimestamp) {
              if (!alreadyBaseNameTimestamps.has(baseName)) {
                alreadyBaseNameTimestamps.set(baseName, new Set());
              }
              alreadyBaseNameTimestamps.get(baseName).add(fullTimestamp);
            }
          }
        }
      }
      // If manifest has perceptualHash, it's an image - use perceptual hash
      if (manifest.perceptualHash) {
        alreadyPerceptualHashes.add(manifest.perceptualHash);
      }
      // Always add fileHash if present (for both images and videos)
      // Images need fileHash for byte-identical dedup (AirDrop, copies)
      if (manifest.fileHash) {
        alreadyFileHashes.add(manifest.fileHash);
      }
      // Build EXIF-based deduplication keys from manifest
      // These are the real EXIF values extracted from the original file during upload
      if (manifest.exifCaptureTime) {
        const ct = manifest.exifCaptureTime;
        const mk = manifest.exifMake;
        const md = manifest.exifModel;
        // Generate dedup keys at different confidence levels
        if (ct && mk && md) alreadyExifFull.add(`${ct}|${mk}|${md}`);
        if (ct && md) alreadyExifTimeModel.add(`${ct}|${md}`);
        if (ct && mk) alreadyExifTimeMake.add(`${ct}|${mk}`);
      }
    }

    console.log(`Desktop: found ${alreadyFilenames.size} filenames, ${alreadyBaseFilenames.size} base names, ${alreadyBaseNameSizes.size} name+size entries, ${alreadyBaseNameDates.size} name+date entries, ${alreadyBaseNameTimestamps.size} name+timestamp entries, ${alreadyFileHashes.size} file hashes, ${alreadyPerceptualHashes.size} perceptual hashes, ${alreadyExifFull.size} EXIF full keys for deduplication`);
    return { alreadyFilenames, alreadyBaseFilenames, alreadyFileHashes, alreadyPerceptualHashes, alreadyBaseNameSizes, alreadyBaseNameDates, alreadyBaseNameTimestamps, alreadyExifFull, alreadyExifTimeModel, alreadyExifTimeMake };
  }

  async uploadFile(file, fileIndex, totalFiles, alreadyManifestIds, alreadyFilenames, alreadyBaseFilenames, alreadyFileHashes, alreadyPerceptualHashes, alreadyBaseNameSizes, alreadyBaseNameDates, alreadyBaseNameTimestamps, alreadyExifFull, alreadyExifTimeModel, alreadyExifTimeMake) {
    const filePath = file.path;
    const fileName = file.name;
    const fileSize = file.size;
    const fileModified = file.modified; // File modification date from scan

    // Generate stable cross-device manifestId from filename + size (same as mobile)
    const fileIdentity = computeFileIdentity(fileName, fileSize);
    const manifestId = fileIdentity ? crypto.createHash('sha256').update(`file:${fileIdentity}`).digest('hex') : crypto.createHash('sha256').update(`desktop:${filePath}`).digest('hex');

    // Skip if already uploaded (by stable manifestId)
    if (alreadyManifestIds && alreadyManifestIds.has(manifestId)) {
      console.log(`Skipping ${fileName} - manifestId already on server`);
      return { skipped: true, reason: 'manifestId' };
    }

    // Skip if filename already exists on server (fallback for old manifests without fileHash)
    const normalizedFilename = this.normalizeFilenameForCompare(fileName);
    if (normalizedFilename && alreadyFilenames && alreadyFilenames.has(normalizedFilename)) {
      console.log(`Skipping ${fileName} - filename already on server`);
      return { skipped: true, reason: 'filename' };
    }

    // Extract base filename for variant matching (iOS/Android/Windows/Linux patterns)
    const baseFilename = this.extractBaseFilename(fileName);
    
    // Skip if base filename already exists on server (catches all platform variants)
    if (baseFilename && alreadyBaseFilenames && alreadyBaseFilenames.has(baseFilename)) {
      console.log(`Skipping ${fileName} - variant of ${baseFilename} already on server`);
      return { skipped: true, reason: 'baseFilename' };
    }

    // HEIC PRIORITY: Full timestamp match (most reliable for cross-platform HEIC dedup)
    // HEIC files from iPhone and desktop have identical EXIF timestamps even if bytes differ
    if (baseFilename && fileModified && alreadyBaseNameTimestamps && alreadyBaseNameTimestamps.has(baseFilename)) {
      const fileTimestamp = this.normalizeFullTimestamp(fileModified);
      if (fileTimestamp) {
        const existingTimestamps = alreadyBaseNameTimestamps.get(baseFilename);
        if (existingTimestamps.has(fileTimestamp)) {
          console.log(`Skipping ${fileName} - baseFilename+timestamp match (${baseFilename}, ${fileTimestamp})`);
          return { skipped: true, reason: 'baseNameTimestamp' };
        }
      }
    }

    // EXIF-BASED DEDUP: Extract real EXIF from file and compare with manifest EXIF
    // This is the most reliable cross-platform HEIC dedup - uses actual camera metadata
    const fileExif = await this.extractExifForDedup(file.path);
    const fileExifKeys = this.generateExifDedupKeys(fileExif);
    
    // Priority 1: Full EXIF match (captureTime + make + model) - highest confidence
    if (fileExifKeys.full && alreadyExifFull && alreadyExifFull.has(fileExifKeys.full)) {
      console.log(`Skipping ${fileName} - EXIF full match (${fileExifKeys.full})`);
      return { skipped: true, reason: 'exifFull' };
    }
    // Priority 2: captureTime + model match
    if (fileExifKeys.timeModel && alreadyExifTimeModel && alreadyExifTimeModel.has(fileExifKeys.timeModel)) {
      console.log(`Skipping ${fileName} - EXIF time+model match (${fileExifKeys.timeModel})`);
      return { skipped: true, reason: 'exifTimeModel' };
    }
    // Priority 3: captureTime + make match
    if (fileExifKeys.timeMake && alreadyExifTimeMake && alreadyExifTimeMake.has(fileExifKeys.timeMake)) {
      console.log(`Skipping ${fileName} - EXIF time+make match (${fileExifKeys.timeMake})`);
      return { skipped: true, reason: 'exifTimeMake' };
    }

    // FALLBACK 1: Skip if baseFilename + similar size exists on server
    // This catches files re-compressed by iOS/Android overnight (size changes slightly)
    if (baseFilename && alreadyBaseNameSizes && alreadyBaseNameSizes.has(baseFilename)) {
      const existingSizes = alreadyBaseNameSizes.get(baseFilename);
      for (const existingSize of existingSizes) {
        // Allow 20% size tolerance for re-compression
        const sizeDiff = Math.abs(fileSize - existingSize) / Math.max(fileSize, existingSize);
        if (sizeDiff < 0.20) {
          console.log(`Skipping ${fileName} - baseFilename+size match (${baseFilename}, size diff ${(sizeDiff * 100).toFixed(1)}%)`);
          return { skipped: true, reason: 'baseNameSize' };
        }
      }
    }

    // FALLBACK 2: Skip if baseFilename + same date exists on server
    // This catches files with same name taken on same day (most reliable for overnight changes)
    if (baseFilename && fileModified && alreadyBaseNameDates && alreadyBaseNameDates.has(baseFilename)) {
      const fileDateStr = this.normalizeDateForCompare(fileModified);
      if (fileDateStr) {
        const existingDates = alreadyBaseNameDates.get(baseFilename);
        if (existingDates.has(fileDateStr)) {
          console.log(`Skipping ${fileName} - baseFilename+date match (${baseFilename}, date ${fileDateStr})`);
          return { skipped: true, reason: 'baseNameDate' };
        }
      }
    }

    // Determine if this is an image or video
    const ext = path.extname(fileName).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.heic', '.heif', '.avif', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf'];
    const isImage = imageExts.includes(ext);

    // For IMAGES: use perceptual hash (transcoding-resistant)
    // For VIDEOS: use exact file hash (byte-for-byte comparison)
    let exactFileHash = null;
    let perceptualHash = null;

    if (isImage) {
      // Images: compute perceptual hash for transcoding-resistant deduplication
      try {
        const hashResult = await computePerceptualHash(filePath);
        if (hashResult) {
          perceptualHash = hashResult.hash;
          console.log(`[PerceptualHash] ${fileName}: ${perceptualHash} (${perceptualHash.length} chars)`);
        }
      } catch (e) {
        console.warn(`computePerceptualHash failed for ${fileName}:`, e.message);
        perceptualHash = null;
      }

      // Skip if perceptual hash already exists on server (catches transcoded duplicates)
      // Use fuzzy matching with cross-platform threshold to handle decoder differences
      if (perceptualHash && alreadyPerceptualHashes && alreadyPerceptualHashes.size > 0) {
        console.log(`[PerceptualHash-Debug] ${fileName}: Comparing hash ${perceptualHash} against ${alreadyPerceptualHashes.size} server hashes`);
        const matchResult = findPerceptualHashMatch(perceptualHash, alreadyPerceptualHashes, CROSS_PLATFORM_DHASH_THRESHOLD);
        if (matchResult.match) {
          console.log(`Skipping ${fileName} - visually identical image already on server (perceptual match, distance=${matchResult.distance})`);
          return { skipped: true, reason: 'perceptualHash' };
        } else if (matchResult.distance > 0 && matchResult.distance <= 20) {
          // Log near-misses for debugging (distance > threshold but close)
          console.log(`[NearMiss] ${fileName}: closest match distance=${matchResult.distance} (threshold=${CROSS_PLATFORM_DHASH_THRESHOLD})`);
        } else {
          console.log(`[PerceptualHash-Debug] ${fileName}: No match found, closest distance=${matchResult.distance}`);
        }
      } else {
        console.log(`[PerceptualHash-Debug] ${fileName}: No server hashes to compare (set size: ${alreadyPerceptualHashes ? alreadyPerceptualHashes.size : 0})`);
      }

      // Also compute exact hash for storage in manifest and byte-identical dedup (AirDrop)
      try {
        exactFileHash = await computeExactFileHash(filePath);
      } catch (e) {
        console.warn(`computeExactFileHash failed for ${fileName}:`, e.message);
      }
      // Skip if exact file hash already exists on server (byte-identical, e.g. AirDrop)
      if (exactFileHash && alreadyFileHashes && alreadyFileHashes.has(exactFileHash)) {
        console.log(`Skipping ${fileName} - exact file hash already on server (byte-identical)`);
        return { skipped: true, reason: 'fileHash' };
      }
    } else {
      // Videos: compute exact file hash for byte-for-byte deduplication
      try {
        exactFileHash = await computeExactFileHash(filePath);
        console.log(`[FileHash] ${fileName}: ${exactFileHash ? exactFileHash.substring(0, 16) + '...' : 'null'}`);
      } catch (e) {
        console.warn(`computeExactFileHash failed for ${fileName}:`, e.message);
        exactFileHash = null;
      }

      // Skip if exact file hash already exists on server
      if (exactFileHash && alreadyFileHashes && alreadyFileHashes.has(exactFileHash)) {
        console.log(`Skipping ${fileName} - exact file hash already on server`);
        return { skipped: true, reason: 'fileHash' };
      }
    }

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

    // Extract real EXIF data from file for cross-platform deduplication
    // Sharp can read EXIF from HEIC files directly
    const exifData = await this.extractExifForDedup(filePath);
    if (exifData.captureTime) {
      console.log(`[EXIF] ${fileName}: time=${exifData.captureTime}, make=${exifData.make}, model=${exifData.model}`);
    } else if (ext === '.heic' || ext === '.heif') {
      console.log(`[EXIF] ${fileName}: no EXIF metadata found (file may have been stripped during transfer)`);
    }

    // Build manifest with fileHash and perceptualHash for cross-device deduplication
    const manifest = {
      v: 1,
      assetId: `desktop:${filePath}`,
      filename: fileName,
      mediaType: this.getMediaType(fileName),
      originalSize: fileSize,
      creationTime: fileModified ? fileModified.getTime() : null,
      // EXIF data for cross-platform HEIC deduplication
      exifCaptureTime: exifData.captureTime || null,
      exifMake: exifData.make || null,
      exifModel: exifData.model || null,
      baseNonce16: naclUtil.encodeBase64(baseNonce16),
      wrapNonce: naclUtil.encodeBase64(wrapNonce),
      wrappedFileKey: naclUtil.encodeBase64(wrappedKey),
      chunkIds,
      chunkSizes,
      fileHash: exactFileHash,
      perceptualHash: perceptualHash,
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

    // Upload manifest and check server response
    const manifestResponse = await this.uploadManifest(manifestId, encryptedManifest, chunkIds.length);

    // Check if server rejected as duplicate (server-side deduplication)
    if (manifestResponse && manifestResponse.skipped) {
      console.log(`Server rejected ${fileName} as duplicate (reason: ${manifestResponse.reason || 'unknown'})`);
      return { skipped: true, reason: manifestResponse.reason || 'server-side-duplicate' };
    }

    return { uploaded: true, manifestId, fileHash: exactFileHash, perceptualHash: perceptualHash };
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
    let alreadyFilenames = null;
    let alreadyBaseFilenames = null;
    let alreadyFileHashes = null;
    let alreadyPerceptualHashes = null;
    let alreadyBaseNameSizes = null;
    let alreadyBaseNameDates = null;
    let alreadyBaseNameTimestamps = null;
    let alreadyExifFull = null;
    let alreadyExifTimeModel = null;
    let alreadyExifTimeMake = null;

    if (isStealthCloud) {
      // Derive master key (same as mobile app)
      this.masterKey = this.deriveMasterKey(this.config.password, this.config.email);
      this.progressCallback({ message: 'Checking existing backups...', progress: 0.05 });
      const existingManifests = await this.getExistingManifests();
      existingIds = new Set(existingManifests.map(m => m.manifestId));
      
      // Build deduplication sets by decrypting manifests (same as mobile)
      const dedupeSets = await this.buildDeduplicationSets(existingManifests);
      alreadyFilenames = dedupeSets.alreadyFilenames;
      alreadyBaseFilenames = dedupeSets.alreadyBaseFilenames;
      alreadyFileHashes = dedupeSets.alreadyFileHashes;
      alreadyPerceptualHashes = dedupeSets.alreadyPerceptualHashes;
      alreadyBaseNameSizes = dedupeSets.alreadyBaseNameSizes;
      alreadyBaseNameDates = dedupeSets.alreadyBaseNameDates;
      alreadyBaseNameTimestamps = dedupeSets.alreadyBaseNameTimestamps;
      alreadyExifFull = dedupeSets.alreadyExifFull;
      alreadyExifTimeModel = dedupeSets.alreadyExifTimeModel;
      alreadyExifTimeMake = dedupeSets.alreadyExifTimeMake;
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
        // Don't pre-filter by manifestId - let uploadFile handle all deduplication
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
          const result = await this.uploadFile(file, idx, totalFiles, existingIds, alreadyFilenames, alreadyBaseFilenames, alreadyFileHashes, alreadyPerceptualHashes, alreadyBaseNameSizes, alreadyBaseNameDates, alreadyBaseNameTimestamps, alreadyExifFull, alreadyExifTimeModel, alreadyExifTimeMake);
          if (result && result.skipped) {
            skipped++;
          } else if (result) {
            uploaded++;
            // Update in-memory sets to prevent duplicates within same run
            if (result.manifestId) {
              existingIds.add(result.manifestId);
            }
            if (result.fileHash) {
              alreadyFileHashes.add(result.fileHash);
            }
            if (result.perceptualHash) {
              alreadyPerceptualHashes.add(result.perceptualHash);
            }
            // Also add base filename for iOS variant deduplication within same run
            if (file.name && alreadyBaseFilenames) {
              const baseName = this.extractBaseFilename(file.name);
              if (baseName) alreadyBaseFilenames.add(baseName);
            }
          }
        } else {
          const res = await this.uploadClassicRawFile(file);
          if (res && res.duplicate) {
            skipped++;
          } else if (res) {
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
