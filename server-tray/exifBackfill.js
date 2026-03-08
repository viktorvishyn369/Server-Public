const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { DesktopBackupClient } = require('./backup-client');

const TAG = '[ExifBackfill]';
const STORAGE_KEY_PREFIX = 'exifBackfillCursor:';
const BATCH_SIZE = 50;
const INTER_FILE_DELAY_MS = 2000;
const INTER_BATCH_DELAY_MS = 500;
const MAX_ERRORS_BEFORE_PAUSE = 5;
const ERROR_PAUSE_MS = 30000;
const IMAGE_EXTS = /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif)$/i;

let _running = false;
let _cancelled = false;
let _busy = false;
let _currentStore = null;
let _currentStorageKey = null;
let _currentProcessedIds = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quickYield = () => new Promise((resolve) => (typeof setImmediate !== 'undefined' ? setImmediate(resolve) : setTimeout(resolve, 0)));

const signalBusy = () => { _busy = true; };
const signalIdle = () => { _busy = false; };

const getStorageKey = (serverUrl) => {
  const safe = String(serverUrl || '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);
  return `${STORAGE_KEY_PREFIX}${safe}`;
};

const loadCursor = (store, serverUrl) => {
  try {
    const raw = store?.get(getStorageKey(serverUrl)) || null;
    if (!raw || typeof raw !== 'object') {
      return { processedManifestIds: new Set(), completedAt: null };
    }
    return {
      processedManifestIds: new Set(Array.isArray(raw.processedManifestIds) ? raw.processedManifestIds : []),
      completedAt: raw.completedAt || null,
    };
  } catch (e) {
    console.warn(TAG, 'loadCursor error:', e?.message);
    return { processedManifestIds: new Set(), completedAt: null };
  }
};

const saveCursor = (store, serverUrl, processedManifestIds, completedAt = null) => {
  try {
    if (!store) return;
    store.set(getStorageKey(serverUrl), {
      processedManifestIds: [...processedManifestIds].slice(-10000),
      completedAt,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(TAG, 'saveCursor error:', e?.message);
  }
};

const persistCurrentCursor = (store, serverUrl, cursor, completedAt = cursor?.completedAt || null) => {
  if (!store || !serverUrl || !cursor?.processedManifestIds) return;
  saveCursor(store, serverUrl, cursor.processedManifestIds, completedAt);
  cursor.completedAt = completedAt;
};

const markManifestDone = (cursor, manifestId) => {
  if (!cursor?.processedManifestIds || !manifestId) return;
  cursor.processedManifestIds.add(manifestId);
};

const walkFolder = async (folderPath, files, depth = 0) => {
  if (_cancelled || depth > 6) return;
  let entries = [];
  try {
    entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (_cancelled) return;
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      await walkFolder(fullPath, files, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!IMAGE_EXTS.test(entry.name)) continue;
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile() || stat.size <= 0) continue;
      files.push({ filePath: fullPath, filename: entry.name, originalSize: stat.size });
    } catch (_) {}
  }
};

const buildLocalFileLookup = async (backupFolders) => {
  const lookup = new Map();
  const files = [];
  for (const folder of backupFolders || []) {
    if (_cancelled) break;
    if (!folder || !fs.existsSync(folder)) continue;
    await walkFolder(folder, files, 0);
    await quickYield();
  }
  for (const file of files) {
    const key = `${String(file.filename || '').toLowerCase()}|${Number(file.originalSize) || 0}`;
    if (file.filename && file.originalSize > 0 && !lookup.has(key)) {
      lookup.set(key, file);
    }
  }
  console.log(TAG, `Local desktop lookup built: ${lookup.size} unique filename+size entries from ${files.length} files`);
  return lookup;
};

const computeFileHash = async (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

const createExifExtractor = ({ serverUrl, token, deviceUuid }) => {
  return new DesktopBackupClient({
    destination: 'stealthcloud',
    baseUrl: serverUrl,
    token,
    deviceUuid,
  }, () => {});
};

async function runExifBackfill({ serverUrl, token, deviceUuid, backupFolders, store }) {
  if (_running) {
    console.log(TAG, 'Already running, skipping');
    return;
  }
  if (!serverUrl || !token || !store || !Array.isArray(backupFolders) || backupFolders.length === 0) {
    return;
  }

  _running = true;
  _cancelled = false;
  _currentStore = store;
  _currentStorageKey = getStorageKey(serverUrl);

  try {
    const cursor = loadCursor(store, serverUrl);
    _currentProcessedIds = cursor.processedManifestIds;
    if (cursor.completedAt) {
      console.log(TAG, `Previous run completed at ${cursor.completedAt}; checking for newly syncable manifests...`);
    }

    console.log(TAG, `Starting desktop backfill. Previously processed: ${cursor.processedManifestIds.size}`);

    const PAGE_LIMIT = 500;
    const allManifests = [];
    let offset = 0;
    while (!_cancelled) {
      const resp = await axios.get(`${serverUrl}/api/cloud/manifests`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Device-UUID': deviceUuid || '',
        },
        params: { offset, limit: PAGE_LIMIT, meta: true },
        timeout: 30000,
      });
      const batch = resp.data?.manifests || [];
      allManifests.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      offset += batch.length;
      await quickYield();
    }
    if (_cancelled) return;

    const candidates = allManifests.filter((m) => {
      if (!m?.fileHash) return false;
      if (!m?.filename || !IMAGE_EXTS.test(m.filename)) return false;
      if (cursor.processedManifestIds.has(m.manifestId)) return false;
      return true;
    });

    console.log(TAG, `Candidates to check: ${candidates.length} (skipped ${allManifests.length - candidates.length} already processed/non-image/no-hash)`);

    if (candidates.length === 0) {
      persistCurrentCursor(store, serverUrl, cursor, new Date().toISOString());
      console.log(TAG, 'Nothing to backfill — marking complete');
      return;
    }

    if (cursor.completedAt) {
      persistCurrentCursor(store, serverUrl, cursor, null);
    }

    const missingSet = new Set();
    for (let i = 0; i < candidates.length && !_cancelled; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const hashes = batch.map((m) => m.fileHash);
      try {
        const resp = await axios.post(`${serverUrl}/api/exif/check-missing`, { fileHashes: hashes }, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Device-UUID': deviceUuid || '',
          },
          timeout: 15000,
        });
        for (const hash of resp.data?.missing || []) missingSet.add(hash);
      } catch (e) {
        console.warn(TAG, 'check-missing batch error:', e?.message);
        for (const hash of hashes) missingSet.add(hash);
      }
      await sleep(INTER_BATCH_DELAY_MS);
    }
    if (_cancelled) return;

    const toBackfill = candidates.filter((m) => missingSet.has(m.fileHash));
    console.log(TAG, `Missing EXIF: ${toBackfill.length} of ${candidates.length} checked`);

    if (toBackfill.length === 0) {
      for (const manifest of candidates) markManifestDone(cursor, manifest.manifestId);
      persistCurrentCursor(store, serverUrl, cursor, new Date().toISOString());
      console.log(TAG, 'All EXIF present — marking complete');
      return;
    }

    const localLookup = await buildLocalFileLookup(backupFolders);
    if (_cancelled) return;

    const extractor = createExifExtractor({ serverUrl, token, deviceUuid });
    let processed = 0;
    let stored = 0;
    let notFound = 0;
    let errors = 0;
    let consecutiveErrors = 0;

    for (const manifest of toBackfill) {
      if (_cancelled) break;
      while (_busy && !_cancelled) {
        persistCurrentCursor(store, serverUrl, cursor, null);
        await sleep(2000);
      }
      if (_cancelled) break;

      processed += 1;
      const filename = String(manifest.filename || '').toLowerCase();
      const size = Number(manifest.originalSize) || 0;
      const key = size > 0 ? `${filename}|${size}` : null;
      const localFile = key ? localLookup.get(key) : null;

      if (!localFile) {
        notFound += 1;
        if (processed % 20 === 0) persistCurrentCursor(store, serverUrl, cursor, null);
        if (processed % 50 === 0) {
          console.log(TAG, `Progress: ${processed}/${toBackfill.length}, stored=${stored}, notFound=${notFound}, errors=${errors}`);
        }
        continue;
      }

      try {
        const exactHash = await computeFileHash(localFile.filePath);
        if (!exactHash || exactHash !== manifest.fileHash) {
          notFound += 1;
          if (processed % 20 === 0) persistCurrentCursor(store, serverUrl, cursor, null);
          continue;
        }

        const fullExif = await extractor.extractFullExif(localFile.filePath);
        if (!fullExif || (!fullExif.captureTime && !fullExif.make && fullExif.gpsLatitude == null)) {
          if (processed % 20 === 0) persistCurrentCursor(store, serverUrl, cursor, null);
          continue;
        }

        await axios.post(`${serverUrl}/api/exif/store`, {
          fileHash: manifest.fileHash,
          exif: fullExif,
          platform: 'desktop',
        }, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Device-UUID': deviceUuid || '',
          },
          timeout: 10000,
        });

        stored += 1;
        consecutiveErrors = 0;
        markManifestDone(cursor, manifest.manifestId);
        if (stored % 10 === 0 || processed % 50 === 0) {
          console.log(TAG, `Progress: ${processed}/${toBackfill.length}, stored=${stored}, notFound=${notFound}, errors=${errors}`);
        }
        if (stored % 20 === 0) persistCurrentCursor(store, serverUrl, cursor, null);
      } catch (e) {
        errors += 1;
        consecutiveErrors += 1;
        console.warn(TAG, `Error processing ${manifest.filename}:`, e?.message);
        if (processed % 10 === 0) persistCurrentCursor(store, serverUrl, cursor, null);
        if (consecutiveErrors >= MAX_ERRORS_BEFORE_PAUSE) {
          persistCurrentCursor(store, serverUrl, cursor, null);
          console.log(TAG, `${consecutiveErrors} consecutive errors, pausing ${ERROR_PAUSE_MS / 1000}s...`);
          await sleep(ERROR_PAUSE_MS);
          consecutiveErrors = 0;
        }
      }

      await sleep(INTER_FILE_DELAY_MS);
    }

    const isComplete = processed >= toBackfill.length && !_cancelled;
    persistCurrentCursor(store, serverUrl, cursor, isComplete ? new Date().toISOString() : null);
    console.log(TAG, `Done. processed=${processed}, stored=${stored}, notFound=${notFound}, errors=${errors}, complete=${isComplete}`);
  } catch (e) {
    console.error(TAG, 'Fatal error:', e?.message);
  } finally {
    _running = false;
    _currentStore = null;
    _currentStorageKey = null;
    _currentProcessedIds = null;
  }
}

async function cancelExifBackfill() {
  if (_running) {
    console.log(TAG, 'Cancelling...');
    _cancelled = true;
    if (_currentStore && _currentStorageKey && _currentProcessedIds) {
      try {
        _currentStore.set(_currentStorageKey, {
          processedManifestIds: [..._currentProcessedIds].slice(-10000),
          completedAt: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (_) {}
    }
  }
}

module.exports = {
  runExifBackfill,
  cancelExifBackfill,
  signalBusy,
  signalIdle,
};
