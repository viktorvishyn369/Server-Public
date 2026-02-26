/**
 * Desktop Sync Client
 * Downloads files from StealthCloud/Remote server with mobile-grade deduplication
 * Matches the dedup logic from mobile apps (manifestId, filename, fileHash, perceptualHash, EXIF)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const sharp = require('sharp');

const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const MAX_PARALLEL_DOWNLOADS = 4;
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
                          (error.response && error.response.status >= 500);
      
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
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

// UUID v5 implementation
function uuidv5(name, namespace) {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1');
  hash.update(namespaceBytes);
  hash.update(name);
  const bytes = hash.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.slice(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Normalize filename for comparison
function normalizeFilenameForCompare(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

// Extract base filename for cross-platform variant deduplication
// Handles iOS, Android/Google Photos, Windows, and Linux naming patterns
function extractBaseFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const name = filename.trim();
  if (!name) return null;
  
  // Remove extension
  const lastDot = name.lastIndexOf('.');
  const baseName = lastDot > 0 ? name.substring(0, lastDot) : name;
  
  // iOS patterns: IMG_1234_1_105_c, IMG_1234_4_5005_c
  let cleaned = baseName.replace(/_\d+_\d+_c$/i, '');
  // Android/Google: IMG_20231225_123456_1, PXL_20231225_123456~2
  cleaned = cleaned.replace(/[_~]\d+$/i, '');
  // Windows: IMG_1234 (1), IMG_1234 (2)
  cleaned = cleaned.replace(/\s*\(\d+\)$/i, '');
  // General suffix: -1, -2, _copy, _copy2
  cleaned = cleaned.replace(/[-_](copy\d*|\d+)$/i, '');
  
  return cleaned.toLowerCase();
}

// Compute file identity for manifestId generation
function computeFileIdentity(filename, originalSize) {
  const normalized = normalizeFilenameForCompare(filename);
  if (!normalized) return null;
  const sizeStr = typeof originalSize === 'number' && !Number.isNaN(originalSize) ? String(originalSize) : '';
  return `${normalized}:${sizeStr}`;
}

// Convert ISO date format "YYYY-MM-DDTHH:MM:SS" to EXIF format "YYYY:MM:DD HH:MM:SS"
function isoToExifDateTime(isoDate) {
  if (!isoDate || typeof isoDate !== 'string' || isoDate.length < 19) return null;
  // ISO format: "2024-01-15T14:30:45" -> EXIF format: "2024:01:15 14:30:45"
  return isoDate.slice(0, 19).replace(/-/g, ':').replace('T', ' ');
}

/**
 * Write EXIF data to an image file using Sharp
 * Supports JPEG, PNG, WebP, TIFF formats
 * @param {string} filePath - Path to the image file
 * @param {Object} exifData - EXIF data object from server
 * @returns {Promise<boolean>} - true if successful
 */
/**
 * Write EXIF to file using exiftool CLI (fallback for formats Sharp can't handle).
 * Supports HEIC, RAW (CR2/NEF/ARW/DNG/etc), PNG, WebP, AVIF, and more.
 * @param {string} filePath - Path to the image file
 * @param {Object} exifData - EXIF data object from server
 * @returns {boolean} true if successful
 */
// Bundled exiftool via exiftool-vendored — works on all platforms without user install
let _exiftoolInstance = null;

function getExiftool() {
  if (_exiftoolInstance) return _exiftoolInstance;
  try {
    const { ExifTool } = require('exiftool-vendored');
    _exiftoolInstance = new ExifTool({ maxProcs: 1 });
    console.log('[EXIF] exiftool-vendored loaded (bundled)');
    return _exiftoolInstance;
  } catch (e) {
    console.warn('[EXIF] exiftool-vendored not available:', e?.message);
    return null;
  }
}

async function writeExifWithExiftool(filePath, exifData) {
  if (!exifData || !filePath) return false;
  try {
    const et = getExiftool();
    if (!et) return false;
    
    // Build write tags object for exiftool-vendored
    const tags = {};
    
    // Core identification
    if (exifData.captureTime) {
      const exifTime = isoToExifDateTime(exifData.captureTime);
      if (exifTime) {
        tags.DateTimeOriginal = exifTime;
        tags.CreateDate = exifTime;
      }
    }
    if (exifData.make) tags.Make = exifData.make;
    if (exifData.model) tags.Model = exifData.model;
    if (exifData.orientation != null) tags['Orientation#'] = exifData.orientation;
    
    // Camera settings
    if (exifData.exposureTime != null) tags.ExposureTime = exifData.exposureTime;
    if (exifData.fNumber != null) tags.FNumber = exifData.fNumber;
    if (exifData.iso != null) tags.ISO = exifData.iso;
    if (exifData.focalLength != null) tags.FocalLength = exifData.focalLength;
    if (exifData.focalLengthIn35mm != null) tags.FocalLengthIn35mmFormat = exifData.focalLengthIn35mm;
    if (exifData.flash != null) tags['Flash#'] = exifData.flash;
    if (exifData.whiteBalance != null) tags['WhiteBalance#'] = exifData.whiteBalance;
    if (exifData.meteringMode != null) tags['MeteringMode#'] = exifData.meteringMode;
    if (exifData.exposureProgram != null) tags['ExposureProgram#'] = exifData.exposureProgram;
    if (exifData.exposureBias != null) tags.ExposureCompensation = exifData.exposureBias;
    if (exifData.colorSpace != null) tags['ColorSpace#'] = exifData.colorSpace;
    
    // Lens info
    if (exifData.lensMake) tags.LensMake = exifData.lensMake;
    if (exifData.lensModel) tags.LensModel = exifData.lensModel;
    
    // GPS — exiftool-vendored accepts plain decimals; minor precision loss (~7th decimal)
    // is acceptable since exifHash uses 4-decimal truncation for round-trip stability
    if (exifData.gpsLatitude != null && exifData.gpsLongitude != null) {
      const lat = exifData.gpsLatitude;
      const lon = exifData.gpsLongitude;
      tags.GPSLatitude = Math.abs(lat);
      tags.GPSLatitudeRef = lat >= 0 ? 'N' : 'S';
      tags.GPSLongitude = Math.abs(lon);
      tags.GPSLongitudeRef = lon >= 0 ? 'E' : 'W';
    }
    if (exifData.gpsAltitude != null) {
      // Altitude is just meters, no DMS conversion — plain decimal is fine
      tags.GPSAltitude = Math.abs(exifData.gpsAltitude);
      tags.GPSAltitudeRef = exifData.gpsAltitude >= 0 ? 'Above Sea Level' : 'Below Sea Level';
    }
    
    // Timezone/subsecond
    if (exifData.offsetTimeOriginal) tags.OffsetTimeOriginal = exifData.offsetTimeOriginal;
    if (exifData.subSecTimeOriginal) tags.SubSecTimeOriginal = exifData.subSecTimeOriginal;
    
    // Software
    if (exifData.software) tags.Software = exifData.software;
    
    // IPTC fields (professional metadata)
    if (exifData.iptcCaption) tags['IPTC:Caption-Abstract'] = exifData.iptcCaption;
    if (exifData.iptcCopyright) tags['IPTC:CopyrightNotice'] = exifData.iptcCopyright;
    if (exifData.iptcKeywords) {
      // exiftool accepts array for keywords
      tags['IPTC:Keywords'] = Array.isArray(exifData.iptcKeywords) ? exifData.iptcKeywords : [exifData.iptcKeywords];
    }
    if (exifData.iptcCreator) tags['IPTC:By-line'] = exifData.iptcCreator;
    if (exifData.iptcTitle) tags['IPTC:ObjectName'] = exifData.iptcTitle;
    if (exifData.iptcCity) tags['IPTC:City'] = exifData.iptcCity;
    if (exifData.iptcCountry) tags['IPTC:Country-PrimaryLocationName'] = exifData.iptcCountry;
    if (exifData.iptcCredit) tags['IPTC:Credit'] = exifData.iptcCredit;
    if (exifData.iptcSource) tags['IPTC:Source'] = exifData.iptcSource;
    
    // XMP fields (Lightroom/editing metadata)
    if (exifData.xmpRating != null) tags['XMP:Rating'] = exifData.xmpRating;
    if (exifData.xmpLabel) tags['XMP:Label'] = exifData.xmpLabel;
    if (exifData.xmpSubject) tags['XMP:Subject'] = exifData.xmpSubject;
    if (exifData.xmpCreatorTool) tags['XMP:CreatorTool'] = exifData.xmpCreatorTool;
    if (exifData.xmpRights) tags['XMP:Rights'] = exifData.xmpRights;
    if (exifData.xmpDescription) tags['XMP:Description'] = exifData.xmpDescription;
    
    // Only write if we have actual tags
    if (Object.keys(tags).length === 0) {
      console.log(`[EXIF] No EXIF fields to write for ${path.basename(filePath)}`);
      return false;
    }
    
    await et.write(filePath, tags, ['-overwrite_original', '-ignoreMinorErrors']);
    console.log(`[EXIF] Applied EXIF via exiftool-vendored to ${path.basename(filePath)}`);
    return true;
  } catch (e) {
    console.warn(`[EXIF] exiftool write failed for ${path.basename(filePath)}:`, e?.message);
    return false;
  }
}

async function writeExifToFile(filePath, exifData) {
  if (!exifData || !filePath) return false;
  
  // Always prefer exiftool — it writes EXIF in-place without re-encoding pixel data.
  // Sharp re-encodes the entire JPEG with default quality (~80), halving file size.
  // Only fall back to Sharp if exiftool is unavailable.
  const etResult = await writeExifWithExiftool(filePath, exifData);
  if (etResult) return true;
  
  const ext = path.extname(filePath).toLowerCase();
  // Sharp can fully write EXIF to JPEG and TIFF only (but re-encodes!)
  const sharpWriteFormats = ['.jpg', '.jpeg', '.tiff', '.tif'];
  
  if (!sharpWriteFormats.includes(ext)) {
    return false; // exiftool failed and Sharp can't handle this format
  }
  
  // Fallback: Sharp (re-encodes, but better than no EXIF)
  console.log(`[EXIF] exiftool unavailable, falling back to Sharp for ${path.basename(filePath)}`);
  try {
    // Read the image
    const imageBuffer = fs.readFileSync(filePath);
    
    // Build EXIF metadata object for Sharp
    const exifMeta = {};
    
    // Core identification
    if (exifData.captureTime) {
      const exifTime = isoToExifDateTime(exifData.captureTime);
      if (exifTime) {
        exifMeta.DateTimeOriginal = exifTime;
        exifMeta.DateTimeDigitized = exifTime;
      }
    }
    
    if (exifData.make) exifMeta.Make = exifData.make;
    if (exifData.model) exifMeta.Model = exifData.model;
    
    // Camera settings
    if (exifData.exposureTime != null) exifMeta.ExposureTime = exifData.exposureTime;
    if (exifData.fNumber != null) exifMeta.FNumber = exifData.fNumber;
    if (exifData.iso != null) exifMeta.ISO = exifData.iso;
    if (exifData.focalLength != null) exifMeta.FocalLength = exifData.focalLength;
    if (exifData.focalLengthIn35mm != null) exifMeta.FocalLengthIn35mmFilm = exifData.focalLengthIn35mm;
    if (exifData.flash != null) exifMeta.Flash = exifData.flash;
    if (exifData.whiteBalance != null) exifMeta.WhiteBalance = exifData.whiteBalance;
    if (exifData.meteringMode != null) exifMeta.MeteringMode = exifData.meteringMode;
    if (exifData.exposureProgram != null) exifMeta.ExposureProgram = exifData.exposureProgram;
    if (exifData.exposureBias != null) exifMeta.ExposureBiasValue = exifData.exposureBias;
    if (exifData.colorSpace != null) exifMeta.ColorSpace = exifData.colorSpace;
    
    // Lens info
    if (exifData.lensMake) exifMeta.LensMake = String(exifData.lensMake);
    if (exifData.lensModel) exifMeta.LensModel = String(exifData.lensModel);
    
    // GPS
    if (exifData.gpsLatitude != null) exifMeta.GPSLatitude = exifData.gpsLatitude;
    if (exifData.gpsLongitude != null) exifMeta.GPSLongitude = exifData.gpsLongitude;
    if (exifData.gpsAltitude != null) exifMeta.GPSAltitude = exifData.gpsAltitude;
    
    // Timezone offset (EXIF 2.31+)
    if (exifData.offsetTimeOriginal) {
      exifMeta.OffsetTimeOriginal = exifData.offsetTimeOriginal;
      exifMeta.OffsetTimeDigitized = exifData.offsetTimeOriginal;
    }
    
    // SubSecond precision
    if (exifData.subSecTimeOriginal) {
      exifMeta.SubSecTimeOriginal = exifData.subSecTimeOriginal;
      exifMeta.SubSecTimeDigitized = exifData.subSecTimeOriginal;
    }
    
    // Software
    if (exifData.software) exifMeta.Software = String(exifData.software);
    
    // Orientation - must be string for Sharp
    if (exifData.orientation != null) exifMeta.Orientation = String(exifData.orientation);
    
    // Sharp can write EXIF via withMetadata for JPEG
    // For full EXIF control, we use withExif (Sharp 0.33+)
    let sharpInstance = sharp(imageBuffer);
    
    // Build IFD0 object, only including defined values
    const ifd0 = {};
    if (exifMeta.Make) ifd0.Make = exifMeta.Make;
    if (exifMeta.Model) ifd0.Model = exifMeta.Model;
    if (exifMeta.Software) ifd0.Software = exifMeta.Software;
    if (exifMeta.Orientation) ifd0.Orientation = exifMeta.Orientation;
    
    // Build EXIF IFD object, only including defined values
    const ifd2 = {};
    if (exifMeta.DateTimeOriginal) ifd2.DateTimeOriginal = exifMeta.DateTimeOriginal;
    if (exifMeta.DateTimeDigitized) ifd2.DateTimeDigitized = exifMeta.DateTimeDigitized;
    if (exifMeta.ExposureTime != null) ifd2.ExposureTime = String(exifMeta.ExposureTime);
    if (exifMeta.FNumber != null) ifd2.FNumber = String(exifMeta.FNumber);
    if (exifMeta.ISO != null) ifd2.ISO = String(exifMeta.ISO);
    if (exifMeta.FocalLength != null) ifd2.FocalLength = String(exifMeta.FocalLength);
    if (exifMeta.FocalLengthIn35mmFilm != null) ifd2.FocalLengthIn35mmFilm = String(exifMeta.FocalLengthIn35mmFilm);
    if (exifMeta.Flash != null) ifd2.Flash = String(exifMeta.Flash);
    if (exifMeta.WhiteBalance != null) ifd2.WhiteBalance = String(exifMeta.WhiteBalance);
    if (exifMeta.MeteringMode != null) ifd2.MeteringMode = String(exifMeta.MeteringMode);
    if (exifMeta.ExposureProgram != null) ifd2.ExposureProgram = String(exifMeta.ExposureProgram);
    if (exifMeta.ExposureBiasValue != null) ifd2.ExposureBiasValue = String(exifMeta.ExposureBiasValue);
    if (exifMeta.ColorSpace != null) ifd2.ColorSpace = String(exifMeta.ColorSpace);
    if (exifMeta.LensMake) ifd2.LensMake = exifMeta.LensMake;
    if (exifMeta.LensModel) ifd2.LensModel = exifMeta.LensModel;
    if (exifMeta.OffsetTimeOriginal) ifd2.OffsetTimeOriginal = exifMeta.OffsetTimeOriginal;
    if (exifMeta.OffsetTimeDigitized) ifd2.OffsetTimeDigitized = exifMeta.OffsetTimeDigitized;
    if (exifMeta.SubSecTimeOriginal) ifd2.SubSecTimeOriginal = String(exifMeta.SubSecTimeOriginal);
    if (exifMeta.SubSecTimeDigitized) ifd2.SubSecTimeDigitized = String(exifMeta.SubSecTimeDigitized);
    
    // Build GPS IFD object
    const gpsIfd = {};
    if (exifMeta.GPSLatitude != null) {
      const lat = exifMeta.GPSLatitude;
      gpsIfd.GPSLatitudeRef = lat >= 0 ? 'N' : 'S';
      gpsIfd.GPSLatitude = String(Math.abs(lat));
    }
    if (exifMeta.GPSLongitude != null) {
      const lon = exifMeta.GPSLongitude;
      gpsIfd.GPSLongitudeRef = lon >= 0 ? 'E' : 'W';
      gpsIfd.GPSLongitude = String(Math.abs(lon));
    }
    if (exifMeta.GPSAltitude != null) {
      const alt = exifMeta.GPSAltitude;
      gpsIfd.GPSAltitudeRef = alt >= 0 ? '0' : '1';
      gpsIfd.GPSAltitude = String(Math.abs(alt));
    }
    
    // Try to preserve and add EXIF
    // JPEG and TIFF support full EXIF writing via Sharp
    // PNG/WebP only preserve existing metadata
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.tiff' || ext === '.tif') {
      const exifObj = {};
      if (Object.keys(ifd0).length > 0) exifObj.IFD0 = ifd0;
      if (Object.keys(ifd2).length > 0) exifObj.IFD2 = ifd2;
      if (Object.keys(gpsIfd).length > 0) exifObj.IFD3 = gpsIfd;
      
      if (Object.keys(exifObj).length > 0) {
        sharpInstance = sharpInstance.withMetadata({ exif: exifObj });
      } else {
        sharpInstance = sharpInstance.withMetadata();
      }
    } else {
      // For PNG/WebP, just preserve existing metadata
      sharpInstance = sharpInstance.withMetadata();
    }
    
    // Write back to file
    const outputBuffer = await sharpInstance.toBuffer();
    fs.writeFileSync(filePath, outputBuffer);
    
    console.log(`[EXIF] Applied EXIF to ${path.basename(filePath)}`);
    return true;
  } catch (e) {
    console.warn(`[EXIF] Write failed for ${path.basename(filePath)}:`, e.message);
    return false;
  }
}

/**
 * Retrieve EXIF data from server by file hash
 * @param {string} baseUrl - Server base URL
 * @param {string} token - Auth token
 * @param {string} deviceUuid - Device UUID
 * @param {string} fileHash - File hash to lookup
 * @returns {Promise<Object|null>} - EXIF data or null
 */
async function fetchExifFromServer(baseUrl, token, deviceUuid, fileHash) {
  if (!fileHash) return null;
  
  try {
    const response = await axios.get(`${baseUrl}/api/exif/${fileHash}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Device-UUID': deviceUuid
      },
      timeout: 10000,
      validateStatus: (status) => status < 500
    });
    
    if (response.status === 200 && response.data?.exif) {
      return response.data.exif;
    }
  } catch (e) {
    // Non-critical - don't fail sync if EXIF retrieval fails
  }
  return null;
}

// Compute exact file hash (SHA-256)
async function computeExactFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => reject(err));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Hamming distance for 16-char hex hash (64 bits)
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

// Cross-platform dHash threshold (1 bit = strict match, same as mobile and server)
// Must match mobile sync and server for consistency
const CROSS_PLATFORM_DHASH_THRESHOLD = 1;

// Find a matching perceptual hash using Hamming distance
function findPerceptualHashMatch(hash, hashSet, threshold = CROSS_PLATFORM_DHASH_THRESHOLD) {
  if (!hash || hash.length !== 16 || !hashSet || hashSet.size === 0) return { match: false, distance: -1 };
  if (hashSet.has(hash)) return { match: true, distance: 0 };
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const existingHash of hashSet) {
    if (existingHash && existingHash.length === 16) {
      const dist = hammingDistance64(hash, existingHash);
      if (dist < bestDistance) bestDistance = dist;
      if (dist <= threshold) return { match: true, distance: dist };
    }
  }
  return { match: false, distance: bestDistance };
}

// Normalize date for comparison (YYYY-MM-DD)
function normalizeDateForCompare(dateVal) {
  if (!dateVal) return null;
  try {
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch (e) {
    return null;
  }
}

// Normalize full timestamp for HEIC deduplication (YYYY-MM-DDTHH:MM:SS)
function normalizeFullTimestamp(dateVal) {
  if (!dateVal) return null;
  try {
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('.')[0];
  } catch (e) {
    return null;
  }
}

class DesktopSyncClient {
  constructor(config, progressCallback) {
    this.config = config;
    this.progressCallback = progressCallback || (() => {});
    this.token = null;
    this.masterKey = null;
    this.deviceUuid = null;
    this.cancelled = false;
  }

  getBaseUrl() {
    if (this.config.source === 'stealthcloud') {
      return STEALTHCLOUD_BASE_URL;
    } else if (this.config.source === 'local') {
      // Local server running on this machine
      return 'http://127.0.0.1:3000';
    } else if (this.config.source === 'remote') {
      const host = this.config.remoteAddress || '';
      const port = this.config.remotePort || '3000';
      const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || 
                          host === 'localhost' || 
                          host.startsWith('192.168.') ||
                          host.startsWith('10.') ||
                          host.startsWith('172.');
      if (isIpAddress) {
        return `http://${host}:${port}`;
      } else {
        return `https://${host}`;
      }
    } else {
      throw new Error('Invalid source (expected local, remote, or stealthcloud)');
    }
  }

  getDeviceId() {
    // Prefer device_uuid from pairing payload (critical for wallet-migrated users
    // where email:password no longer derives the correct legacy UUID)
    if (this.config.device_uuid) return this.config.device_uuid;
    const normalizedEmail = (this.config.email || '').trim().toLowerCase();
    const password = this.config.password || '';
    return uuidv5(`${normalizedEmail}:${password}`, UUID_NAMESPACE);
  }

  deriveMasterKey(password, email) {
    const salt = email.toLowerCase().trim();
    const key = crypto.pbkdf2Sync(password, salt, 30000, 32, 'sha256');
    return new Uint8Array(key);
  }

  makeChunkNonce(baseNonce16, chunkIndex) {
    const nonce = new Uint8Array(24);
    nonce.set(baseNonce16, 0);
    let x = BigInt(chunkIndex);
    for (let i = 0; i < 8; i++) {
      nonce[16 + i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return nonce;
  }

  async login() {
    const baseUrl = this.getBaseUrl();
    console.log(`[SYNC] Login to ${baseUrl} as ${this.config.email}, source=${this.config.source}`);
    this.progressCallback({ message: 'Logging in...', progress: 0.02 });

    return withRetry(async () => {
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
        this.deviceUuid = this.getDeviceId();
        console.log(`[SYNC] Login successful, token received`);
        return true;
      }
      throw new Error('No token received');
    });
  }

  getDeviceName() {
    const os = require('os');
    const hostname = os.hostname() || 'Desktop';
    const platform = os.platform();
    const platformName = platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Linux';
    return `${hostname} (${platformName} Desktop)`;
  }

  // Build local dedup set from existing files in download folder
  buildLocalDedupSet(downloadPath) {
    const localFilenames = new Set();
    
    try {
      if (fs.existsSync(downloadPath)) {
        const files = fs.readdirSync(downloadPath);
        for (const file of files) {
          if (!file.startsWith('.')) {
            const normalized = normalizeFilenameForCompare(file);
            if (normalized) localFilenames.add(normalized);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to scan local files:', e.message);
    }
    
    return localFilenames;
  }

  // Fetch all manifests with metadata for dedup (StealthCloud)
  async fetchManifestsWithMeta() {
    const baseUrl = this.getBaseUrl();
    const allManifests = [];
    const pageLimit = 500;
    let offset = 0;

    while (true) {
      const response = await withRetry(async () => {
        return axios.get(`${baseUrl}/api/cloud/manifests`, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'X-Device-UUID': this.deviceUuid
          },
          params: { offset, limit: pageLimit, meta: true },
          timeout: 60000
        });
      });

      const manifests = (response.data && response.data.manifests) || [];
      allManifests.push(...manifests);

      this.progressCallback({ 
        message: `Found ${allManifests.length} files on server...`, 
        progress: 0.05 + (allManifests.length / Math.max(response.data?.total || allManifests.length, 1)) * 0.05 
      });

      if (!manifests || manifests.length < pageLimit) break;
      offset += manifests.length;
      const total = typeof response.data?.total === 'number' ? response.data.total : null;
      if (typeof total === 'number' && offset >= total) break;
    }

    return allManifests;
  }

  // Fetch all files with metadata for dedup (Local/Remote server)
  async fetchClassicFilesWithMeta() {
    const baseUrl = this.getBaseUrl();
    const allFiles = [];
    const pageLimit = 500;
    let offset = 0;

    while (true) {
      const response = await withRetry(async () => {
        return axios.get(`${baseUrl}/api/files`, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'X-Device-UUID': this.deviceUuid
          },
          params: { offset, limit: pageLimit, meta: 'true' },
          timeout: 60000
        });
      });

      const files = (response.data && response.data.files) || [];
      allFiles.push(...files);

      this.progressCallback({ 
        message: `Found ${allFiles.length} files on server...`, 
        progress: 0.05 + (allFiles.length / Math.max(response.data?.total || allFiles.length, 1)) * 0.05 
      });

      if (!files || files.length < pageLimit) break;
      offset += files.length;
      const total = typeof response.data?.total === 'number' ? response.data.total : null;
      if (typeof total === 'number' && offset >= total) break;
    }

    console.log(`[SYNC] Server files: ${allFiles.length} total`);
    return allFiles;
  }

  // Download and decrypt a single file
  async downloadFile(manifest, downloadPath) {
    const baseUrl = this.getBaseUrl();
    
    // Fetch full manifest to get encryption keys
    const manifestResponse = await withRetry(async () => {
      return axios.get(`${baseUrl}/api/cloud/manifests/${manifest.manifestId}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Device-UUID': this.deviceUuid
        },
        timeout: 30000
      });
    });

    const payload = manifestResponse.data;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const enc = JSON.parse(parsed.encryptedManifest);
    const manifestNonce = naclUtil.decodeBase64(enc.manifestNonce);
    const manifestBox = naclUtil.decodeBase64(enc.manifestBox);
    const manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, this.masterKey);

    if (!manifestPlain) {
      throw new Error('Failed to decrypt manifest');
    }

    const decryptedManifest = JSON.parse(naclUtil.encodeUTF8(manifestPlain));
    const filename = decryptedManifest.filename || `file_${manifest.manifestId.slice(0, 8)}`;
    const filePath = path.join(downloadPath, filename);

    // Skip if file already exists
    if (fs.existsSync(filePath)) {
      return { skipped: true, reason: 'exists' };
    }

    // Unwrap file key
    const wrapNonce = naclUtil.decodeBase64(decryptedManifest.wrapNonce);
    const wrappedKey = naclUtil.decodeBase64(decryptedManifest.wrappedFileKey);
    const fileKey = nacl.secretbox.open(wrappedKey, wrapNonce, this.masterKey);

    if (!fileKey) {
      throw new Error('Failed to unwrap file key');
    }

    const baseNonce16 = naclUtil.decodeBase64(decryptedManifest.baseNonce16);
    const chunkIds = decryptedManifest.chunkIds || [];

    // Stream chunks directly to disk to avoid memory issues with large files
    const writeStream = fs.createWriteStream(filePath);
    
    try {
      for (let i = 0; i < chunkIds.length; i++) {
        const chunkId = chunkIds[i];
        
        const chunkResponse = await withRetry(async () => {
          return axios.get(`${baseUrl}/api/cloud/chunks/${chunkId}`, {
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'X-Device-UUID': this.deviceUuid
            },
            responseType: 'arraybuffer',
            timeout: 120000
          });
        });

        const encryptedChunk = new Uint8Array(chunkResponse.data);
        const nonce = this.makeChunkNonce(baseNonce16, i);
        const decryptedChunk = nacl.secretbox.open(encryptedChunk, nonce, fileKey);

        if (!decryptedChunk) {
          writeStream.destroy();
          fs.unlinkSync(filePath);
          throw new Error(`Failed to decrypt chunk ${i}`);
        }

        // Write chunk directly to disk
        await new Promise((resolve, reject) => {
          writeStream.write(Buffer.from(decryptedChunk), (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      
      // Close stream
      await new Promise((resolve, reject) => {
        writeStream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      // Apply EXIF data from server if available (for images)
      // ONLY if the file doesn't already have EXIF embedded — Sharp re-encodes the
      // entire JPEG when writing EXIF, destroying the original file bytes & SHA256.
      const ext = path.extname(filename).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.heic', '.heif', '.gif', '.bmp', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.raf', '.psd', '.psb', '.exr', '.hdr', '.avif'].includes(ext);
      if (isImage && decryptedManifest.fileHash) {
        try {
          // Check if file already has EXIF before overwriting
          // Use ExifReader instead of Sharp — Sharp returns exif:null for DNG/RAW/HEIC
          let hasExif = false;
          try {
            const ExifReader = require('exifreader');
            const checkBuf = fs.readFileSync(filePath);
            const checkTags = ExifReader.load(checkBuf);
            if (checkTags?.DateTimeOriginal || checkTags?.Make) hasExif = true;
          } catch (_) {}
          if (!hasExif) {
            const exifData = await fetchExifFromServer(baseUrl, this.token, this.deviceUuid, decryptedManifest.fileHash);
            if (exifData) {
              await writeExifToFile(filePath, exifData);
            }
          } else {
            console.log(`[EXIF] File already has EXIF, skipping re-write: ${filename}`);
          }
        } catch (exifErr) {
          // Non-critical - don't fail download if EXIF write fails
          console.log(`[EXIF] Could not apply EXIF to ${filename}:`, exifErr.message);
        }
      }
      
      // Register file with local server so mobile sync can get fileHash for EXIF lookup
      try {
        await axios.post(`http://127.0.0.1:3000/api/files/register`, {
          filename,
          fileHash: decryptedManifest.fileHash,
          perceptualHash: decryptedManifest.perceptualHash,
          size: decryptedManifest.originalSize,
          mimeType: decryptedManifest.mimeType || 'image/jpeg'
        }, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'X-Device-UUID': this.deviceUuid
          },
          timeout: 5000
        });
        console.log(`[SYNC] Registered file with local server: ${filename}`);
        
        // Also store EXIF to local server if we fetched it from StealthCloud
        if (isImage && decryptedManifest.fileHash) {
          const exifData = await fetchExifFromServer(baseUrl, this.token, this.deviceUuid, decryptedManifest.fileHash);
          if (exifData) {
            await axios.post(`http://127.0.0.1:3000/api/exif/store`, {
              fileHash: decryptedManifest.fileHash,
              exif: exifData,
              platform: 'desktop'
            }, {
              headers: {
                'Authorization': `Bearer ${this.token}`,
                'X-Device-UUID': this.deviceUuid
              },
              timeout: 5000
            });
            console.log(`[SYNC] Stored EXIF to local server: ${filename}`);
          }
        }
      } catch (regErr) {
        console.log(`[SYNC] Could not register file (non-critical): ${regErr.message}`);
      }
    } catch (e) {
      writeStream.destroy();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw e;
    }

    return { downloaded: true, filename };
  }

  // Download a single file from Local/Remote server (unencrypted)
  async downloadClassicFile(file, downloadPath) {
    const baseUrl = this.getBaseUrl();
    const filename = file.filename;
    if (!filename) {
      console.warn('[SYNC] Skipping file with no filename');
      return { downloaded: false, skipped: true };
    }

    const destPath = path.join(downloadPath, filename);
    
    // Skip if already exists
    if (fs.existsSync(destPath)) {
      return { downloaded: false, skipped: true };
    }

    try {
      const response = await withRetry(async () => {
        return axios.get(`${baseUrl}/api/files/${encodeURIComponent(filename)}`, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'X-Device-UUID': this.deviceUuid
          },
          responseType: 'arraybuffer',
          timeout: 120000
        });
      });

      // Ensure download directory exists
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
      }

      fs.writeFileSync(destPath, Buffer.from(response.data));
      console.log(`[SYNC] Downloaded: ${filename}`);
      
      // Apply EXIF data from server if available (for images)
      // ONLY if the file doesn't already have EXIF embedded — Sharp re-encodes the
      // entire JPEG when writing EXIF, destroying the original file bytes & SHA256.
      const ext = path.extname(filename).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.heic', '.heif', '.gif', '.bmp', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.raf', '.psd', '.psb', '.exr', '.hdr', '.avif'].includes(ext);
      if (isImage && file.fileHash) {
        try {
          // Check if file already has EXIF before overwriting
          // Use ExifReader instead of Sharp — Sharp returns exif:null for DNG/RAW/HEIC
          let hasExif = false;
          try {
            const ExifReader = require('exifreader');
            const checkBuf = fs.readFileSync(destPath);
            const checkTags = ExifReader.load(checkBuf);
            if (checkTags?.DateTimeOriginal || checkTags?.Make) hasExif = true;
          } catch (_) {}
          if (!hasExif) {
            const exifData = await fetchExifFromServer(baseUrl, this.token, this.deviceUuid, file.fileHash);
            if (exifData) {
              await writeExifToFile(destPath, exifData);
            }
          } else {
            console.log(`[EXIF] File already has EXIF, skipping re-write: ${filename}`);
          }
        } catch (exifErr) {
          // Non-critical - don't fail download if EXIF write fails
          console.log(`[EXIF] Could not apply EXIF to ${filename}:`, exifErr.message);
        }
      }
      
      return { downloaded: true, filename };
    } catch (e) {
      console.error(`[SYNC] Failed to download ${filename}:`, e.message);
      throw e;
    }
  }

  // Decrypt a manifest to get full data for dedup
  async decryptManifestFull(manifestId) {
    const baseUrl = this.getBaseUrl();
    try {
      const response = await withRetry(async () => {
        return axios.get(`${baseUrl}/api/cloud/manifests/${manifestId}`, {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'X-Device-UUID': this.deviceUuid
          },
          timeout: 30000
        });
      }, 2, 500);

      const payload = response.data;
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const enc = JSON.parse(parsed.encryptedManifest);
      const manifestNonce = naclUtil.decodeBase64(enc.manifestNonce);
      const manifestBox = naclUtil.decodeBase64(enc.manifestBox);
      const manifestPlain = nacl.secretbox.open(manifestBox, manifestNonce, this.masterKey);

      if (manifestPlain) {
        return JSON.parse(naclUtil.encodeUTF8(manifestPlain));
      }
    } catch (e) {
      // Skip manifests we can't decrypt
    }
    return null;
  }

  // Build comprehensive local dedup sets from download folder
  async buildLocalDedupSets(downloadPath) {
    const localFilenames = new Set();
    const localBaseFilenames = new Set();
    const localFileHashes = new Set();
    const localBaseNameSizes = new Map();
    
    try {
      if (!fs.existsSync(downloadPath)) {
        return { localFilenames, localBaseFilenames, localFileHashes, localBaseNameSizes };
      }
      
      const files = fs.readdirSync(downloadPath);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        
        const filePath = path.join(downloadPath, file);
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        
        // Filename match
        const normalized = normalizeFilenameForCompare(file);
        if (normalized) localFilenames.add(normalized);
        
        // Base filename match
        const baseName = extractBaseFilename(file);
        if (baseName) {
          localBaseFilenames.add(baseName);
          // Base filename + size
          if (!localBaseNameSizes.has(baseName)) {
            localBaseNameSizes.set(baseName, new Set());
          }
          localBaseNameSizes.get(baseName).add(stats.size);
        }
        
        // File hash (for exact byte match)
        try {
          const hash = await computeExactFileHash(filePath);
          if (hash) localFileHashes.add(hash);
        } catch (e) {
          // Skip hash errors
        }
      }
    } catch (e) {
      console.warn('Failed to scan local files:', e.message);
    }
    
    return { localFilenames, localBaseFilenames, localFileHashes, localBaseNameSizes };
  }

  // Check if a manifest should be skipped (OR logic - any match = skip)
  checkShouldSkip(manifest, localSets) {
    const { localFilenames, localBaseFilenames, localFileHashes, localBaseNameSizes } = localSets;
    const filename = manifest.filename;
    const fileSize = manifest.originalSize || manifest.size;
    const fileHash = manifest.fileHash;
    const perceptualHash = manifest.perceptualHash;
    
    // 1. Exact filename match
    if (filename) {
      const normalized = normalizeFilenameForCompare(filename);
      if (normalized && localFilenames.has(normalized)) {
        return { skip: true, reason: 'filename' };
      }
    }
    
    // 2. Base filename match (cross-platform variants)
    if (filename) {
      const baseName = extractBaseFilename(filename);
      if (baseName && localBaseFilenames.has(baseName)) {
        return { skip: true, reason: 'baseFilename' };
      }
      
      // 3. Base filename + size match (within 20% tolerance)
      if (baseName && fileSize && localBaseNameSizes.has(baseName)) {
        for (const existingSize of localBaseNameSizes.get(baseName)) {
          const diff = Math.abs(fileSize - existingSize) / Math.max(fileSize, existingSize);
          if (diff < 0.20) {
            return { skip: true, reason: 'baseFilename+size' };
          }
        }
      }
    }
    
    // 4. Exact file hash match (byte-identical)
    if (fileHash && localFileHashes.has(fileHash)) {
      return { skip: true, reason: 'fileHash' };
    }
    
    return { skip: false, reason: null };
  }

  async sync() {
    // Login
    await this.login();

    const isStealthCloud = this.config.source === 'stealthcloud';

    // Derive master key for StealthCloud
    // Use legacy MK creds from pairing if available (wallet-migrated users)
    if (isStealthCloud) {
      const mkPassword = this.config.mk_password || this.config.password;
      const mkEmail = this.config.mk_email || this.config.email;
      this.masterKey = this.deriveMasterKey(mkPassword, mkEmail);
    }

    this.progressCallback({ message: 'Fetching server files...', progress: 0.05 });

    // Route to appropriate sync method
    if (isStealthCloud) {
      return this.syncStealthCloud();
    } else {
      return this.syncClassic();
    }
  }

  // Sync from Local/Remote server (unencrypted files)
  async syncClassic() {
    // Fetch all files with hash metadata
    const serverFiles = await this.fetchClassicFilesWithMeta();
    console.log(`[SYNC] Server has ${serverFiles.length} files`);

    if (serverFiles.length === 0) {
      return { downloaded: 0, skipped: 0 };
    }

    // Build comprehensive local dedup sets
    this.progressCallback({ message: 'Scanning local files...', progress: 0.08 });
    const localSets = await this.buildLocalDedupSets(this.config.downloadPath);
    console.log(`[SYNC] Local dedup sets: filenames=${localSets.localFilenames.size}, baseNames=${localSets.localBaseFilenames.size}, hashes=${localSets.localFileHashes.size}`);

    // Filter files to download using OR logic (any match = skip)
    this.progressCallback({ message: 'Checking for duplicates...', progress: 0.12 });
    const toDownload = [];
    let skipped = 0;
    const skipReasons = {};

    for (const file of serverFiles) {
      if (this.cancelled) break;
      
      const result = this.checkShouldSkip(file, localSets);
      if (result.skip) {
        skipped++;
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
        continue;
      }
      toDownload.push(file);
    }
    
    console.log(`[SYNC] To download: ${toDownload.length}, Skipped: ${skipped}`, skipReasons);

    this.progressCallback({ 
      message: `Downloading ${toDownload.length} files (${skipped} already exist)...`, 
      progress: 0.15 
    });

    if (toDownload.length === 0) {
      return { downloaded: 0, skipped };
    }

    // Download files with concurrency limit
    let downloaded = 0;
    let failed = 0;
    const runDownload = createConcurrencyLimiter(MAX_PARALLEL_DOWNLOADS);
    const total = toDownload.length;

    const tasks = toDownload.map((file, idx) => runDownload(async () => {
      if (this.cancelled) return;
      
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.downloadClassicFile(file, this.config.downloadPath);
          if (result.downloaded) {
            downloaded++;
          } else if (result.skipped) {
            skipped++;
          }
          break; // Success
        } catch (e) {
          lastError = e;
          if (attempt < 2) {
            console.log(`Retry ${attempt + 1}/2 for ${file.filename}: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          } else {
            console.error(`Failed to download ${file.filename} after 3 attempts:`, lastError.message);
            failed++;
          }
        }
      }

      const progress = 0.15 + ((downloaded + skipped + failed) / total) * 0.85;
      this.progressCallback({
        message: `Downloaded ${downloaded}/${total} files...`,
        progress: Math.min(progress, 0.99)
      });
    }));

    await Promise.all(tasks);

    return { downloaded, skipped: skipped + failed };
  }

  // Sync from StealthCloud (encrypted files)
  async syncStealthCloud() {
    // Fetch all manifests
    const manifests = await this.fetchManifestsWithMeta();
    console.log(`[SYNC] Server has ${manifests.length} manifests`);

    if (manifests.length === 0) {
      return { downloaded: 0, skipped: 0 };
    }

    // Build comprehensive local dedup sets
    this.progressCallback({ message: 'Scanning local files...', progress: 0.08 });
    const localSets = await this.buildLocalDedupSets(this.config.downloadPath);
    console.log(`[SYNC] Local dedup sets: filenames=${localSets.localFilenames.size}, baseNames=${localSets.localBaseFilenames.size}, hashes=${localSets.localFileHashes.size}`);

    // Decrypt manifests to get full data for dedup
    this.progressCallback({ message: 'Checking for duplicates...', progress: 0.12 });
    const runDecrypt = createConcurrencyLimiter(8);
    let decrypted = 0;
    const manifestTotal = manifests.length;

    const decryptTasks = manifests.map((m) => runDecrypt(async () => {
      const fullManifest = await this.decryptManifestFull(m.manifestId);
      decrypted++;
      if (decrypted % 50 === 0 || decrypted === manifestTotal) {
        this.progressCallback({ message: `Checking duplicates... ${decrypted}/${manifestTotal}`, progress: 0.12 + (decrypted / manifestTotal) * 0.08 });
      }
      return fullManifest ? { ...m, ...fullManifest } : { ...m, filename: null };
    }));

    const manifestsWithData = await Promise.all(decryptTasks);

    // Filter files to download using OR logic (any match = skip)
    const toDownload = [];
    let skipped = 0;
    const skipReasons = {};

    for (const m of manifestsWithData) {
      if (this.cancelled) break;
      
      const result = this.checkShouldSkip(m, localSets);
      if (result.skip) {
        console.log(`[SYNC] Skipping ${m.filename || m.manifestId} - ${result.reason}`);
        skipped++;
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
        continue;
      }
      toDownload.push(m);
    }
    
    console.log(`[SYNC] To download: ${toDownload.length}, Skipped: ${skipped}`, skipReasons);

    this.progressCallback({ 
      message: `Downloading ${toDownload.length} files (${skipped} already exist)...`, 
      progress: 0.15 
    });

    if (toDownload.length === 0) {
      return { downloaded: 0, skipped };
    }

    // Download files with concurrency limit
    let downloaded = 0;
    let failed = 0;
    const runDownload = createConcurrencyLimiter(MAX_PARALLEL_DOWNLOADS);
    const total = toDownload.length;

    const tasks = toDownload.map((m, idx) => runDownload(async () => {
      if (this.cancelled) return;
      
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await this.downloadFile(m, this.config.downloadPath);
          if (result.downloaded) {
            downloaded++;
          } else if (result.skipped) {
            skipped++;
          }
          break; // Success
        } catch (e) {
          lastError = e;
          if (attempt < 2) {
            console.log(`Retry ${attempt + 1}/2 for ${m.filename || m.manifestId}: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          } else {
            console.error(`Failed to download ${m.filename || m.manifestId} after 3 attempts:`, lastError.message);
            failed++;
          }
        }
      }

      const progress = 0.15 + ((downloaded + skipped + failed) / total) * 0.85;
      this.progressCallback({
        message: `Downloaded ${downloaded}/${total} files...`,
        progress: Math.min(progress, 0.99)
      });
    }));

    await Promise.all(tasks);

    return { downloaded, skipped: skipped + failed };
  }

  cancel() {
    this.cancelled = true;
  }
}

module.exports = { DesktopSyncClient };
