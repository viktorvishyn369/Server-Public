const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const CLOUD_DIR = process.env.CLOUD_DIR;
let CHUNKS_DIR = process.env.CHUNKS_DIR; // HDD RAID10 for actual chunk storage
const CAPACITY_JSON_PATH = process.env.CAPACITY_JSON_PATH;
const DB_PATH = process.env.DB_PATH;

if (!CLOUD_DIR || !CAPACITY_JSON_PATH) {
  process.exit(2);
}

// Auto-detect CHUNKS_DIR if not provided but common mount exists
if (!CHUNKS_DIR && fs.existsSync('/data/chunks')) {
  CHUNKS_DIR = '/data/chunks';
}

// Use CHUNKS_DIR for capacity check if available (split storage mode)
// Otherwise fall back to CLOUD_DIR
const CAPACITY_CHECK_DIR = CHUNKS_DIR || CLOUD_DIR;

const getDfValueBytes = (p, col) => {
  try {
    const out = execFileSync('df', ['-B1', `--output=${col}`, p], { encoding: 'utf8' });
    const lines = String(out).trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const v = Number(lines[1]);
    return Number.isFinite(v) ? v : null;
  } catch (e) {
    return null;
  }
};

const getDfAvailBytes = (p) => getDfValueBytes(p, 'avail');
const getDfTotalBytes = (p) => getDfValueBytes(p, 'size');

const getAllocatedBytesFromDb = (dbPath) => {
  return new Promise((resolve) => {
    if (!dbPath || !fs.existsSync(dbPath)) return resolve([]);

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve([]);
    });

    db.serialize(() => {
      db.all(
        `SELECT plan_gb, COUNT(*) AS cnt
           FROM user_plans
          WHERE plan_gb IS NOT NULL
            AND (deleted_at IS NULL OR deleted_at = 0)
            AND status IN ('active','grace')
          GROUP BY plan_gb`,
        [],
        (err, rows) => {
          try {
            db.close();
          } catch (e) {
          }
          if (err) return resolve([]);
          const list = Array.isArray(rows) ? rows : [];
          return resolve(list);
        }
      );
    });
  });
};

const computeReserveBytesForPlan = ({ planBytes, reservePct, reserveMinBytes, reserveMaxBytes }) => {
  const raw = Math.ceil(planBytes * reservePct);
  return Math.max(reserveMinBytes, Math.min(reserveMaxBytes, raw));
};

const computeRequiredBytesForTier = ({ tierGb, reservePct, reserveMinBytes, reserveMaxBytes }) => {
  const GB = 1000 * 1000 * 1000;
  const planBytes = Math.ceil(Number(tierGb) * GB);
  const reserveBytes = computeReserveBytesForPlan({ planBytes, reservePct, reserveMinBytes, reserveMaxBytes });
  return planBytes + reserveBytes;
};

const computeCanCreate = ({ freeBytes, totalBytes, allocatedBytes, reservePct, reserveMinBytes, reserveMaxBytes }) => {
  const GB = 1000 * 1000 * 1000;
  const SAFETY = 20 * GB;
  const tiers = [100, 200, 400, 1000];
  const canCreate = {};

  const total = typeof totalBytes === 'number' && Number.isFinite(totalBytes) ? totalBytes : 0;
  const alloc = typeof allocatedBytes === 'number' && Number.isFinite(allocatedBytes) ? allocatedBytes : 0;
  const remainingAllocBytes = Math.max(0, total - alloc - SAFETY);

  for (const tierGb of tiers) {
    const requiredBytes = computeRequiredBytesForTier({ tierGb, reservePct, reserveMinBytes, reserveMaxBytes });
    const reserved = requiredBytes + SAFETY;
    const freeOk = typeof freeBytes === 'number' && freeBytes >= reserved;
    const allocOk = remainingAllocBytes >= requiredBytes;
    canCreate[String(tierGb)] = freeOk && allocOk;
  }
  return canCreate;
};

const ensureDir = (p) => {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const main = async () => {
  ensureDir(CAPACITY_JSON_PATH);

  const GB = 1000 * 1000 * 1000;
  const SAFETY = 20 * GB;
  const RESERVE_PCT = Number(process.env.CAPACITY_RESERVE_PCT || '0.10');
  const RESERVE_MIN_BYTES = Math.ceil(Number(process.env.CAPACITY_RESERVE_MIN_GB || '5') * GB);
  const RESERVE_MAX_BYTES = Math.ceil(Number(process.env.CAPACITY_RESERVE_MAX_GB || '50') * GB);

  const freeBytes = getDfAvailBytes(CAPACITY_CHECK_DIR);
  const totalBytes = getDfTotalBytes(CAPACITY_CHECK_DIR);

  const planRows = await getAllocatedBytesFromDb(DB_PATH);
  const allocatedBytes = (Array.isArray(planRows) ? planRows : []).reduce((sum, r) => {
    const gb = r && r.plan_gb !== undefined && r.plan_gb !== null ? Number(r.plan_gb) : 0;
    const cnt = r && r.cnt !== undefined && r.cnt !== null ? Number(r.cnt) : 0;
    if (!Number.isFinite(gb) || gb <= 0) return sum;
    if (!Number.isFinite(cnt) || cnt <= 0) return sum;
    const required = computeRequiredBytesForTier({
      tierGb: gb,
      reservePct: RESERVE_PCT,
      reserveMinBytes: RESERVE_MIN_BYTES,
      reserveMaxBytes: RESERVE_MAX_BYTES,
    });
    return sum + (required * cnt);
  }, 0);

  let canCreate = computeCanCreate({
    freeBytes,
    totalBytes,
    allocatedBytes,
    reservePct: RESERVE_PCT,
    reserveMinBytes: RESERVE_MIN_BYTES,
    reserveMaxBytes: RESERVE_MAX_BYTES,
  });

  // Override for emergency: always allow new registrations
  canCreate = { '100': true, '200': true, '400': true, '1000': true };
  const anyAvailable = Object.values(canCreate).some(v => v === true);
  const defaultMessage = anyAvailable ? null : 'Temporarily unavailable — we\'re expanding capacity.';

  const tiers = {};
  Object.keys(canCreate).forEach((k) => {
    tiers[k] = { canCreate: !!canCreate[k] };
  });

  const payload = {
    schemaVersion: 2,
    updatedAt: Date.now(),
    freeBytes: typeof freeBytes === 'number' ? freeBytes : 0,
    totalBytes: typeof totalBytes === 'number' ? totalBytes : 0,
    allocatedBytes: Number.isFinite(allocatedBytes) ? allocatedBytes : 0,
    safetyBytes: SAFETY,
    reservePct: RESERVE_PCT,
    reserveMinBytes: RESERVE_MIN_BYTES,
    reserveMaxBytes: RESERVE_MAX_BYTES,
    canCreate,
    tiers,
    message: process.env.CAPACITY_MESSAGE ? String(process.env.CAPACITY_MESSAGE) : defaultMessage,
  };

  const tmpPath = `${CAPACITY_JSON_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmpPath, CAPACITY_JSON_PATH);
};

main();
