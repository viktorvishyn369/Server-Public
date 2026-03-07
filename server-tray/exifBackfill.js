/**
 * Desktop EXIF Backfill Module (temporary — remove once all users have upgraded)
 *
 * Background task that uploads missing EXIF sidecar metadata for files
 * already backed up to StealthCloud by older desktop app versions.
 *
 * Flow:
 * 1. Fetch all StealthCloud manifest metadata (filename, fileHash, size)
 * 2. Batch-check which fileHashes are missing EXIF on server
 * 3. For each missing: find local file in backup folders, extract EXIF, upload
 * 4. Persist cursor in electron-store so it resumes from where it left off
 *
 * Design:
 * - Non-disruptive: yields to event loop between files
 * - Resumable: cursor stored per serverUrl so survives app restart
 * - Idempotent: server's /api/exif/store is first-write-wins
 * - Self-disabling: marks itself complete when all manifests processed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
let sharp;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const TAG = '[ExifBackfill]';
const BATCH_SIZE = 50;
const IMAGE_EXTS = /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif)$/i;

let _running = false;
let _cancelled = false;
let _busy = false; // true when backup/sync is active — backfill pauses
let _currentStore = null;
let _currentProcessedSet = null;
const CURSOR_KEY = 'exif_backfill_cursor';
const INTER_FILE_DELAY_MS = 500; // 0.5s between files to avoid hammering

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldToLoop = () => new Promise(r => setImmediate(r));

function signalBusy() { _busy = true; }
function signalIdle() { _busy = false; }

/**
 * Build a filename→filePath lookup from backup folders (recursive scan)
 */
function buildLocalFileLookup(folders) {
  const lookup = new Map(); // filename_lower → [filePath, ...]
  let scanned = 0;

  const scanDir = (dirPath, depth) => {
    if (depth > 10) return; // limit recursion
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, depth + 1);
      } else if (entry.isFile() && IMAGE_EXTS.test(entry.name)) {
        const key = entry.name.toLowerCase();
        if (!lookup.has(key)) lookup.set(key, []);
        lookup.get(key).push(fullPath);
        scanned++;
      }
    }
  };

  for (const folder of folders) {
    if (fs.existsSync(folder)) scanDir(folder, 0);
  }

  console.log(TAG, `Local lookup: ${lookup.size} unique filenames, ${scanned} files from ${folders.length} folders`);
  return lookup;
}

/**
 * Find best local match for a manifest entry.
 * Matches by filename (case-insensitive), preferring size match if available.
 */
function findLocalFile(lookup, filename, originalSize) {
  const key = (filename || '').toLowerCase();
  const candidates = lookup.get(key);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Prefer exact size match
  if (originalSize && Number(originalSize) > 0) {
    const targetSize = Number(originalSize);
    for (const fp of candidates) {
      try {
        const stat = fs.statSync(fp);
        if (stat.size === targetSize) return fp;
      } catch (_) {}
    }
  }

  return candidates[0]; // fallback to first match
}

/**
 * Extract full EXIF from a file using sharp + exif-reader (same logic as DesktopBackupClient.extractFullExif)
 * Lightweight version — extracts the fields needed for the sidecar JSON.
 */
async function extractExif(filePath) {
  if (!sharp) return null;

  const ext = path.extname(filePath).toLowerCase();
  let exifTags = {};

  // HEIC/RAW formats need ExifReader (sharp can't read their EXIF)
  const exifReaderFormats = ['.heic', '.heif', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.raf', '.raw'];
  if (exifReaderFormats.includes(ext)) {
    try {
      const ExifReader = require('exifreader');
      const tags = await ExifReader.load(filePath);
      if (!tags) return null;

      const r4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? (Number.isInteger(n) ? n : Math.round(n * 1e4) / 1e4) : null; };
      const t4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? Math.trunc(n * 1e4) / 1e4 : null; };
      const safeStr = (s) => s ? String(s).replace(/\0/g, '').trim() || null : null;
      const getDesc = (key) => tags[key]?.description || null;
      const getVal = (key) => tags[key]?.value ?? null;
      const getNum = (key) => {
        const v = getVal(key);
        if (v == null) return null;
        if (typeof v === 'number') return v;
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && v[1] !== 0) return v[0] / v[1];
        const d = getDesc(key);
        if (d != null) { const n = parseFloat(String(d)); if (!isNaN(n)) return n; }
        return null;
      };

      const result = {
        captureTime: null, make: null, model: null,
        offsetTimeOriginal: null, subSecTimeOriginal: null,
        exposureTime: null, fNumber: null, iso: null,
        focalLength: null, focalLengthIn35mm: null,
        flash: null, whiteBalance: null, meteringMode: null,
        exposureProgram: null, exposureBias: null,
        width: null, height: null, orientation: null, colorSpace: null,
        gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
        software: null, lensMake: null, lensModel: null,
      };

      const dto = getDesc('DateTimeOriginal') || getDesc('DateTimeDigitized') || getDesc('DateTime');
      if (dto) {
        const normalized = dto.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)) result.captureTime = normalized.slice(0, 19);
      }
      result.make = safeStr(getDesc('Make'));
      result.model = safeStr(getDesc('Model'));
      if (getDesc('OffsetTimeOriginal')) result.offsetTimeOriginal = String(getDesc('OffsetTimeOriginal')).trim();
      if (getVal('SubSecTimeOriginal') != null) result.subSecTimeOriginal = String(getVal('SubSecTimeOriginal'));
      const et = getNum('ExposureTime'); if (et != null) result.exposureTime = r4(et);
      const fn = getNum('FNumber'); if (fn != null) result.fNumber = r4(fn);
      const isoVal = getNum('ISOSpeedRatings') ?? getNum('PhotographicSensitivity'); if (isoVal != null) result.iso = Math.round(isoVal);
      const fl = getNum('FocalLength'); if (fl != null) result.focalLength = r4(fl);
      const fl35 = getNum('FocalLengthIn35mmFilm') ?? getNum('FocalLengthIn35mmFormat'); if (fl35 != null) result.focalLengthIn35mm = r4(fl35);
      if (getVal('Flash') != null) result.flash = typeof getVal('Flash') === 'number' ? getVal('Flash') : null;
      if (getVal('WhiteBalance') != null) result.whiteBalance = Number(getVal('WhiteBalance'));
      if (getVal('MeteringMode') != null) result.meteringMode = Number(getVal('MeteringMode'));
      if (getVal('ExposureProgram') != null) result.exposureProgram = Number(getVal('ExposureProgram'));
      const eb = getNum('ExposureBiasValue'); if (eb != null) result.exposureBias = r4(eb);
      const pw = getNum('PixelXDimension') ?? getNum('ImageWidth'); if (pw != null) result.width = Math.round(pw);
      const ph = getNum('PixelYDimension') ?? getNum('ImageLength'); if (ph != null) result.height = Math.round(ph);
      if (getVal('Orientation') != null) result.orientation = Number(getVal('Orientation'));
      if (getVal('ColorSpace') != null) result.colorSpace = Number(getVal('ColorSpace'));
      result.software = safeStr(getDesc('Software'));
      result.lensMake = safeStr(getDesc('LensMake'));
      result.lensModel = safeStr(getDesc('LensModel'));

      // GPS
      const latDesc = getDesc('GPSLatitude');
      if (latDesc != null) { const lat = parseFloat(latDesc); if (!isNaN(lat)) result.gpsLatitude = t4(lat); }
      const lonDesc = getDesc('GPSLongitude');
      if (lonDesc != null) { const lon = parseFloat(lonDesc); if (!isNaN(lon)) result.gpsLongitude = t4(lon); }
      const altVal = getNum('GPSAltitude'); if (altVal != null) result.gpsAltitude = t4(altVal);

      return result;
    } catch (e) {
      return null;
    }
  }

  // Standard formats: use sharp + exif-reader
  try {
    const meta = await sharp(filePath).metadata();
    if (!meta) return null;

    const r4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? (Number.isInteger(n) ? n : Math.round(n * 1e4) / 1e4) : null; };
    const t4 = (v) => { const n = Number(v); return (n != null && !isNaN(n)) ? Math.trunc(n * 1e4) / 1e4 : null; };

    let tags = {};
    if (meta.exif) {
      try {
        const exifReader = require('exif-reader');
        const parsed = exifReader(meta.exif) || {};
        if (parsed.image) Object.assign(tags, parsed.image);
        if (parsed.exif) Object.assign(tags, parsed.exif);
        if (parsed.gps) {
          if (parsed.gps.GPSLatitude) tags.GPSLatitude = parsed.gps.GPSLatitude;
          if (parsed.gps.GPSLongitude) tags.GPSLongitude = parsed.gps.GPSLongitude;
          if (parsed.gps.GPSAltitude) tags.GPSAltitude = parsed.gps.GPSAltitude;
          if (parsed.gps.GPSLatitudeRef) tags.GPSLatitudeRef = parsed.gps.GPSLatitudeRef;
          if (parsed.gps.GPSLongitudeRef) tags.GPSLongitudeRef = parsed.gps.GPSLongitudeRef;
          if (parsed.gps.GPSAltitudeRef) tags.GPSAltitudeRef = parsed.gps.GPSAltitudeRef;
        }
      } catch (_) {}
    }

    const result = {
      captureTime: null, make: null, model: null,
      offsetTimeOriginal: null, subSecTimeOriginal: null,
      exposureTime: null, fNumber: null, iso: null,
      focalLength: null, focalLengthIn35mm: null,
      flash: null, whiteBalance: null, meteringMode: null,
      exposureProgram: null, exposureBias: null,
      width: null, height: null, orientation: null, colorSpace: null,
      gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
      software: null, lensMake: null, lensModel: null,
    };

    let dto = tags.DateTimeOriginal || tags.DateTimeDigitized;
    if (dto instanceof Date) {
      result.captureTime = dto.toISOString().slice(0, 19);
    } else if (typeof dto === 'string') {
      const normalized = dto.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)) result.captureTime = normalized.slice(0, 19);
    }

    if (tags.Make) result.make = String(tags.Make).replace(/\0/g, '').trim().toLowerCase() || null;
    if (tags.Model) result.model = String(tags.Model).replace(/\0/g, '').trim().toLowerCase() || null;
    if (tags.OffsetTimeOriginal) result.offsetTimeOriginal = String(tags.OffsetTimeOriginal).trim();
    if (tags.SubSecTimeOriginal != null) result.subSecTimeOriginal = String(tags.SubSecTimeOriginal);
    if (tags.ExposureTime != null) result.exposureTime = r4(tags.ExposureTime);
    if (tags.FNumber != null) result.fNumber = r4(tags.FNumber);
    if (tags.ISO != null) result.iso = Number(tags.ISO);
    else if (tags.ISOSpeedRatings != null) result.iso = Array.isArray(tags.ISOSpeedRatings) ? tags.ISOSpeedRatings[0] : Number(tags.ISOSpeedRatings);
    if (tags.FocalLength != null) result.focalLength = r4(tags.FocalLength);
    if (tags.FocalLengthIn35mmFormat != null) result.focalLengthIn35mm = r4(tags.FocalLengthIn35mmFormat);
    if (tags.Flash != null) result.flash = typeof tags.Flash === 'number' ? tags.Flash : null;
    if (tags.WhiteBalance != null) result.whiteBalance = Number(tags.WhiteBalance);
    if (tags.MeteringMode != null) result.meteringMode = Number(tags.MeteringMode);
    if (tags.ExposureProgram != null) result.exposureProgram = Number(tags.ExposureProgram);
    if (tags.ExposureBiasValue != null) result.exposureBias = r4(tags.ExposureBiasValue);
    result.width = meta.width || null;
    result.height = meta.height || null;
    if (tags.Orientation != null) result.orientation = Number(tags.Orientation);
    else if (meta.orientation) result.orientation = meta.orientation;
    if (tags.ColorSpace != null) result.colorSpace = Number(tags.ColorSpace);
    if (tags.Software) result.software = String(tags.Software).replace(/\0/g, '').trim() || null;
    if (tags.LensMake) result.lensMake = String(tags.LensMake).replace(/\0/g, '').trim() || null;
    if (tags.LensModel) result.lensModel = String(tags.LensModel).replace(/\0/g, '').trim() || null;

    // GPS
    if (Array.isArray(tags.GPSLatitude) && tags.GPSLatitude.length === 3) {
      const [d, m, s] = tags.GPSLatitude;
      let lat = d + m / 60 + s / 3600;
      if (tags.GPSLatitudeRef === 'S') lat = -lat;
      result.gpsLatitude = t4(lat);
    } else if (typeof tags.GPSLatitude === 'number') {
      let lat = tags.GPSLatitude;
      if (tags.GPSLatitudeRef === 'S' && lat > 0) lat = -lat;
      result.gpsLatitude = t4(lat);
    }
    if (Array.isArray(tags.GPSLongitude) && tags.GPSLongitude.length === 3) {
      const [d, m, s] = tags.GPSLongitude;
      let lon = d + m / 60 + s / 3600;
      if (tags.GPSLongitudeRef === 'W') lon = -lon;
      result.gpsLongitude = t4(lon);
    } else if (typeof tags.GPSLongitude === 'number') {
      let lon = tags.GPSLongitude;
      if (tags.GPSLongitudeRef === 'W' && lon > 0) lon = -lon;
      result.gpsLongitude = t4(lon);
    }
    if (tags.GPSAltitude != null) {
      let alt = Number(tags.GPSAltitude);
      if (tags.GPSAltitudeRef === 1 && alt > 0) alt = -alt;
      result.gpsAltitude = t4(alt);
    }

    return result;
  } catch (_) {
    return null;
  }
}

/**
 * Main backfill runner.
 *
 * @param {Object} options
 * @param {string} options.serverUrl - StealthCloud server URL
 * @param {string} options.token - Auth token
 * @param {string} options.deviceUuid - Device UUID
 * @param {string[]} options.backupFolders - Local backup folder paths
 * @param {Object} options.store - electron-store instance (for cursor persistence)
 */
async function runExifBackfill({ serverUrl, token, deviceUuid, backupFolders, store }) {
  if (_running) {
    console.log(TAG, 'Already running, skipping');
    return;
  }
  if (!serverUrl || !token) {
    console.log(TAG, 'Missing serverUrl or token, skipping');
    return;
  }
  if (!backupFolders || backupFolders.length === 0) {
    console.log(TAG, 'No backup folders configured, skipping');
    return;
  }

  _running = true;
  _cancelled = false;
  _currentStore = store;

  const headers = { 'Authorization': `Bearer ${token}`, 'X-Device-UUID': deviceUuid || '' };

  try {
    // Load cursor
    let cursor = store ? (store.get(CURSOR_KEY) || {}) : {};
    if (cursor.completedAt) {
      console.log(TAG, `Already completed at ${cursor.completedAt}`);
      _running = false;
      return;
    }
    const processedSet = new Set(cursor.processedManifestIds || []);
    _currentProcessedSet = processedSet;
    console.log(TAG, `Starting desktop backfill (${processedSet.size} previously processed)`);

    // 1. Fetch manifest metadata
    console.log(TAG, 'Fetching manifests...');
    const allManifests = [];
    let offset = 0;
    const PAGE_LIMIT = 500;
    while (!_cancelled) {
      const resp = await axios.get(`${serverUrl}/api/cloud/manifests`, {
        headers, params: { offset, limit: PAGE_LIMIT, meta: 'true' }, timeout: 30000,
      });
      const batch = (resp.data && resp.data.manifests) || [];
      allManifests.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      offset += batch.length;
    }
    if (_cancelled) { _running = false; return; }
    console.log(TAG, `Total manifests: ${allManifests.length}`);

    // 2. Filter to image candidates
    const candidates = allManifests.filter(m => {
      if (!m.fileHash) return false;
      if (!m.filename || !IMAGE_EXTS.test(m.filename)) return false;
      if (processedSet.has(m.manifestId)) return false;
      return true;
    });
    console.log(TAG, `Image candidates: ${candidates.length}`);

    if (candidates.length === 0) {
      if (store) store.set(CURSOR_KEY, { processedManifestIds: [...processedSet].slice(-5000), completedAt: new Date().toISOString() });
      console.log(TAG, 'Nothing to backfill — marking complete');
      _running = false;
      return;
    }

    // 3. Batch-check missing EXIF
    console.log(TAG, 'Checking missing EXIF...');
    const missingSet = new Set();
    for (let i = 0; i < candidates.length && !_cancelled; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const hashes = batch.map(m => m.fileHash);
      try {
        const resp = await axios.post(`${serverUrl}/api/exif/check-missing`, { fileHashes: hashes }, { headers, timeout: 15000 });
        for (const h of (resp.data?.missing || [])) missingSet.add(h);
      } catch (e) {
        console.warn(TAG, 'check-missing error:', e?.message);
        for (const h of hashes) missingSet.add(h);
      }
      await sleep(200);
    }
    if (_cancelled) { _running = false; return; }

    const toBackfill = candidates.filter(m => missingSet.has(m.fileHash));
    console.log(TAG, `Missing EXIF: ${toBackfill.length}`);

    if (toBackfill.length === 0) {
      for (const m of candidates) processedSet.add(m.manifestId);
      if (store) store.set(CURSOR_KEY, { processedManifestIds: [...processedSet].slice(-5000), completedAt: new Date().toISOString() });
      console.log(TAG, 'All EXIF present — marking complete');
      _running = false;
      return;
    }

    // 4. Build local file lookup
    console.log(TAG, 'Scanning backup folders...');
    const localLookup = buildLocalFileLookup(backupFolders);
    if (_cancelled) { _running = false; return; }

    // 5. Process each missing file
    let stored = 0, notFound = 0, errors = 0;

    for (let i = 0; i < toBackfill.length && !_cancelled; i++) {
      // Pause while a heavy operation (backup/sync) is active
      while (_busy && !_cancelled) {
        await sleep(2000);
      }
      if (_cancelled) break;

      const { manifestId, filename, fileHash, originalSize } = toBackfill[i];

      try {
        const localPath = findLocalFile(localLookup, filename, originalSize);
        if (!localPath) {
          notFound++;
          processedSet.add(manifestId);
          continue;
        }

        const exif = await extractExif(localPath);
        if (!exif || (!exif.captureTime && !exif.make && exif.gpsLatitude == null)) {
          processedSet.add(manifestId);
          continue;
        }

        await axios.post(`${serverUrl}/api/exif/store`, {
          fileHash, exif, platform: 'desktop',
        }, { headers, timeout: 10000 });

        stored++;
        processedSet.add(manifestId);

        if (stored % 20 === 0 || (i + 1) % 100 === 0) {
          console.log(TAG, `Progress: ${i + 1}/${toBackfill.length}, stored=${stored}, notFound=${notFound}, errors=${errors}`);
        }

        // Save cursor every 50
        if (stored % 50 === 0 && store) {
          store.set(CURSOR_KEY, { processedManifestIds: [...processedSet].slice(-5000), updatedAt: new Date().toISOString() });
        }

      } catch (e) {
        errors++;
        processedSet.add(manifestId);
        if (errors <= 5) console.warn(TAG, `Error on ${filename}:`, e?.message);
      }

      await yieldToLoop();
      await sleep(INTER_FILE_DELAY_MS);
    }

    // Save final cursor
    const isComplete = !_cancelled;
    if (store) {
      store.set(CURSOR_KEY, {
        processedManifestIds: [...processedSet].slice(-5000),
        completedAt: isComplete ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      });
    }
    console.log(TAG, `Done. stored=${stored}, notFound=${notFound}, errors=${errors}, complete=${isComplete}`);

  } catch (e) {
    console.error(TAG, 'Fatal:', e?.message);
  } finally {
    _running = false;
  }
}

function cancelExifBackfill() {
  if (_running) {
    console.log(TAG, 'Cancelling...');
    _cancelled = true;
    // Persist cursor so progress isn't lost
    if (_currentStore && _currentProcessedSet) {
      try {
        _currentStore.set(CURSOR_KEY, {
          processedManifestIds: [..._currentProcessedSet].slice(-5000),
          updatedAt: new Date().toISOString(),
        });
      } catch (_) {}
    }
  }
}

module.exports = { runExifBackfill, cancelExifBackfill, signalBusy, signalIdle };
