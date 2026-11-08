const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const axios = require('axios');
let sharp;
try { sharp = require('sharp'); console.log('[Server] sharp loaded'); } catch (e) { sharp = null; console.log('[Server] sharp failed to load:', e.message); }

// HEIC conversion support - try to load heic-convert for HEIC thumbnail generation
let heicConvert;
try { heicConvert = require('heic-convert'); console.log('[Server] heic-convert loaded'); } catch (e) { heicConvert = null; console.log('[Server] heic-convert failed to load:', e.message); }

/**
 * Concurrency limiter for sharp operations to prevent OOM under parallel uploads.
 * Only N sharp calls run at a time; the rest queue up.
 */
const SHARP_CONCURRENCY = 2;
let sharpRunning = 0;
const sharpQueue = [];
const runWithSharpLimit = (fn) => new Promise((resolve, reject) => {
    const execute = () => {
        sharpRunning++;
        fn().then(resolve, reject).finally(() => {
            sharpRunning--;
            if (sharpQueue.length > 0) sharpQueue.shift()();
        });
    };
    if (sharpRunning < SHARP_CONCURRENCY) execute();
    else sharpQueue.push(execute);
});

/**
 * Compute perceptual hash (dHash) for an image file
 * Returns 16-character hex string (64-bit hash)
 */
const computePerceptualHash = async (filePath) => {
    if (!sharp) return null;
    try {
        // Timeout to prevent hanging on problematic files (animated GIFs on Windows)
        const timeoutMs = 5000;
        const hashPromise = (async () => {
            return await runWithSharpLimit(async () => {
                // Read file into buffer to avoid Sharp holding file handle open on Windows
                const fileBuffer = fs.readFileSync(filePath);
                // Resize to 9x8 grayscale for dHash
                // Use { pages: 1 } to only process first frame of animated images
                const { data, info } = await sharp(fileBuffer, { pages: 1 })
                    .resize(9, 8, { fit: 'fill' })
                    .grayscale()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                
                if (info.width !== 9 || info.height !== 8) return null;
                
                // Compute difference hash - compare adjacent horizontal pixels
                let hash = BigInt(0);
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        const left = data[y * 9 + x];
                        const right = data[y * 9 + x + 1];
                        if (left > right) {
                            hash |= BigInt(1) << BigInt(y * 8 + x);
                        }
                    }
                }
                
                // Convert to 16-char hex string
                return hash.toString(16).padStart(16, '0');
            });
        })();
        
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Perceptual hash timeout')), timeoutMs)
        );
        
        return await Promise.race([hashPromise, timeoutPromise]);
    } catch (e) {
        console.log('computePerceptualHash error:', e.message);
        return null;
    }
};

// Try to use bundled ffmpeg, fallback to system ffmpeg
let ffmpegPath = 'ffmpeg';
const findFfmpeg = () => {
    // 1. Try ffmpeg relative to this script (for Electron bundled app)
    const scriptDir = __dirname;
    const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
    const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    
    // Check in node_modules relative to script
    const localPaths = [
        path.join(scriptDir, 'node_modules', '@ffmpeg-installer', `${platform}-${arch}`, ffmpegName),
        path.join(scriptDir, 'node_modules', '@ffmpeg-installer', `${platform}-x64`, ffmpegName),
        path.join(scriptDir, '..', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', `${platform}-${arch}`, ffmpegName),
        path.join(scriptDir, '..', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', `${platform}-x64`, ffmpegName),
    ];
    
    for (const p of localPaths) {
        if (fs.existsSync(p)) {
            console.log('Using bundled ffmpeg (local):', p);
            return p;
        }
    }
    
    // 2. Try @ffmpeg-installer/ffmpeg module
    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        let installerPath = ffmpegInstaller.path;
        if (installerPath && typeof installerPath === 'string') {
            if (installerPath.includes('app.asar')) {
                installerPath = installerPath.replace('app.asar', 'app.asar.unpacked');
            }
            if (fs.existsSync(installerPath)) {
                console.log('Using bundled ffmpeg:', installerPath);
                return installerPath;
            } else {
                console.log('Bundled ffmpeg not found at:', installerPath);
            }
        }
    } catch (e) {}
    
    // 3. Try ffmpeg-static
    try {
        let staticPath = require('ffmpeg-static');
        if (staticPath && typeof staticPath === 'string') {
            if (staticPath.includes('app.asar')) {
                staticPath = staticPath.replace('app.asar', 'app.asar.unpacked');
            }
            if (fs.existsSync(staticPath)) {
                console.log('Using bundled ffmpeg-static:', staticPath);
                return staticPath;
            }
        }
    } catch (e2) {}
    
    console.log('No bundled ffmpeg available, using system ffmpeg');
    return 'ffmpeg';
};
ffmpegPath = findFfmpeg();

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// JWT_SECRET: env wins; otherwise a unique per-install secret is generated and
// persisted under ~/.config/photolynk/ so tokens from one self-hosted server can
// never verify on another. Persist failure degrades to an ephemeral secret
// (secure, but sessions reset on restart — warned loudly).
const JWT_SECRET = (() => {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
        const installTag = crypto.createHash('sha256').update(__dirname).digest('hex').slice(0, 12);
        const homeDir = require('os').homedir();
        if (!homeDir) throw new Error('no home directory');
        const keyDir = path.join(homeDir, '.config', 'photolynk');
        const keyFile = path.join(keyDir, `jwt-secret-${installTag}`);
        const generated = crypto.randomBytes(48).toString('hex');
        fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
        try {
            fs.writeFileSync(keyFile, generated + '\n', { mode: 0o600, flag: 'wx' });
            console.warn('[Server] JWT_SECRET not set — generated a unique per-install secret at ' + keyFile);
            return generated;
        } catch (writeErr) {
            const existing = fs.readFileSync(keyFile, 'utf8').trim();
            if (existing.length >= 32) return existing;
            fs.writeFileSync(keyFile, generated + '\n', { mode: 0o600 });
            return generated;
        }
    } catch (e) {
        console.warn('[Server] JWT_SECRET not set and a generated secret could not be persisted (' + e.message + ') — using an ephemeral secret; logins reset on restart. Set JWT_SECRET in the environment.');
        return crypto.randomBytes(48).toString('hex');
    }
})();
const BCRYPT_ROUNDS = Number.parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

const computeStorageUuidFromEmail = (email) => {
    const normalizedEmail = String(email || '').toLowerCase().trim();
    if (!normalizedEmail) return '';
    const hex = crypto.createHmac('sha256', JWT_SECRET)
        .update(`storage:${normalizedEmail}`)
        .digest('hex')
        .slice(0, 32);
    if (!hex || hex.length !== 32) return '';
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const ENABLE_HTTPS = String(process.env.ENABLE_HTTPS || '').toLowerCase() === 'true';
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const FORCE_HTTPS_REDIRECT = String(process.env.FORCE_HTTPS_REDIRECT || '').toLowerCase() === 'true';
// Use home directory for universal path across any user/OS
const os = require('os');
const HOME_DIR = os.homedir();

const DEFAULT_LINUX_MEDIA_DIR = '/data/media';
const DEFAULT_LINUX_DB_DIR = '/data/db';

const isExistingDir = (p) => {
    try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch (e) {
        return false;
    }
};

const resolveDataDir = () => {
    if (process.env.PHOTOSYNC_DATA_DIR) return process.env.PHOTOSYNC_DATA_DIR;
    if (process.env.UPLOAD_DIR) return path.dirname(process.env.UPLOAD_DIR);
    if (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) || isExistingDir(DEFAULT_LINUX_DB_DIR)) return '/data';
    const photolynkDir = path.join(HOME_DIR, 'PhotoLynk', 'server');
    const photosyncDir = path.join(HOME_DIR, 'PhotoSync', 'server');
    try {
        if (fs.existsSync(photolynkDir)) return photolynkDir;
        if (fs.existsSync(photosyncDir)) return photosyncDir;
    } catch (e) {
        // ignore
    }
    return photolynkDir;
};

const normalizeTierGb = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n === 100 || n === 200 || n === 400 || n === 1000) return n;
    return null;
};

const inferTierGbFromProductId = (productId) => {
    if (!productId) return null;
    const pid = String(productId);
    const pidLower = pid.toLowerCase();
    if (pidLower === 'stealthcloud_1tb_monthly' || pidLower === 'stealthcloud.1tb.monthly') return 1000;

    const m = pid.match(/(?:^|[._])stealthcloud[._](\d+)(gb|tb)[._]monthly$/i);
    if (!m) {
        const legacy = pid.match(/^stealthcloud_(\d+)(gb|tb)_monthly$/i);
        if (!legacy) return null;

        const qtyLegacy = Number(legacy[1]);
        const unitLegacy = String(legacy[2]).toLowerCase();
        if (!Number.isFinite(qtyLegacy) || qtyLegacy <= 0) return null;
        if (unitLegacy === 'tb') return qtyLegacy * 1000;
        return qtyLegacy;
    }
    const qty = Number(m[1]);
    const unit = String(m[2]).toLowerCase();
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (unit === 'tb') return qty * 1000;
    return qty;
};

const DATA_DIR = resolveDataDir();
const UPLOAD_DIR =
    process.env.UPLOAD_DIR || (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) ? DEFAULT_LINUX_MEDIA_DIR : path.join(DATA_DIR, 'uploads'));
const DB_PATH =
    process.env.DB_PATH || (isExistingDir(DEFAULT_LINUX_DB_DIR) ? path.join(DEFAULT_LINUX_DB_DIR, 'backup.db') : path.join(DATA_DIR, 'backup.db'));
const AUX_ROOT = process.env.PHOTOSYNC_DATA_DIR || path.dirname(UPLOAD_DIR);
const CLOUD_DIR = process.env.CLOUD_DIR || path.join(AUX_ROOT, 'cloud'); // NVMe: manifests, small data
const CHUNKS_DIR = process.env.CHUNKS_DIR || null; // HDD RAID10: chunks only (if set)
const CAPACITY_JSON_PATH = process.env.CAPACITY_JSON_PATH || path.join(AUX_ROOT, '.well-known', 'photolynk-capacity.json');

const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
const TRIAL_COMPLIMENTARY_DAYS = Number.parseInt(process.env.TRIAL_COMPLIMENTARY_DAYS || '3', 10);
const USER_QUOTA_MARGIN_BYTES = Number.parseInt(process.env.USER_QUOTA_MARGIN_BYTES || String(50 * 1024 * 1024), 10);

// Security & Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
        },
    },
}));
app.use(cors());
// Behind a same-host reverse proxy (the installer's nginx), trust X-Forwarded-For
// only from loopback so req.ip is the real client IP — the auth rate limiter and
// logs stay per-user instead of collapsing into one 127.0.0.1 bucket. Direct
// connections to PORT are unaffected (XFF ignored). Override with TRUST_PROXY.
const _trustProxyEnv = String(process.env.TRUST_PROXY || '').trim();
app.set('trust proxy', _trustProxyEnv === '' ? 'loopback'
    : _trustProxyEnv === 'true' ? true
    : _trustProxyEnv === 'false' ? false
    : /^\d+$/.test(_trustProxyEnv) ? Number(_trustProxyEnv)
    : _trustProxyEnv);
app.use(morgan('common')); // Logging
// Allow larger JSON payloads (clients may send sizeable metadata blobs)
app.use(express.json({ limit: '25mb' }));

// Optional upload size cap in bytes (0 = unlimited). Protects a VPS disk from
// a single runaway/abusive account. Applies to both raw and multipart uploads.
const UPLOAD_MAX_BYTES = Math.max(0, Number.parseInt(process.env.UPLOAD_MAX_BYTES || '0', 10) || 0);

// Serve .well-known directory for capacity JSON
app.use('/.well-known', express.static(path.join(AUX_ROOT, '.well-known')));

// Prevent stale caching (e.g., 304 Not Modified) for API responses like StealthCloud manifest listing
app.set('etag', false);

// Basic brute-force protection for auth endpoints (in-memory)
const createRateLimiter = ({ windowMs, max }) => {
    const hits = new Map();
    const windowMsNum = Number(windowMs);
    const maxNum = Number(max);

    return (req, res, next) => {
        const now = Date.now();
        const key = `${req.ip}:${req.path}`;
        const entry = hits.get(key) || { count: 0, resetAt: now + windowMsNum };

        if (now > entry.resetAt) {
            entry.count = 0;
            entry.resetAt = now + windowMsNum;
        }

        entry.count += 1;
        hits.set(key, entry);

        const remaining = Math.max(0, maxNum - entry.count);
        res.setHeader('X-RateLimit-Limit', String(maxNum));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.resetAt / 1000)));

        if (entry.count > maxNum) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });

        }

        next();
    };
};

const AUTH_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10);
const AUTH_RATE_LIMIT_MAX = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '25', 10);
const authRateLimiter = createRateLimiter({ windowMs: AUTH_RATE_LIMIT_WINDOW_MS, max: AUTH_RATE_LIMIT_MAX });

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

// Email verification: set to true to require email verification before login
const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION === 'true' || false;

// Country/geo verification: require re-verification when logging in from a new country
// DISABLED for development - set to true in production if needed
const REQUIRE_COUNTRY_VERIFICATION = false; // process.env.REQUIRE_COUNTRY_VERIFICATION === 'true';

// Get country from IP using free ip-api.com (no API key needed)
const getCountryFromIP = async (ip) => {
    try {
        // Skip for localhost/private IPs
        if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
            return null;
        }
        // Clean IP (remove ::ffff: prefix for IPv4-mapped IPv6)
        const cleanIp = ip.replace(/^::ffff:/, '');
        const response = await axios.get(`http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode`, { timeout: 5000 });
        if (response.data && response.data.status === 'success') {
            return { country: response.data.country, countryCode: response.data.countryCode };
        }
    } catch (e) {
        console.log('[Geo] IP lookup failed:', e.message);
    }
    return null;
};

// Generate 6-digit verification code
const generateVerificationCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// In-memory store for pending verifications (email and country)
// In production, use Redis or database for persistence across restarts
const pendingVerifications = new Map();

// Ensure base data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Ensure cloud directory exists
if (!fs.existsSync(CLOUD_DIR)) {
    fs.mkdirSync(CLOUD_DIR, { recursive: true });
}

const capacityDir = path.dirname(CAPACITY_JSON_PATH);
if (!fs.existsSync(capacityDir)) {
    fs.mkdirSync(capacityDir, { recursive: true });
}

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Database Setup
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log(`Connected to SQLite database at ${DB_PATH}`);
});

// SQLite concurrency tuning for single-server deployments.
// WAL reduces write contention; busy_timeout avoids transient SQLITE_BUSY under load.
db.serialize(() => {
    db.run(`PRAGMA journal_mode=WAL`);
    db.run(`PRAGMA synchronous=NORMAL`);
    db.run(`PRAGMA busy_timeout=5000`);
});

const dbGetAsync = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
    });
});

const dbRunAsync = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
    });
});

const dbAllAsync = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(Array.isArray(rows) ? rows : []);
    });
});

const getUserDeviceUuids = async (user) => {
    const current = (user && (user.device_uuid || user.deviceUuid)) ? String(user.device_uuid || user.deviceUuid) : '';
    let rows = [];
    try {
        rows = await dbAllAsync(`SELECT device_uuid FROM devices WHERE user_id = ?`, [user.id]);
    } catch (e) {
        rows = [];
    }

    // If user_id lookup returned nothing (e.g. token from a different server instance),
    // try to find the local user by email and get their devices instead.
    if ((!rows || rows.length === 0) && user.email) {
        try {
            const localUser = await dbGetAsync(`SELECT id FROM users WHERE email = ?`, [String(user.email).toLowerCase().trim()]);
            if (localUser && localUser.id && localUser.id !== user.id) {
                rows = await dbAllAsync(`SELECT device_uuid FROM devices WHERE user_id = ?`, [localUser.id]);
            }
        } catch (e) {
            // ignore
        }
    }

    const uuids = [current, ...(rows || []).map(r => (r && r.device_uuid) ? String(r.device_uuid) : '')].filter(Boolean);

    return Array.from(new Set(uuids));
};

/**
 * When a user changes their password, their device_uuid changes (UUIDv5 from email:password).
 * This function finds existing storage folders under any of the user's OLD device_uuids
 * (tracked in the devices table) and renames them to the NEW device_uuid so data follows
 * the user seamlessly.
 *
 * Called at login time when a new device_uuid is registered for an existing user.
 */
const migrateUserFoldersToNewDeviceUuid = async (userId, newDeviceUuid, userEmail) => {
    const safeNew = String(newDeviceUuid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeNew) return;

    // Collect all old keys this user might have folders under
    const oldKeys = new Set();

    // 1. All previous device_uuids from devices table
    try {
        const rows = await dbAllAsync(`SELECT device_uuid FROM devices WHERE user_id = ?`, [userId]);
        (rows || []).forEach(r => {
            if (r && r.device_uuid) {
                const safe = String(r.device_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
                if (safe && safe !== safeNew) oldKeys.add(safe);
            }
        });
    } catch (e) { /* ignore */ }

    // 2. user_uuid and storage_uuid from users table
    try {
        const row = await dbGetAsync(`SELECT user_uuid, storage_uuid FROM users WHERE id = ?`, [userId]);
        if (row) {
            if (row.user_uuid) {
                const safe = String(row.user_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
                if (safe && safe !== safeNew) oldKeys.add(safe);
            }
            if (row.storage_uuid) {
                const safe = String(row.storage_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
                if (safe && safe !== safeNew) oldKeys.add(safe);
            }
        }
    } catch (e) { /* ignore */ }

    // 3. Numeric user id
    const numericKey = String(userId);
    if (numericKey !== safeNew) oldKeys.add(numericKey);

    if (oldKeys.size === 0) return;

    const cloudUsersRoot = path.join(CLOUD_DIR, 'users');
    const chunksUsersRoot = CHUNKS_DIR ? path.join(CHUNKS_DIR, 'users') : null;

    // Recursively remove a directory tree if all contents are empty dirs
    const removeEmptyDirTree = (dir) => {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory()) removeEmptyDirTree(path.join(dir, e.name));
            }
            // Try removing — will fail if non-empty (has files), which is fine
            fs.rmdirSync(dir);
        } catch (e) { /* not empty or already gone */ }
    };

    const safeRename = (oldDir, newDir, label) => {
        try {
            if (!fs.existsSync(oldDir)) return false;
            if (fs.existsSync(newDir)) {
                // New dir already exists — merge files from old into new
                console.log(`[FolderMigrate] ${label}: new dir exists, merging from ${oldDir} -> ${newDir}`);
                const mergeRecursive = (src, dst) => {
                    const entries = fs.readdirSync(src, { withFileTypes: true });
                    for (const entry of entries) {
                        const srcPath = path.join(src, entry.name);
                        const dstPath = path.join(dst, entry.name);
                        if (entry.isDirectory()) {
                            if (!fs.existsSync(dstPath)) {
                                fs.renameSync(srcPath, dstPath);
                            } else {
                                mergeRecursive(srcPath, dstPath);
                            }
                        } else {
                            if (!fs.existsSync(dstPath)) {
                                fs.renameSync(srcPath, dstPath);
                            }
                        }
                    }
                };
                mergeRecursive(oldDir, newDir);
                // Clean up: recursively remove empty leftover dirs
                removeEmptyDirTree(oldDir);
                return true;
            }
            fs.renameSync(oldDir, newDir);
            console.log(`[FolderMigrate] ${label}: renamed ${oldDir} -> ${newDir}`);
            return true;
        } catch (e) {
            console.error(`[FolderMigrate] ${label}: failed ${oldDir} -> ${newDir}:`, e.message);
            return false;
        }
    };

    for (const oldKey of oldKeys) {
        // Cloud users dir (NVMe: manifests, raw-meta)
        safeRename(path.join(cloudUsersRoot, oldKey), path.join(cloudUsersRoot, safeNew), 'cloud');
        // Chunks dir (RAID10: chunks, raw)
        if (chunksUsersRoot) {
            safeRename(path.join(chunksUsersRoot, oldKey), path.join(chunksUsersRoot, safeNew), 'chunks');
        }
    }

    console.log(`[FolderMigrate] User ${userId} (${userEmail || '?'}): migrated folders from [${[...oldKeys].join(', ')}] -> ${safeNew}`);
};

const resolveClassicFileForUser = async (user, filename) => {
    const safeName = path.basename(filename || '').replace(/\0/g, '');
    // Never serve in-progress raw uploads (they end in .uploading)
    if (!safeName || safeName.endsWith('.uploading')) return null;
    const uuids = await getUserDeviceUuids(user);
    for (const uuid of uuids) {
        const deviceDir = path.join(UPLOAD_DIR, uuid);
        const filePath = path.join(deviceDir, safeName);
        if (!filePath.startsWith(deviceDir)) continue;
        try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return { filePath, deviceUuid: uuid };
            }
        } catch (e) {}
    }
    return null;
};

const ensurePlanRow = async (userId) => {
    const existing = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
    if (existing) return existing;
    const now = Date.now();
    await dbRunAsync(
        `INSERT INTO user_plans (user_id, status, trial_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at`,
        [userId, 'none', null, now]
    );
    return await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
};

// Self-hosted servers have no billing — every account is unlimited.
// Shape kept identical to the managed server so clients parse it unchanged.
const resolveSubscriptionState = async (userId) => {
    const row = await ensurePlanRow(userId).catch(() => null);
    return {
        allowed: true,
        status: 'self_hosted',
        expiresAt: null,
        graceUntil: null,
        deletedAt: null,
        planGb: row && row.plan_gb ? row.plan_gb : null,
        premiumGb: 0,
        paymentType: null,
    };
};

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uuid TEXT,
        storage_uuid TEXT,
        email TEXT UNIQUE,
        password TEXT,
        hardware_device_id TEXT,
        created_at INTEGER,
        email_verified INTEGER DEFAULT 0,
        last_country_code TEXT,
        verified_countries TEXT DEFAULT '[]'
    )`);

    // Migrate existing DBs: add missing columns to users
    db.all(`PRAGMA table_info(users)`, [], (err, cols) => {
        if (err) return;
        const names = Array.isArray(cols) ? cols.map(c => c && c.name).filter(Boolean) : [];
        if (!names.includes('hardware_device_id')) {
            db.run(`ALTER TABLE users ADD COLUMN hardware_device_id TEXT`, [], () => {});
        }
        if (!names.includes('created_at')) {
            db.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`, [], () => {
                const now = Date.now();
                db.run(`UPDATE users SET created_at = ? WHERE created_at IS NULL`, [now]);
            });
        } else {
            // Backfill legacy rows where created_at exists but is NULL
            const now = Date.now();
            db.run(`UPDATE users SET created_at = ? WHERE created_at IS NULL`, [now]);
        }
        // Security: email verification status
        if (!names.includes('email_verified')) {
            db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`, [], () => {});
        }
        // Security: last known country code for geo verification
        if (!names.includes('last_country_code')) {
            db.run(`ALTER TABLE users ADD COLUMN last_country_code TEXT`, [], () => {});
        }
        // Security: list of verified country codes (JSON array)
        if (!names.includes('verified_countries')) {
            db.run(`ALTER TABLE users ADD COLUMN verified_countries TEXT DEFAULT '[]'`, [], () => {});
        }
        if (!names.includes('alias_email')) {
            db.run(`ALTER TABLE users ADD COLUMN alias_email TEXT`, [], () => {});
        }
        if (!names.includes('wallet_address')) {
            db.run(`ALTER TABLE users ADD COLUMN wallet_address TEXT`, [], () => {});
        }
        if (!names.includes('storage_uuid')) {
            db.run(`ALTER TABLE users ADD COLUMN storage_uuid TEXT`, [], () => {
                db.all(`SELECT id, email FROM users WHERE storage_uuid IS NULL OR storage_uuid = ''`, [], (e2, rows) => {
                    if (e2) return;
                    (rows || []).forEach(r => {
                        const su = computeStorageUuidFromEmail(r.email);
                        if (su) db.run(`UPDATE users SET storage_uuid = ? WHERE id = ?`, [su, r.id]);
                    });
                });
            });
        } else {
            db.all(`SELECT id, email FROM users WHERE storage_uuid IS NULL OR storage_uuid = ''`, [], (e2, rows) => {
                if (e2) return;
                (rows || []).forEach(r => {
                    const su = computeStorageUuidFromEmail(r.email);
                    if (su) db.run(`UPDATE users SET storage_uuid = ? WHERE id = ?`, [su, r.id]);
                });
            });
        }
    });

    // Plan/quota bookkeeping. Self-hosted installs never bill, so this only
    // records optional plan metadata sent by clients.
    db.run(`CREATE TABLE IF NOT EXISTS user_plans (
        user_id INTEGER PRIMARY KEY,
        plan_gb INTEGER,
        premium_gb INTEGER,
        rc_app_user_id TEXT,
        rc_product_id TEXT,
        rc_entitlement TEXT,
        status TEXT,
        expires_at INTEGER,
        grace_until INTEGER,
        trial_until INTEGER,
        deleted_at INTEGER,
        payment_type TEXT,
        payment_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Migrate existing DBs: add missing columns to user_plans
    db.all(`PRAGMA table_info(user_plans)`, [], (err, cols) => {
        if (err) return;
        const names = Array.isArray(cols) ? cols.map(c => c && c.name).filter(Boolean) : [];
        if (!names.includes('plan_gb')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN plan_gb INTEGER`, [], () => {});
        }
        if (!names.includes('premium_gb')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN premium_gb INTEGER`, [], () => {});
        }
        if (!names.includes('rc_app_user_id')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN rc_app_user_id TEXT`, [], () => {});
        }
        if (!names.includes('rc_product_id')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN rc_product_id TEXT`, [], () => {});
        }
        if (!names.includes('rc_entitlement')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN rc_entitlement TEXT`, [], () => {});
        }
        if (!names.includes('status')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN status TEXT`, [], () => {});
        }
        if (!names.includes('expires_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN expires_at INTEGER`, [], () => {});
        }
        if (!names.includes('grace_until')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN grace_until INTEGER`, [], () => {});
        }
        if (!names.includes('trial_until')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN trial_until INTEGER`, [], () => {});
        }
        if (!names.includes('deleted_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN deleted_at INTEGER`, [], () => {});
        }
        if (!names.includes('payment_type')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN payment_type TEXT`, [], () => {});
        }
        if (!names.includes('payment_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN payment_at INTEGER`, [], () => {});
        }
        if (!names.includes('updated_at')) {
            db.run(`ALTER TABLE user_plans ADD COLUMN updated_at INTEGER`, [], () => {});
        }

        db.all(`PRAGMA table_info(user_plans)`, [], (err2, cols2) => {
            if (err2) return;
            const names2 = Array.isArray(cols2) ? cols2.map(c => c && c.name).filter(Boolean) : [];
            const now = Date.now();

            if (names2.includes('status') && names2.includes('trial_until') && names2.includes('updated_at')) {
                db.run(
                    `INSERT INTO user_plans (user_id, status, trial_until, updated_at)
                     SELECT u.id, 'none', NULL, ?
                     FROM users u
                     LEFT JOIN user_plans up ON up.user_id = u.id
                     WHERE up.user_id IS NULL`,
                    [now]
                );
            } else {
                db.run(
                    `INSERT INTO user_plans (user_id)
                     SELECT u.id
                     FROM users u
                     LEFT JOIN user_plans up ON up.user_id = u.id
                     WHERE up.user_id IS NULL`
                );
            }

            if (names2.includes('status')) {
                db.run(`UPDATE user_plans SET status = 'none' WHERE status IS NULL OR TRIM(status) = ''`);
            }
            if (names2.includes('updated_at')) {
                db.run(`UPDATE user_plans SET updated_at = ? WHERE updated_at IS NULL OR updated_at = 0`, [now]);
            }
            // Fix users who paid during trial but were left with status='trial' instead of 'active'.
            // Only targets users where expires_at > trial_until (proves payment extended beyond trial).
            if (names2.includes('status') && names2.includes('payment_type') && names2.includes('expires_at')) {
                db.run(
                    `UPDATE user_plans SET status = 'active', updated_at = ?
                     WHERE status = 'trial'
                       AND payment_type IS NOT NULL
                       AND expires_at IS NOT NULL AND expires_at > ?
                       AND (trial_until IS NULL OR expires_at > trial_until)`,
                    [now, now],
                    function (err) {
                        if (!err && this.changes > 0) {
                            console.log(`[Migration] Fixed ${this.changes} user(s) stuck in 'trial' status after payment`);
                        }
                    }
                );
            }
        });
    });

    // Migrate existing DBs: add user_uuid column if missing, and populate it
    db.all(`PRAGMA table_info(users)`, [], (err, cols) => {
        if (err) return;
        const hasUserUuid = Array.isArray(cols) && cols.some(c => c && c.name === 'user_uuid');
        if (!hasUserUuid) {
            db.run(`ALTER TABLE users ADD COLUMN user_uuid TEXT`, [], () => {
                // continue even if alter fails
                db.all(`SELECT id FROM users WHERE user_uuid IS NULL OR user_uuid = ''`, [], (e2, rows) => {
                    if (e2) return;
                    (rows || []).forEach(r => {
                        const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
                        db.run(`UPDATE users SET user_uuid = ? WHERE id = ?`, [u, r.id]);
                    });
                });
            });
        } else {
            db.all(`SELECT id FROM users WHERE user_uuid IS NULL OR user_uuid = ''`, [], (e2, rows) => {
                if (e2) return;
                (rows || []).forEach(r => {
                    const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
                    db.run(`UPDATE users SET user_uuid = ? WHERE id = ?`, [u, r.id]);
                });
            });
        }
    });

    // Devices table - Binding users to specific devices
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        device_uuid TEXT,
        device_name TEXT,
        last_seen INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, device_uuid)
    )`);

    // Self-healing: Add missing last_seen column if not present (for old DB schemas)
    db.run(`ALTER TABLE devices ADD COLUMN last_seen INTEGER`, (err) => {
        // Ignore error if column already exists
    });
    
    // Files table to track metadata
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        original_name TEXT,
        mime_type TEXT,
        size INTEGER,
        file_hash TEXT,
        perceptual_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename),
        UNIQUE(user_id, file_hash)
    )`);
    
    // Add perceptual_hash column if it doesn't exist (migration for existing DBs)
    db.run(`ALTER TABLE files ADD COLUMN perceptual_hash TEXT`, (err) => {
        // Ignore error if column already exists
    });

    // Platform-specific hashes for cross-platform dedup fallback
    // When a device syncs a file, it can submit its platform's computed hash
    // Next sync from same platform can use this for fast pre-download skip
    db.run(`CREATE TABLE IF NOT EXISTS platform_hashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT,
        platform TEXT,
        perceptual_hash TEXT,
        file_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, filename, platform)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cloud_chunks (
        user_id INTEGER,
        chunk_id TEXT,
        size INTEGER,
        created_at INTEGER,
        PRIMARY KEY(user_id, chunk_id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Self-healing: Add missing created_at column if not present (for old DB restores)
    db.all(`PRAGMA table_info(cloud_chunks)`, (err, rows) => {
        if (!err && rows) {
            const hasCreatedAt = rows.some(row => row.name === 'created_at');
            if (!hasCreatedAt) {
                db.run(`ALTER TABLE cloud_chunks ADD COLUMN created_at INTEGER`);
            }
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS cloud_device_state (
        user_id INTEGER,
        device_uuid TEXT,
        state_json TEXT,
        updated_at INTEGER,
        PRIMARY KEY(user_id, device_uuid),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Linked devices table — QR pairing between app installs.
    // Links two device_uuids so their file/certificate data is merged on read.
    // Bidirectional: if A is linked to B, both see each other's data.
    db.run(`CREATE TABLE IF NOT EXISTS linked_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_uuid_a TEXT NOT NULL,
        device_uuid_b TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        label TEXT,
        UNIQUE(device_uuid_a, device_uuid_b)
    )`);
    
    // Clean up database on startup - remove entries for files that don't exist
    setTimeout(() => {
        db.all(`
            SELECT f.user_id, f.filename, d.device_uuid 
            FROM files f
            JOIN devices d ON f.user_id = d.user_id
        `, [], (err, rows) => {
            if (err) return console.error('Cleanup error:', err);
            
            let cleaned = 0;
            rows.forEach(row => {
                // Files are stored by device_uuid, not user_id
                const deviceDir = path.join(UPLOAD_DIR, row.device_uuid);
                const filePath = path.join(deviceDir, row.filename);
                
                if (!fs.existsSync(filePath)) {
                    db.run(`DELETE FROM files WHERE user_id = ? AND filename = ?`, 
                        [row.user_id, row.filename]);
                    cleaned++;
                }
            });
            
            if (cleaned > 0) {
                console.log(`Database cleanup: removed ${cleaned} orphaned entries`);
            }
        });
    }, 1000); // Wait 1 second after startup
});

// Middleware: Verify Token & Device Binding
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const deviceUuid = req.headers['x-device-uuid']; // Critical for security binding
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });

        // Strict Security: Ensure the token matches the device requesting it
        if (deviceUuid && user.device_uuid !== deviceUuid) {
            return res.status(403).json({ error: 'Device mismatch. Token not valid for this device.' });
        }

        req.user = user;

        // Cross-server token resolution: if the token's user_id doesn't exist in
        // this server's DB (e.g. StealthCloud token used against local desktop server),
        // resolve the local user by email so all downstream queries work correctly.
        if (user.email) {
            const normalizedEmail = String(user.email).toLowerCase().trim();
            db.get(`SELECT id, user_uuid, storage_uuid, email FROM users WHERE email = ? OR alias_email = ?`, [normalizedEmail, normalizedEmail], (dbErr, localUser) => {
                if (!dbErr && localUser) {
                    const merged = {
                        ...user,
                        user_uuid: localUser.user_uuid || user.user_uuid,
                        storage_uuid: localUser.storage_uuid || user.storage_uuid,
                    };
                    if (localUser.id !== user.id) {
                        merged.id = localUser.id;
                        merged._originalTokenId = user.id;
                    }
                    req.user = merged;
                } else if (!user.storage_uuid && user.email) {
                    const computed = computeStorageUuidFromEmail(user.email);
                    if (computed) req.user = { ...user, storage_uuid: computed };
                }
                next();
            });
        } else {
            next();
        }
    });
};

const getStealthCloudUserKey = (user) => {
    // Primary key = device_uuid (UUIDv5 from email:password) — matches what
    // the mobile app shows in the Info tab and is deterministic from credentials.
    // This means: same email + same password = same folder, even after DB loss.
    const deviceKey = (user && (user.device_uuid || user.deviceUuid)) ? String(user.device_uuid || user.deviceUuid) : '';
    const safeDevice = deviceKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (safeDevice) return safeDevice;

    // Fallback: HMAC-based storage_uuid (legacy, from earlier implementation)
    const storageKey = (user && (user.storage_uuid || user.storageUuid)) ? String(user.storage_uuid || user.storageUuid) : '';
    const safeStorage = storageKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (safeStorage) return safeStorage;

    const key = (user && (user.user_uuid || user.userUuid)) ? String(user.user_uuid || user.userUuid) : '';
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (safe) return safe;

    if (user && user.id) return String(user.id);

    return 'unknown';
};

const getStealthCloudAllPossibleUserKeys = (user) => {
    const keys = new Set();

    const addSafe = (v) => {
        if (v === undefined || v === null) return;
        const raw = String(v);
        if (!raw) return;
        const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (safe) keys.add(safe);
    };

    // Current key (primary)
    addSafe(getStealthCloudUserKey(user));

    // If auth middleware remapped token user_id to local DB user_id, preserve old id too.
    // This can exist after reinstall when tokens were minted against an old DB.
    if (user && user._originalTokenId !== undefined && user._originalTokenId !== null) {
        addSafe(user._originalTokenId);
    }

    // All possible legacy keys
    if (user && (user.device_uuid || user.deviceUuid)) {
        addSafe(user.device_uuid || user.deviceUuid);
    }
    if (user && (user.user_uuid || user.userUuid)) {
        addSafe(user.user_uuid || user.userUuid);
    }
    if (user && (user.storage_uuid || user.storageUuid)) {
        addSafe(user.storage_uuid || user.storageUuid);
    }
    // Numeric user id (legacy folder naming)
    if (user && user.id) {
        addSafe(user.id);
    }

    return Array.from(keys);
};

const getStealthCloudStorageKey = (user) => {
    // Delegate to getStealthCloudUserKey which already has the correct priority:
    // device_uuid (primary) → storage_uuid → user_uuid → numeric id
    return getStealthCloudUserKey(user);
};

const ensureStealthCloudUserDirs = (user) => {
    const preferredKey = getStealthCloudStorageKey(user);
    const keys = [preferredKey, ...getStealthCloudAllPossibleUserKeys(user).filter(k => k !== preferredKey)];

    const canUsePreferred = preferredKey && preferredKey !== 'unknown';
    const cloudUsersRoot = path.join(CLOUD_DIR, 'users');
    const chunksUsersRoot = CHUNKS_DIR ? path.join(CHUNKS_DIR, 'users') : null;
    try { if (!fs.existsSync(cloudUsersRoot)) fs.mkdirSync(cloudUsersRoot, { recursive: true }); } catch (e) {}
    if (chunksUsersRoot) {
        try { if (!fs.existsSync(chunksUsersRoot)) fs.mkdirSync(chunksUsersRoot, { recursive: true }); } catch (e) {}
    }

    // Prefer the stable key only if it already exists; otherwise use the first existing legacy key.
    let key = preferredKey;
    if (canUsePreferred) {
        const preferredCloud = path.join(cloudUsersRoot, preferredKey);
        const preferredChunks = chunksUsersRoot ? path.join(chunksUsersRoot, preferredKey) : null;
        const preferredExists = (() => {
            try {
                if (fs.existsSync(preferredCloud)) return true;
                if (preferredChunks && fs.existsSync(preferredChunks)) return true;
            } catch (e) {}
            return false;
        })();
        if (!preferredExists) {
            for (const k of keys) {
                if (!k || k === preferredKey) continue;
                const cloudUserDir = path.join(cloudUsersRoot, k);
                const chunksUserDir = chunksUsersRoot ? path.join(chunksUsersRoot, k) : null;
                try {
                    if (fs.existsSync(cloudUserDir) || (chunksUserDir && fs.existsSync(chunksUserDir))) {
                        key = k;
                        break;
                    }
                } catch (e) {}
            }
        }
    } else {
        for (const k of keys) {
            if (!k) continue;
            const cloudUserDir = path.join(cloudUsersRoot, k);
            const chunksUserDir = chunksUsersRoot ? path.join(chunksUsersRoot, k) : null;
            try {
                if (fs.existsSync(cloudUserDir) || (chunksUserDir && fs.existsSync(chunksUserDir))) {
                    key = k;
                    break;
                }
            } catch (e) {}
        }
    }

    const userDir = path.join(CLOUD_DIR, 'users', key);
    // Chunks go to HDD RAID10 if CHUNKS_DIR is set, otherwise same as CLOUD_DIR
    const chunksDir = CHUNKS_DIR 
        ? path.join(CHUNKS_DIR, 'users', key, 'chunks')
        : path.join(userDir, 'chunks');
    const manifestsDir = path.join(userDir, 'manifests'); // Manifests always on NVMe (CLOUD_DIR)
    // Raw files go to RAID10 alongside chunks (same storage tier as chunks)
    const rawDir = CHUNKS_DIR 
        ? path.join(CHUNKS_DIR, 'users', key, 'raw')
        : path.join(userDir, 'raw');
    const rawMetaDir = path.join(userDir, 'raw-meta'); // Metadata for raw files (thumbnails, EXIF) - on NVMe
    if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
    if (!fs.existsSync(manifestsDir)) fs.mkdirSync(manifestsDir, { recursive: true });
    if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
    if (!fs.existsSync(rawMetaDir)) fs.mkdirSync(rawMetaDir, { recursive: true });

    // Backward-compat migration: move files from old device_uuid or user_uuid folders to user_id folder
    const inlineMigrationEnabled = String(process.env.ENABLE_STEALTHCLOUD_INLINE_MIGRATION || '').toLowerCase() === 'true';
    const oldKeys = [];
    // Migration from device_uuid folders (old per-device storage)
    if (user && (user.device_uuid || user.deviceUuid)) {
        const oldDeviceUuid = String(user.device_uuid || user.deviceUuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (oldDeviceUuid) oldKeys.push(oldDeviceUuid);
    }
    // Migration from user_uuid folders
    if (user && (user.user_uuid || user.userUuid)) {
        const oldUserUuid = String(user.user_uuid || user.userUuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (oldUserUuid) oldKeys.push(oldUserUuid);
    }
    if (inlineMigrationEnabled) oldKeys
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .filter(k => k !== key)
        .forEach(oldKey => {
            // Safe migration helper: copy first, then delete source only if copy succeeded
            const safeMigrateFile = (src, dst) => {
                if (!fs.existsSync(src)) return;
                if (fs.existsSync(dst)) return; // Already migrated or exists
                try {
                    // Copy file to new location
                    fs.copyFileSync(src, dst);
                    // Verify copy succeeded before deleting source
                    if (fs.existsSync(dst)) {
                        const srcSize = fs.statSync(src).size;
                        const dstSize = fs.statSync(dst).size;
                        if (srcSize === dstSize) {
                            fs.unlinkSync(src); // Safe to delete source
                        }
                    }
                } catch (e) {
                    console.error(`[Migration] Failed to migrate ${src} -> ${dst}:`, e.message);
                    // Source file is preserved on error
                }
            };

            // Migrate from CLOUD_DIR (NVMe) - manifests and possibly chunks
            const oldDir = path.join(CLOUD_DIR, 'users', oldKey);
            if (fs.existsSync(oldDir)) {
                const oldChunksCloud = path.join(oldDir, 'chunks');
                const oldManifests = path.join(oldDir, 'manifests');
                try {
                    if (fs.existsSync(oldChunksCloud)) {
                        fs.readdirSync(oldChunksCloud).forEach(f => {
                            safeMigrateFile(path.join(oldChunksCloud, f), path.join(chunksDir, f));
                        });
                    }
                    if (fs.existsSync(oldManifests)) {
                        fs.readdirSync(oldManifests).forEach(f => {
                            safeMigrateFile(path.join(oldManifests, f), path.join(manifestsDir, f));
                        });
                    }
                } catch (e) {
                    console.error(`[Migration] Error reading old directory ${oldDir}:`, e.message);
                }
            }
            // Migrate from CHUNKS_DIR (HDD RAID) if separate from CLOUD_DIR
            if (CHUNKS_DIR) {
                const oldChunksHdd = path.join(CHUNKS_DIR, 'users', oldKey, 'chunks');
                if (fs.existsSync(oldChunksHdd)) {
                    try {
                        fs.readdirSync(oldChunksHdd).forEach(f => {
                            safeMigrateFile(path.join(oldChunksHdd, f), path.join(chunksDir, f));
                        });
                    } catch (e) {
                        console.error(`[Migration] Error reading old HDD chunks ${oldChunksHdd}:`, e.message);
                    }
                }
            }
        });

    return { userDir, chunksDir, manifestsDir, rawDir, rawMetaDir };
};

// File Storage Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use device UUID for folder name (scalable for future cloud service)
        const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
        if (!fs.existsSync(deviceDir)) {
            fs.mkdirSync(deviceDir, { recursive: true });
        }
        cb(null, deviceDir);
    },
    filename: (req, file, cb) => {
        // Use original name but sanitize or prepend timestamp to avoid collisions if needed.
        // For sync, we often want to keep the exact filename or a hash.
        // Here we assume the client sends a unique filename (e.g. UUID or timestamped name)
        cb(null, file.originalname); 
    }
});

const upload = multer({
    storage: storage,
    limits: UPLOAD_MAX_BYTES > 0 ? { fileSize: UPLOAD_MAX_BYTES } : {},
});


// --- ROUTES ---

// Root: Serve company visit card page
app.get('/', (req, res) => {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(publicIndexPath)) {
        return res.sendFile(publicIndexPath);
    }
    res.status(403).send('Access Forbidden');
});

app.get('/health', (req, res) => {
    res.status(200).json({ ok: true });
});

// PhotoLynk app health probe (connection check before login)
app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true, status: 'ok', service: 'photolynk-remote' });
});

const readCapacityJson = () => {
    try {
        if (!fs.existsSync(CAPACITY_JSON_PATH)) return null;
        const raw = fs.readFileSync(CAPACITY_JSON_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
};

const getUserPlanGb = async (userId) => {
    const row = await ensurePlanRow(userId);
    const planGb = row && row.plan_gb !== null && row.plan_gb !== undefined ? Number(row.plan_gb) : null;
    return Number.isFinite(planGb) ? planGb : null;
};

const getUserPremiumGb = async (userId) => {
    const row = await ensurePlanRow(userId);
    const premiumGb = row && row.premium_gb !== null && row.premium_gb !== undefined ? Number(row.premium_gb) : null;
    return Number.isFinite(premiumGb) && premiumGb > 0 ? premiumGb : 0;
};

const getUserUsedBytes = async (userId, userOrNull) => {
    // Get encrypted chunks size from database
    const row = await dbGetAsync(
        `SELECT COALESCE(SUM(size), 0) AS usedBytes FROM cloud_chunks WHERE user_id = ?`,
        [userId]
    );
    const encryptedBytes = row && row.usedBytes !== undefined && row.usedBytes !== null ? Number(row.usedBytes) : 0;
    
    // Get raw files size from filesystem
    let rawBytes = 0;
    // If user object not provided, look it up from database
    let user = userOrNull;
    if (!user && userId) {
        try {
            const dbUser = await dbGetAsync(`SELECT id, email, user_uuid, storage_uuid FROM users WHERE id = ?`, [userId]);
            if (dbUser) {
                // Fetch the most recent device_uuid from devices table
                const devRow = await dbGetAsync(`SELECT device_uuid FROM devices WHERE user_id = ? ORDER BY id DESC LIMIT 1`, [userId]);
                user = { ...dbUser, device_uuid: devRow ? devRow.device_uuid : null };
            }
        } catch (e) {}
    }
    if (user) {
        try {
            const { rawDir } = ensureStealthCloudUserDirs(user);
            if (fs.existsSync(rawDir)) {
                const files = fs.readdirSync(rawDir).filter(f => !f.startsWith('.'));
                for (const file of files) {
                    try {
                        const stat = fs.statSync(path.join(rawDir, file));
                        if (stat.isFile()) rawBytes += stat.size;
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
    
    const total = encryptedBytes + rawBytes;
    return Number.isFinite(total) ? total : 0;
};

const getUserQuotaBytes = async (userId) => {
    const planGb = await getUserPlanGb(userId);
    const premiumGb = await getUserPremiumGb(userId);
    const totalGb = (planGb || 0) + premiumGb;
    if (totalGb <= 0) return 0;
    const GB = 1000 * 1000 * 1000;
    const planBytes = Math.floor(totalGb * GB);
    return planBytes + USER_QUOTA_MARGIN_BYTES;
};

const getServerFreeBytes = () => {
    const payload = readCapacityJson();
    const free = payload && typeof payload.freeBytes === 'number' ? payload.freeBytes : null;
    return typeof free === 'number' && Number.isFinite(free) ? free : null;
};

const enforceUserQuotaForIncomingBytes = async ({ userId, incomingBytes }) => {
    const planGb = await getUserPlanGb(userId);
    const premiumGb = await getUserPremiumGb(userId);
    const totalGb = (planGb || 0) + premiumGb;
    const GB = 1000 * 1000 * 1000;
    const totalBytes = totalGb > 0 ? Math.floor(totalGb * GB) : 0;
    const quotaBytes = totalBytes > 0 ? (totalBytes + USER_QUOTA_MARGIN_BYTES) : 0;
    const usedBytes = await getUserUsedBytes(userId);
    const inc = typeof incomingBytes === 'number' && Number.isFinite(incomingBytes) ? incomingBytes : 0;
    const allowed = quotaBytes <= 0 ? true : (usedBytes + inc + USER_QUOTA_MARGIN_BYTES) <= quotaBytes;
    return {
        allowed,
        quotaBytes,
        usedBytes,
        remainingBytes: Math.max(0, totalBytes - usedBytes),
        marginBytes: USER_QUOTA_MARGIN_BYTES,
    };
};

app.get('/api/capacity', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

// Public well-known capacity JSON (mobile app can call this directly)
app.get('/.well-known/photolynk-capacity.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

app.get('/.well-known/photosync-capacity.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const payload = readCapacityJson();
    if (!payload) return res.status(404).json({ error: 'Capacity not available' });
    return res.json(payload);
});

app.get('/api/cloud/usage', authenticateToken, async (req, res) => {
    try {
        const planGb = await getUserPlanGb(req.user.id);
        const premiumGb = await getUserPremiumGb(req.user.id);
        const totalGb = (planGb || 0) + premiumGb;
        const GB = 1000 * 1000 * 1000;
        const totalBytes = totalGb > 0 ? Math.floor(totalGb * GB) : 0;
        const quotaBytes = totalBytes > 0 ? (totalBytes + USER_QUOTA_MARGIN_BYTES) : 0;
        const usedBytes = await getUserUsedBytes(req.user.id, req.user);
        const subscription = await resolveSubscriptionState(req.user.id);
        const serverFreeBytes = getServerFreeBytes();

        return res.json({
            planGb,
            premiumGb,
            quotaBytes,
            usedBytes,
            remainingBytes: Math.max(0, totalBytes - usedBytes),
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            subscription,
            serverFreeBytes,
        });
    } catch (e) {
        return res.status(500).json({ error: 'Usage unavailable' });
    }
});

// Register User
app.post('/api/register', authRateLimiter, async (req, res) => {
    const { email, password, plan_gb, hardware_device_id } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const normalizedEmail = String(email).toLowerCase().trim();
    const hwDeviceId = hardware_device_id ? String(hardware_device_id).trim() : null;

    const normalizedPlanGb = normalizeTierGb(plan_gb);

    try {
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const u = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
        const storageUuid = computeStorageUuidFromEmail(normalizedEmail);
        db.run(`INSERT INTO users (user_uuid, storage_uuid, email, password, hardware_device_id) VALUES (?, ?, ?, ?, ?)`, [u, storageUuid, normalizedEmail, hashedPassword, hwDeviceId], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Email already exists' });
                return res.status(500).json({ error: err.message });
            }

            const newUserId = this.lastID;
            const now = Date.now();
            const trialMs = Math.max(0, TRIAL_DAYS) * 24 * 60 * 60 * 1000;
            const trialUntil = (normalizedPlanGb && trialMs > 0) ? (now + trialMs) : null;
            const initialStatus = trialUntil ? 'trial' : 'none';
            db.run(
                `INSERT INTO user_plans (user_id, plan_gb, status, trial_until, rc_app_user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET plan_gb=COALESCE(excluded.plan_gb, plan_gb), status=excluded.status, trial_until=excluded.trial_until, rc_app_user_id=excluded.rc_app_user_id, updated_at=excluded.updated_at`,
                [newUserId, normalizedPlanGb, initialStatus, trialUntil, normalizedEmail, now]
            );

            // Generate token for auto-login after registration (same as login flow)
            const device_uuid = req.body.device_uuid || req.body.deviceUuid || u;
            const token = jwt.sign({ id: newUserId, user_uuid: u, storage_uuid: storageUuid, email: normalizedEmail, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
            db.run(`INSERT OR IGNORE INTO devices (user_id, device_uuid, device_name) VALUES (?, ?, ?)`, [newUserId, device_uuid, req.body.device_name || 'Unknown Device']);
            res.status(201).json({ message: 'User registered successfully', token, userId: newUserId });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Login & Bind Device
app.post('/api/login', authRateLimiter, async (req, res) => {
    const { email, password, device_uuid, device_name, country_verification_code } = req.body;
    if (!email || !password || !device_uuid) return res.status(400).json({ error: 'Missing credentials or device ID' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT * FROM users WHERE email = ? OR alias_email = ?`, [normalizedEmail, normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid credentials' });

        // Check email verification (if enabled)
        if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
            return res.status(403).json({ 
                error: 'Email not verified', 
                requiresEmailVerification: true,
                hint: 'Please verify your email before logging in'
            });
        }

        // Country/geo verification check
        let currentCountry = null;
        if (REQUIRE_COUNTRY_VERIFICATION) {
            const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
            currentCountry = await getCountryFromIP(clientIp);
            
            if (currentCountry && currentCountry.countryCode) {
                const verifiedCountries = JSON.parse(user.verified_countries || '[]');
                const isNewCountry = !verifiedCountries.includes(currentCountry.countryCode) && 
                                     user.last_country_code && 
                                     user.last_country_code !== currentCountry.countryCode;
                
                if (isNewCountry) {
                    const verifyKey = `country:${user.id}:${currentCountry.countryCode}`;
                    const pending = pendingVerifications.get(verifyKey);
                    
                    // Check if verification code was provided
                    if (country_verification_code) {
                        if (pending && pending.code === country_verification_code && Date.now() < pending.expiresAt) {
                            // Code is valid - add country to verified list
                            verifiedCountries.push(currentCountry.countryCode);
                            db.run(`UPDATE users SET verified_countries = ?, last_country_code = ? WHERE id = ?`,
                                [JSON.stringify(verifiedCountries), currentCountry.countryCode, user.id]);
                            pendingVerifications.delete(verifyKey);
                            console.log(`[Geo] User ${user.id} verified new country: ${currentCountry.country}`);
                        } else {
                            return res.status(403).json({
                                error: 'Invalid or expired verification code',
                                requiresCountryVerification: true,
                                newCountry: currentCountry.country,
                                newCountryCode: currentCountry.countryCode
                            });
                        }
                    } else {
                        // Generate new verification code and send email
                        const code = generateVerificationCode();
                        pendingVerifications.set(verifyKey, {
                            code,
                            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
                            country: currentCountry.country,
                            countryCode: currentCountry.countryCode
                        });
                        
                        console.log(`[Geo] New country login detected for user ${user.id}: ${currentCountry.country} (code: ${code})`);
                        // TODO: Send email with code (for now, log it)
                        // In production: await sendVerificationEmail(user.email, code, currentCountry.country);
                        
                        return res.status(403).json({
                            error: 'Login from new country detected',
                            requiresCountryVerification: true,
                            newCountry: currentCountry.country,
                            newCountryCode: currentCountry.countryCode,
                            message: `A verification code has been sent to your email. Please enter it to verify this login from ${currentCountry.country}.`
                        });
                    }
                }
            }
        }

        // Check if this device_uuid is NEW for this user (password was changed)
        let isNewDevice = false;
        try {
            const existingDevice = await dbGetAsync(
                `SELECT id FROM devices WHERE user_id = ? AND device_uuid = ?`,
                [user.id, device_uuid]
            );
            isNewDevice = !existingDevice;
        } catch (e) { /* treat as new to be safe */ isNewDevice = true; }

        // Trigger folder migration when:
        // - device_uuid is new (password change)
        // - OR current device_uuid folder doesn't exist yet
        // - OR any legacy key folder exists (numeric id / storage_uuid / user_uuid / any previous device_uuid)
        //   to prevent data splitting and to clean up leftovers.
        let needsFolderMigration = isNewDevice;
        if (device_uuid) {
            const safeKey = String(device_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
            if (safeKey) {
                const cloudUsersRoot = path.join(CLOUD_DIR, 'users');
                const chunksUsersRoot = CHUNKS_DIR ? path.join(CHUNKS_DIR, 'users') : null;
            
                const keyHasAnyDir = (k) => {
                    if (!k) return false;
                    try {
                        if (fs.existsSync(path.join(cloudUsersRoot, k))) return true;
                        if (chunksUsersRoot && fs.existsSync(path.join(chunksUsersRoot, k))) return true;
                    } catch (e) {}
                    return false;
                };

                const safeExists = keyHasAnyDir(safeKey);

                // Gather all possible legacy keys for this user (including all device_uuids)
                const legacyKeys = new Set();
                legacyKeys.add(String(user.id));
                if (user.user_uuid) legacyKeys.add(String(user.user_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128));
                if (user.storage_uuid) legacyKeys.add(String(user.storage_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128));
                try {
                    const rows = await dbAllAsync(`SELECT device_uuid FROM devices WHERE user_id = ?`, [user.id]);
                    (rows || []).forEach(r => {
                        const dv = r && r.device_uuid ? String(r.device_uuid).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) : '';
                        if (dv) legacyKeys.add(dv);
                    });
                } catch (e) {}

                let otherLegacyExists = false;
                for (const k of legacyKeys) {
                    if (!k || k === safeKey) continue;
                    if (keyHasAnyDir(k)) {
                        otherLegacyExists = true;
                        break;
                    }
                }

                if (!safeExists || otherLegacyExists) {
                    needsFolderMigration = true;
                }
            }
        }

        // Register/Update Device (update last_seen on every login)
        db.run(`INSERT INTO devices (user_id, device_uuid, device_name, last_seen) VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, device_uuid) DO UPDATE SET last_seen = ?, device_name = COALESCE(?, device_name)`, 
            [user.id, device_uuid, device_name || 'Unknown Device', Date.now(), Date.now(), device_name || null], 
            async (devErr) => {
                if (devErr) console.error('Device reg error:', devErr);

                // Migrate storage folders if device_uuid is new OR folder doesn't exist yet
                if (needsFolderMigration) {
                    try {
                        await migrateUserFoldersToNewDeviceUuid(user.id, device_uuid, normalizedEmail);
                    } catch (migErr) {
                        console.error(`[Login] Folder migration error for user ${user.id}:`, migErr.message);
                    }
                }

                const now = Date.now();
                try {
                    await ensurePlanRow(user.id);
                } catch (e) {
                    // ignore
                }
                // Backfill hardware_device_id for legacy accounts on login
                db.run(
                    `UPDATE users SET hardware_device_id = COALESCE(hardware_device_id, ?) WHERE id = ?`,
                    [device_uuid, user.id]
                );
                db.run(
                    `UPDATE user_plans SET rc_app_user_id = ?, updated_at = ? WHERE user_id = ?`,
                    [normalizedEmail, now, user.id]
                );
                
                // Update last known country
                if (currentCountry && currentCountry.countryCode) {
                    const verifiedCountries = JSON.parse(user.verified_countries || '[]');
                    if (!verifiedCountries.includes(currentCountry.countryCode)) {
                        verifiedCountries.push(currentCountry.countryCode);
                    }
                    db.run(`UPDATE users SET last_country_code = ?, verified_countries = ? WHERE id = ?`,
                        [currentCountry.countryCode, JSON.stringify(verifiedCountries), user.id]);
                }
                
                // Generate Token BOUND to this device
                const storageUuid = user.storage_uuid || computeStorageUuidFromEmail(user.email);
                if (storageUuid && !user.storage_uuid) {
                    db.run(`UPDATE users SET storage_uuid = COALESCE(storage_uuid, ?) WHERE id = ?`, [storageUuid, user.id]);
                }
                const token = jwt.sign({ id: user.id, user_uuid: user.user_uuid, storage_uuid: storageUuid, email: user.email, device_uuid: device_uuid }, JWT_SECRET, { expiresIn: '30d' });
                res.json({ token, userId: user.id });
            }
        );
    });
});

// ============================================================================
// EMAIL VERIFICATION ENDPOINTS (inactive by default, ready to enable)
// ============================================================================

// Request email verification code
// POST /api/auth/request-email-verification
app.post('/api/auth/request-email-verification', authRateLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email, email_verified FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });
        
        if (user.email_verified) {
            return res.json({ message: 'Email already verified', alreadyVerified: true });
        }

        const code = generateVerificationCode();
        const verifyKey = `email:${user.id}`;
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
            email: normalizedEmail
        });

        console.log(`[Email] Verification code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendVerificationEmail(normalizedEmail, code);

        res.json({ message: 'Verification code sent to your email', codeSent: true });
    });
});

// Verify email with code
// POST /api/auth/verify-email
app.post('/api/auth/verify-email', authRateLimiter, async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email, email_verified FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        if (user.email_verified) {
            return res.json({ message: 'Email already verified', success: true });
        }

        const verifyKey = `email:${user.id}`;
        const pending = pendingVerifications.get(verifyKey);

        if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        // Mark email as verified
        db.run(`UPDATE users SET email_verified = 1 WHERE id = ?`, [user.id], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: 'Failed to verify email' });
            
            pendingVerifications.delete(verifyKey);
            console.log(`[Email] User ${user.id} email verified: ${normalizedEmail}`);
            res.json({ message: 'Email verified successfully', success: true });
        });
    });
});

// ============================================================================
// COUNTRY VERIFICATION ENDPOINT
// ============================================================================

// Resend country verification code
// POST /api/auth/resend-country-code
app.post('/api/auth/resend-country-code', authRateLimiter, async (req, res) => {
    const { email, countryCode } = req.body;
    if (!email || !countryCode) return res.status(400).json({ error: 'Email and country code required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        const verifyKey = `country:${user.id}:${countryCode}`;
        const code = generateVerificationCode();
        
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000,
            countryCode
        });

        console.log(`[Geo] Resent country verification code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendVerificationEmail(normalizedEmail, code, countryCode);

        res.json({ message: 'Verification code resent', codeSent: true });
    });
});

// ============================================================================
// PASSWORD RESET
// ============================================================================

// Email-based Password Reset - Step 1: Request reset code
// POST /api/auth/request-password-reset
// Works for all server types (local/remote/stealthcloud)
app.post('/api/auth/request-password-reset', authRateLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        
        // Always return success to prevent email enumeration attacks
        if (!user) {
            console.log(`[Password Reset] Request for non-existent email: ${normalizedEmail}`);
            return res.json({ message: 'If an account exists with this email, a reset code has been sent', codeSent: true });
        }

        const code = generateVerificationCode();
        const verifyKey = `pwreset:${user.id}`;
        pendingVerifications.set(verifyKey, {
            code,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
            email: normalizedEmail
        });

        console.log(`[Password Reset] Code for ${normalizedEmail}: ${code}`);
        // TODO: Send email with code
        // In production: await sendPasswordResetEmail(normalizedEmail, code);

        res.json({ message: 'If an account exists with this email, a reset code has been sent', codeSent: true });
    });
});

// Email-based Password Reset - Step 2: Verify code and reset password
// POST /api/auth/reset-password-with-code
app.post('/api/auth/reset-password-with-code', authRateLimiter, async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
        return res.status(400).json({ error: 'Email, code, and new password required' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    db.get(`SELECT id, email FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        const verifyKey = `pwreset:${user.id}`;
        const pending = pendingVerifications.get(verifyKey);

        if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }

        try {
            const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashedPassword, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

                pendingVerifications.delete(verifyKey);
                console.log(`[Password Reset] Password updated for ${normalizedEmail} via email code`);
                res.json({ message: 'Password has been reset successfully', success: true });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// Device-bound Password Reset (legacy - still works)
// Allows password reset if the hardware_device_id matches the one stored during account creation
// This survives app reinstalls because it uses a persistent hardware identifier
app.post('/api/reset-password-device', authRateLimiter, async (req, res) => {
    const { email, hardware_device_id, newPassword } = req.body;
    if (!email || !hardware_device_id || !newPassword) {
        return res.status(400).json({ error: 'Email, device ID, and new password are required' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const hwDeviceId = String(hardware_device_id).trim();

    // Find user by email and check hardware_device_id
    db.get(`SELECT id, email, hardware_device_id FROM users WHERE email = ?`, [normalizedEmail], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'Account not found' });

        // Check if hardware_device_id was stored during registration
        if (!user.hardware_device_id) {
            return res.status(403).json({ 
                error: 'Password reset is not available for this account. The account was created before device-bound reset was enabled.',
                hint: 'no_hardware_id_stored'
            });
        }

        // Compare hardware device IDs
        if (user.hardware_device_id !== hwDeviceId) {
            return res.status(403).json({ 
                error: 'Password reset is only allowed from the device that created this account',
                hint: 'device_mismatch'
            });
        }

        // Device matches - allow password reset
        try {
            const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashedPassword, user.id], function(updateErr) {
                if (updateErr) return res.status(500).json({ error: 'Failed to update password' });

                console.log(`[PASSWORD RESET] Password updated for ${normalizedEmail} via hardware device-bound reset`);
                res.json({ message: 'Password has been reset successfully' });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// Migrate credentials: update email+password on existing account (same user_id).
// Used by credential migration to switch between auth identities
// credentials while preserving all server data (cloud_chunks, user_plans, devices).
app.post('/api/migrate-credentials', authenticateToken, async (req, res) => {
    try {
        const { new_email, new_password, device_uuid } = req.body || {};
        if (!new_email || !new_password) {
            return res.status(400).json({ error: 'new_email and new_password required' });
        }

        const normalizedNewEmail = String(new_email).toLowerCase().trim();
        const userId = req.user.id;

        // Check if new email is already taken by a DIFFERENT user
        const existing = await dbGetAsync(`SELECT id FROM users WHERE email = ? AND id != ?`, [normalizedNewEmail, userId]);
        if (existing) {
            return res.status(409).json({ error: 'Email already in use by another account' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
        const newStorageUuid = computeStorageUuidFromEmail(normalizedNewEmail);

        // Store the old email as alias so the user can still login with legacy credentials
        const currentUser = await dbGetAsync(`SELECT email FROM users WHERE id = ?`, [userId]);
        const aliasEmail = currentUser ? currentUser.email : null;

        // Update user record in-place (same user_id!)
        await dbRunAsync(
            `UPDATE users SET email = ?, password = ?, storage_uuid = COALESCE(?, storage_uuid), alias_email = COALESCE(alias_email, ?) WHERE id = ?`,
            [normalizedNewEmail, hashedPassword, newStorageUuid, aliasEmail, userId]
        );

        // Update device_uuid in devices table if provided
        const effectiveDeviceUuid = device_uuid || req.user.device_uuid;
        if (effectiveDeviceUuid) {
            // Insert or update device record
            db.run(
                `INSERT INTO devices (user_id, device_uuid, device_name, last_seen)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, device_uuid) DO UPDATE SET last_seen = ?`,
                [userId, effectiveDeviceUuid, (req.body.device_name || 'mobile'), Date.now(), Date.now()]
            );
        }

        // Issue new JWT with updated identity
        const storageUuid = newStorageUuid || req.user.storage_uuid;
        const token = jwt.sign(
            { id: userId, user_uuid: req.user.user_uuid, storage_uuid: storageUuid, email: normalizedNewEmail, device_uuid: effectiveDeviceUuid },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(`[Migrate] User ${userId} credentials migrated: ${req.user.email} → ${normalizedNewEmail}`);
        res.json({ token, userId, message: 'Credentials migrated successfully' });
    } catch (e) {
        console.error('[Migrate] Error:', e.message);
        res.status(500).json({ error: e.message || 'Migration failed' });
    }
});

// Upload File
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { filename, path: filePath, originalname, mimetype, size } = req.file;

    // Stream the file for hashing — never buffer a multi-GB upload in memory
    const fileHash = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('data', (c) => h.update(c))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    }).catch(() => null);
    if (!fileHash) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        return res.status(500).json({ error: 'Failed to read uploaded file' });
    }

    // Check if this exact file already exists for this user (by hash only - same content = duplicate)
    db.get(`SELECT filename, file_hash FROM files WHERE user_id = ? AND file_hash = ?`, 
        [req.user.id, fileHash], 
        (err, row) => {
            if (row) {
                // Check if the file actually exists on disk
                const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
                const existingFilePath = path.join(deviceDir, row.filename);
                
                if (fs.existsSync(existingFilePath)) {
                    // Duplicate file exists - delete the uploaded file and return existing filename
                    fs.unlinkSync(filePath);
                    console.log(`Duplicate file detected: ${originalname} (matches ${row.filename})`);
                    return res.json({ message: 'File already exists (duplicate)', filename: row.filename, duplicate: true });
                } else {
                    // File in DB but not on disk - remove from DB and continue with upload
                    console.log(`File ${row.filename} in DB but missing from disk - cleaning up DB`);
                    db.run(`DELETE FROM files WHERE user_id = ? AND file_hash = ?`, [req.user.id, fileHash]);
                    // Continue to save the new file below
                }
            }
            
            // Not a duplicate - save to DB
            db.run(`INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash) VALUES (?, ?, ?, ?, ?, ?)`,
                [req.user.id, originalname, originalname, mimetype, size, fileHash],
                (err) => {
                    if (err) {
                        console.error('Metadata save error:', err);
                        // If DB save fails, try to clean up the file
                        fs.unlinkSync(filePath);
                        return res.status(500).json({ error: 'Failed to save file metadata' });
                    }
                    res.json({ message: 'File uploaded', filename: originalname });
                }
            );
        }
    );
});

// Raw Upload File (no multipart)
app.post('/api/upload/raw', authenticateToken, (req, res) => {
    const originalname = (req.headers['x-filename'] || req.headers['x-file-name'] || '').toString();
    if (!originalname) return res.status(400).json({ error: 'Missing x-filename header' });

    // Optional disk-fill guard (UPLOAD_MAX_BYTES). Reject up front when the
    // client declares a Content-Length, and abort mid-stream if it exceeds.
    if (UPLOAD_MAX_BYTES > 0) {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > UPLOAD_MAX_BYTES) {
            return res.status(413).json({ error: 'File too large' });
        }
    }

    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    try { fs.mkdirSync(deviceDir, { recursive: true }); } catch (e) {}

    const safeName = path.basename(originalname);
    const tmpName = `${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}.uploading`;
    const tmpPath = path.join(deviceDir, tmpName);
    const finalPath = path.join(deviceDir, safeName);

    // Clean up ALL stale .uploading files in device directory (from previous failed/aborted uploads)
    try {
        const entries = fs.readdirSync(deviceDir);
        for (const entry of entries) {
            if (entry.endsWith('.uploading')) {
                const entryPath = path.join(deviceDir, entry);
                try {
                    // Only clean up files older than 30 seconds (avoid deleting active uploads)
                    const stat = fs.statSync(entryPath);
                    if (Date.now() - stat.mtimeMs > 30000) {
                        fs.unlinkSync(entryPath);
                        console.log(`[Upload] Cleaned up stale temp file: ${entry}`);
                    }
                } catch (e) {
                    // Ignore - file might be locked by another upload in progress
                }
            }
        }
    } catch (e) {
        // Ignore directory read errors
    }

    const hasher = crypto.createHash('sha256');
    let writtenBytes = 0;

    const out = fs.createWriteStream(tmpPath);
    let streamClosed = false;
    
    // Properly close stream and wait for file handle release before cleanup
    const closeStreamAndCleanup = () => {
        if (streamClosed) return;
        streamClosed = true;
        
        const doDelete = () => {
            try {
                if (fs.existsSync(tmpPath)) {
                    fs.unlinkSync(tmpPath);
                    console.log(`[Upload] Cleaned up temp file: ${path.basename(tmpPath)}`);
                }
            } catch (e) {
                // File still locked, schedule retry
                setTimeout(doDelete, 500);
            }
        };
        
        try {
            if (!out.destroyed) {
                out.end(() => {
                    // Wait for 'close' event which indicates file handle is released
                    out.once('close', () => setTimeout(doDelete, 100));
                    // Fallback if close doesn't fire
                    setTimeout(doDelete, 1000);
                });
            } else {
                setTimeout(doDelete, 500);
            }
        } catch (e) {
            setTimeout(doDelete, 500);
        }
    };

    req.on('aborted', () => {
        console.log(`[Upload] Request aborted for ${safeName}`);
        closeStreamAndCleanup();
    });

    req.on('error', (e) => {
        console.log(`[Upload] Request error for ${safeName}: ${e.message}`);
        closeStreamAndCleanup();
    });

    out.on('error', (e) => {
        console.error(`[Upload] Write stream error for ${safeName}: ${e.message}`);
        closeStreamAndCleanup();
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to write upload' });
    });

    let sizeLimitHit = false;
    req.on('data', (chunk) => {
        try {
            writtenBytes += chunk.length;
            hasher.update(chunk);
            if (UPLOAD_MAX_BYTES > 0 && writtenBytes > UPLOAD_MAX_BYTES && !sizeLimitHit) {
                sizeLimitHit = true;
                console.log(`[Upload] Size cap hit for ${safeName} (${writtenBytes} > ${UPLOAD_MAX_BYTES})`);
                try { req.unpipe(out); } catch (e) {}
                try { req.destroy(); } catch (e) {}
                try { out.destroy(); } catch (e) {}
                closeStreamAndCleanup();
                return res.status(413).json({ error: 'File too large' });
            }
        } catch (e) {
            // ignore
        }
    });

    out.on('finish', async () => {
        if (sizeLimitHit) return; // 413 already sent — don't finalize
        const cleanupTmp = (delayMs) => {
            const doClean = () => {
                try {
                    if (fs.existsSync(tmpPath)) {
                        fs.unlinkSync(tmpPath);
                        console.log(`[Upload] Cleaned up temp file: ${path.basename(tmpPath)}`);
                    }
                } catch (e) {
                    // Retry once after 500ms if file is still locked
                    setTimeout(() => {
                        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) {}
                    }, 500);
                }
            };
            if (delayMs) setTimeout(doClean, delayMs);
            else doClean();
        };

        const fileHash = hasher.digest('hex');
        const mimetype = (req.headers['content-type'] || 'application/octet-stream').toString();
        const size = writtenBytes;
        
        // Detect real file format from magic bytes and fix extension if mismatched
        // Android sometimes reports screenshots as .jpg when they're actually PNG
        let correctedSafeName = safeName;
        try {
            const fd = fs.openSync(tmpPath, 'r');
            const magicBuf = Buffer.alloc(12);
            fs.readSync(fd, magicBuf, 0, 12, 0);
            fs.closeSync(fd);
            
            const ext = safeName.split('.').pop()?.toLowerCase();
            const isPNG = magicBuf[0] === 0x89 && magicBuf[1] === 0x50 && magicBuf[2] === 0x4E && magicBuf[3] === 0x47;
            const isJPEG = magicBuf[0] === 0xFF && magicBuf[1] === 0xD8 && magicBuf[2] === 0xFF;
            
            if (isPNG && ext !== 'png') {
                correctedSafeName = safeName.replace(/\.[^.]+$/, '.png');
                console.log(`[Format] Corrected ${safeName} -> ${correctedSafeName} (PNG magic bytes)`);
            } else if (isJPEG && ext !== 'jpg' && ext !== 'jpeg') {
                correctedSafeName = safeName.replace(/\.[^.]+$/, '.jpg');
                console.log(`[Format] Corrected ${safeName} -> ${correctedSafeName} (JPEG magic bytes)`);
            }
        } catch (e) {
            // If detection fails, use original name
        }
        
        const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|psd|psb|exr|hdr|avif)$/i.test(correctedSafeName);

        // Get client's perceptual hash from header (for HEIC files where sharp fails)
        const clientPerceptualHash = (req.headers['x-perceptual-hash'] || '').toString().trim();

        // Compute perceptual hash BEFORE dedup check (for images)
        // Use client's hash as fallback if server can't compute (HEIC on macOS)
        let perceptualHash = null;
        if (isImage) {
            try {
                perceptualHash = await computePerceptualHash(tmpPath);
            } catch (e) {
                console.log('computePerceptualHash error:', e.message);
            }
            // Use client's hash if server failed (critical for HEIC)
            if (!perceptualHash && clientPerceptualHash && clientPerceptualHash.length === 16) {
                perceptualHash = clientPerceptualHash;
                console.log(`[Dedup] Using client perceptual hash for ${safeName}: ${perceptualHash}`);
            }
        }

        // Hamming distance for perceptual hash fuzzy matching
        const hammingDistance64 = (a, b) => {
            if (!a || !b || a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
            let dist = 0;
            for (let i = 0; i < 16; i += 8) {
                const valA = parseInt(a.substring(i, i + 8), 16);
                const valB = parseInt(b.substring(i, i + 8), 16);
                let x = valA ^ valB;
                while (x) { dist += x & 1; x >>>= 1; }
            }
            return dist;
        };
        const DHASH_THRESHOLD = 0;

        // Check file_hash dedup
        const checkFileHash = () => new Promise((resolve, reject) => {
            db.get(
                `SELECT filename, file_hash FROM files WHERE user_id = ? AND file_hash = ?`,
                [req.user.id, fileHash],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });

        // Check perceptual_hash dedup (fuzzy matching with threshold)
        const checkPerceptualHash = () => new Promise((resolve, reject) => {
            if (!perceptualHash) return resolve(null);
            db.all(
                `SELECT filename, perceptual_hash, size FROM files WHERE user_id = ? AND perceptual_hash IS NOT NULL`,
                [req.user.id],
                (err, rows) => {
                    if (err) return reject(err);
                    for (const row of rows || []) {
                        if (row.perceptual_hash && row.perceptual_hash.length === 16) {
                            const dist = hammingDistance64(perceptualHash, row.perceptual_hash);
                            if (dist <= DHASH_THRESHOLD) {
                                // Extra guard against false positives: require near-identical byte size
                                // when using perceptual-hash dedup.
                                const rowSize = typeof row.size === 'number' ? row.size : null;
                                if (rowSize !== null && typeof size === 'number' && size > 0) {
                                    const tol = Math.max(4096, Math.round(size * 0.002));
                                    if (Math.abs(rowSize - size) > tol) {
                                        continue;
                                    }
                                }
                                return resolve({ ...row, distance: dist });
                            }
                        }
                    }
                    resolve(null);
                }
            );
        });

        try {
            // Check file hash first (exact match)
            const fileHashMatch = await checkFileHash();
            if (fileHashMatch) {
                const existingFilePath = path.join(deviceDir, fileHashMatch.filename);
                if (fs.existsSync(existingFilePath)) {
                    cleanupTmp(200);
                    console.log(`Duplicate raw upload detected: ${safeName} (fileHash matches ${fileHashMatch.filename})`);
                    return res.json({ message: 'File already exists (duplicate)', filename: fileHashMatch.filename, duplicate: true });
                }
                console.log(`File ${fileHashMatch.filename} in DB but missing from disk - cleaning up DB`);
                db.run(`DELETE FROM files WHERE user_id = ? AND file_hash = ?`, [req.user.id, fileHash]);
            }

            // Check perceptual hash (fuzzy match for images)
            const phashMatch = await checkPerceptualHash();
            if (phashMatch) {
                const existingFilePath = path.join(deviceDir, phashMatch.filename);
                if (fs.existsSync(existingFilePath)) {
                    cleanupTmp(200);
                    console.log(`Duplicate raw upload detected: ${safeName} (perceptualHash matches ${phashMatch.filename}, dist=${phashMatch.distance})`);
                    return res.json({ message: 'File already exists (duplicate)', filename: phashMatch.filename, duplicate: true });
                }
            }

            // No duplicate - finalize upload with corrected filename
            const correctedFinalPath = path.join(deviceDir, correctedSafeName);
            try {
                if (fs.existsSync(correctedFinalPath)) {
                    fs.unlinkSync(correctedFinalPath);
                }
            } catch (e) {}

            try {
                fs.renameSync(tmpPath, correctedFinalPath);
                try { fs.chmodSync(correctedFinalPath, 0o600); } catch (e) {}
            } catch (e) {
                console.error(`[Upload] Failed to rename ${tmpPath} -> ${correctedFinalPath}: ${e.message}`);
                cleanupTmp(200);
                return res.status(500).json({ error: 'Failed to finalize upload' });
            }

            // Save to DB with corrected filename
            db.run(
                `INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash, perceptual_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [req.user.id, correctedSafeName, safeName, mimetype, size, fileHash, perceptualHash],
                (err2) => {
                    if (err2) {
                        console.error('Metadata save error:', err2);
                        try { fs.unlinkSync(correctedFinalPath); } catch (e) {}
                        return res.status(500).json({ error: 'Failed to save file metadata' });
                    }
                    return res.json({ message: 'File uploaded', filename: correctedSafeName, fileHash, perceptualHash });
                }
            );
        } catch (err) {
            cleanupTmp();
            console.error('Dedup check error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
    });

    req.pipe(out);
});

// List Files (for Sync) - includes hash metadata for cross-device dedup
app.get('/api/files', authenticateToken, async (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const includeMeta = req.query && req.query.meta === 'true';
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    try {
        const deviceUuids = await getUserDeviceUuids(req.user);
        const byName = new Map();
        for (const uuid of deviceUuids) {
            const deviceDir = path.join(UPLOAD_DIR, uuid);
            if (!fs.existsSync(deviceDir)) continue;
            let dirItems = [];
            try {
                dirItems = fs.readdirSync(deviceDir);
            } catch (e) {
                continue;
            }
            for (const filename of dirItems) {
                if (!filename || filename.startsWith('.') || filename.endsWith('.uploading')) continue;
                const filePath = path.join(deviceDir, filename);
                if (!filePath.startsWith(deviceDir)) continue;
                try {
                    const st = fs.statSync(filePath);
                    if (!st.isFile()) continue;
                    const existing = byName.get(filename);
                    const next = { filename, size: st.size, created_at: st.mtime };
                    if (!existing || (existing.created_at && next.created_at && next.created_at > existing.created_at)) {
                        byName.set(filename, next);
                    }
                } catch (e) {}
            }
        }

        let files = Array.from(byName.values());

        files.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
        const total = files.length;
        if (limit > 0) {
            files = files.slice(offset, offset + limit);
        }
        
        // If meta=true, enrich with hash metadata from database
        if (includeMeta && files.length > 0) {
            const filenames = files.map(f => f.filename);
            const placeholders = filenames.map(() => '?').join(',');
            
            // Get primary hashes from files table
            db.all(
                `SELECT filename, file_hash, perceptual_hash, size FROM files WHERE user_id = ? AND filename IN (${placeholders})`,
                [req.user.id, ...filenames],
                (err, rows) => {
                    if (err) {
                        console.error('[LIST FILES] DB error:', err);
                        return res.json({ files, total });
                    }
                    
                    // Create lookup map for primary hashes
                    const hashMap = {};
                    for (const row of (rows || [])) {
                        hashMap[row.filename] = {
                            fileHash: row.file_hash,
                            perceptualHash: row.perceptual_hash
                        };
                    }
                    
                    // Get platform-specific hashes (fallback for cross-platform dedup)
                    db.all(
                        `SELECT filename, platform, perceptual_hash, file_hash FROM platform_hashes WHERE user_id = ? AND filename IN (${placeholders})`,
                        [req.user.id, ...filenames],
                        (err2, platformRows) => {
                            // Build platform hash lookup: { filename: { ios: {...}, android: {...} } }
                            const platformHashMap = {};
                            for (const row of (platformRows || [])) {
                                if (!platformHashMap[row.filename]) {
                                    platformHashMap[row.filename] = {};
                                }
                                platformHashMap[row.filename][row.platform] = {
                                    perceptualHash: row.perceptual_hash,
                                    fileHash: row.file_hash
                                };
                            }
                            
                            // Enrich files with hash metadata
                            for (const file of files) {
                                const meta = hashMap[file.filename];
                                if (meta) {
                                    file.fileHash = meta.fileHash;
                                    file.perceptualHash = meta.perceptualHash;
                                }
                                // Add platform-specific hashes as fallback
                                const platformMeta = platformHashMap[file.filename];
                                if (platformMeta) {
                                    file.platformHashes = platformMeta;
                                }
                            }
                            
                            console.log(`[LIST FILES] Returning ${files.length} files with meta (offset=${offset} limit=${limit || 'all'} total=${total})`);
                            res.json({ files, total });
                        }
                    );
                }
            );
        } else {
            console.log(`[LIST FILES] Returning ${files.length} files (offset=${offset} limit=${limit || 'all'} total=${total})`);
            res.json({ files, total });
        }
    } catch (error) {
        console.error('[LIST FILES] Error reading files:', error);
        res.status(500).json({ error: 'Error reading files' });
    }
});

// Migrate existing files to compute missing hashes
app.post('/api/files/migrate-hashes', authenticateToken, async (req, res) => {
    const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid);
    if (!fs.existsSync(deviceDir)) {
        return res.json({ migrated: 0, message: 'No files to migrate' });
    }

    try {
        // Get files without perceptual_hash
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, filename, file_hash FROM files WHERE user_id = ? AND (perceptual_hash IS NULL OR perceptual_hash = '')`,
                [req.user.id],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });

        console.log(`[MIGRATE] Found ${rows.length} files without perceptual_hash`);
        let migrated = 0;
        let errors = 0;

        for (const row of rows) {
            const filePath = path.join(deviceDir, row.filename);
            if (!fs.existsSync(filePath)) {
                errors++;
                continue;
            }

            const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|heic|heif|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|psd|psb|exr|hdr|avif)$/i.test(row.filename);
            if (!isImage) continue; // Only images need perceptual hash

            try {
                const phash = await computePerceptualHash(filePath);
                if (phash) {
                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE files SET perceptual_hash = ? WHERE id = ?`,
                            [phash, row.id],
                            (err) => err ? reject(err) : resolve()
                        );
                    });
                    migrated++;
                    console.log(`[MIGRATE] ${row.filename}: ${phash}`);
                }
            } catch (e) {
                errors++;
                console.log(`[MIGRATE] Error for ${row.filename}: ${e.message}`);
            }
        }

        console.log(`[MIGRATE] Complete: ${migrated} migrated, ${errors} errors`);
        res.json({ migrated, errors, total: rows.length });
    } catch (e) {
        console.error('[MIGRATE] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Submit platform-specific hash for a file (for cross-platform dedup fallback)
// Called by clients after syncing a file to store their platform's computed hash
app.post('/api/files/platform-hash', authenticateToken, (req, res) => {
    const { filename, platform, perceptualHash, fileHash } = req.body || {};
    
    if (!filename || !platform) {
        return res.status(400).json({ error: 'filename and platform required' });
    }
    
    if (!perceptualHash && !fileHash) {
        return res.status(400).json({ error: 'perceptualHash or fileHash required' });
    }
    
    // Validate platform
    const validPlatforms = ['ios', 'android'];
    if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform. Must be ios or android' });
    }
    
    db.run(
        `INSERT OR REPLACE INTO platform_hashes (user_id, filename, platform, perceptual_hash, file_hash) VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, filename, platform, perceptualHash || null, fileHash || null],
        (err) => {
            if (err) {
                console.error('[PLATFORM-HASH] Error:', err);
                return res.status(500).json({ error: 'Failed to save platform hash' });
            }
            res.json({ success: true, filename, platform });
        }
    );
});

// Batch submit platform hashes (more efficient for sync)
app.post('/api/files/platform-hashes', authenticateToken, (req, res) => {
    const { platform, hashes } = req.body || {};
    
    if (!platform || !Array.isArray(hashes) || hashes.length === 0) {
        return res.status(400).json({ error: 'platform and hashes array required' });
    }
    
    const validPlatforms = ['ios', 'android'];
    if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }
    
    let saved = 0;
    let errors = 0;
    
    const stmt = db.prepare(`INSERT OR REPLACE INTO platform_hashes (user_id, filename, platform, perceptual_hash, file_hash) VALUES (?, ?, ?, ?, ?)`);
    
    for (const h of hashes) {
        if (h.filename && (h.perceptualHash || h.fileHash)) {
            stmt.run([req.user.id, h.filename, platform, h.perceptualHash || null, h.fileHash || null], (err) => {
                if (err) errors++;
                else saved++;
            });
        }
    }
    
    stmt.finalize((err) => {
        if (err) {
            console.error('[PLATFORM-HASHES] Finalize error:', err);
        }
        console.log(`[PLATFORM-HASHES] Saved ${saved} hashes for ${platform}, ${errors} errors`);
        res.json({ saved, errors, total: hashes.length });
    });
});

// Register synced file metadata (called by desktop sync after downloading from StealthCloud)
// This enables mobile sync to get fileHash for EXIF lookup
app.post('/api/files/register', authenticateToken, (req, res) => {
    const { filename, fileHash, perceptualHash, size, mimeType } = req.body || {};
    
    if (!filename) {
        return res.status(400).json({ error: 'filename required' });
    }
    
    console.log(`[REGISTER] Registering file: ${filename}, hash: ${fileHash?.substring(0, 16)}...`);
    
    db.run(
        `INSERT OR REPLACE INTO files (user_id, filename, original_name, mime_type, size, file_hash, perceptual_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, filename, filename, mimeType || 'application/octet-stream', size || 0, fileHash || null, perceptualHash || null],
        (err) => {
            if (err) {
                console.error('[REGISTER] DB error:', err);
                return res.status(500).json({ error: 'Failed to register file' });
            }
            res.json({ success: true, filename, fileHash });
        }
    );
});

// Purge classic uploads (non-StealthCloud) for this device
app.post('/api/files/purge', authenticateToken, async (req, res) => {
    try {
        const deviceUuids = await getUserDeviceUuids(req.user);
        const deviceDirs = (Array.isArray(deviceUuids) ? deviceUuids : [])
            .filter(Boolean)
            .map(uuid => ({ uuid: String(uuid), dir: path.join(UPLOAD_DIR, String(uuid)) }));

        console.log(`[Purge-Classic] UPLOAD_DIR: ${UPLOAD_DIR}`);
        console.log(`[Purge-Classic] user.id: ${req.user && req.user.id}`);
        console.log(`[Purge-Classic] device_uuids: ${JSON.stringify(deviceUuids || [])}`);

        const countFiles = (dir) => {
            try {
                if (!fs.existsSync(dir)) return 0;
                return fs.readdirSync(dir)
                    .filter(f => f && !f.startsWith('.'))
                    .filter(f => {
                        try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; }
                    }).length;
            } catch (e) {
                return 0;
            }
        };

        const filesBefore = deviceDirs.reduce((sum, d) => sum + countFiles(d.dir), 0);

        // Collect fileHashes from database before deleting (for EXIF cleanup)
        const fileHashes = [];
        try {
            const rows = await new Promise((resolve, reject) => {
                db.all(`SELECT file_hash FROM files WHERE user_id = ? AND file_hash IS NOT NULL`, [req.user.id], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
            for (const row of rows) {
                if (row.file_hash) fileHashes.push(row.file_hash);
            }
        } catch (e) {}

        let filesDeleted = 0;
        let stubbornFiles = [];

        for (const d of deviceDirs) {
            const deviceDir = d.dir;
            if (!fs.existsSync(deviceDir)) {
                console.log(`[Purge-Classic] deviceDir does not exist: ${deviceDir}`);
                continue;
            }

            const entries = fs.readdirSync(deviceDir);
            console.log(`[Purge-Classic] Found ${entries.length} entries to delete in ${d.uuid}`);

            for (const entry of entries) {
                const entryPath = path.join(deviceDir, entry);
                try {
                    if (!fs.existsSync(entryPath)) continue;
                    const stat = fs.statSync(entryPath);
                    if (stat.isFile()) {
                        try { fs.chmodSync(entryPath, 0o666); } catch (e) {}
                        fs.unlinkSync(entryPath);
                        filesDeleted++;
                    } else if (stat.isDirectory()) {
                        fs.rmSync(entryPath, { recursive: true, force: true });
                    }
                } catch (e) {
                    stubbornFiles.push(entryPath);
                }
            }
        }

        // Schedule background cleanup for stubborn files (Windows file locks)
        if (stubbornFiles.length > 0) {
            console.log(`[Purge-Classic] ${stubbornFiles.length} stubborn files, scheduling background cleanup`);
            setTimeout(async () => {
                for (const filePath of stubbornFiles) {
                    for (let attempt = 0; attempt < 20; attempt++) {
                        try {
                            if (!fs.existsSync(filePath)) break;
                            try { fs.chmodSync(filePath, 0o666); } catch (e) {}
                            fs.unlinkSync(filePath);
                            console.log(`[Purge-BG] Deleted stubborn file: ${path.basename(filePath)}`);
                            break;
                        } catch (e) {
                            if (attempt < 19) await new Promise(r => setTimeout(r, 500));
                        }
                    }
                }
            }, 1000);
        }
        
        console.log(`[Purge-Classic] Deleted ${filesDeleted} files, ${stubbornFiles.length} deferred to background`)
        
        // Ensure device directories exist after cleanup
        for (const d of deviceDirs) {
            try { fs.mkdirSync(d.dir, { recursive: true }); } catch (e) {}
        }

        // Delete EXIF files for this user's files
        let exifDeleted = 0;
        for (const hash of fileHashes) {
            try {
                const exifPath = getExifPath(hash);
                if (exifPath && fs.existsSync(exifPath)) {
                    fs.unlinkSync(exifPath);
                    exifDeleted++;
                }
            } catch (e) {}
        }

        try {
            await dbRunAsync(`DELETE FROM files WHERE user_id = ?`, [req.user.id]);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to clear file index' });
        }

        // Delete platform hashes for this user (local/remote mode)
        try {
            await dbRunAsync(`DELETE FROM platform_hashes WHERE user_id = ?`, [req.user.id]);
        } catch (e) {}

        console.log(`[Purge-Classic] User ${req.user.id}: files=${filesBefore}, exif=${exifDeleted}`);

        return res.json({
            ok: true,
            deleted: {
                files: filesBefore,
                exif: exifDeleted
            }
        });
    } catch (e) {
        return res.status(500).json({ error: 'Purge failed' });
    }
});

// Thumbnail endpoint - returns resized image (150px) or video frame
app.get('/api/files/:filename/thumb', authenticateToken, async (req, res) => {
    const filename = req.params.filename;
    const resolved = await resolveClassicFileForUser(req.user, filename);
    if (!resolved) return res.status(404).json({ error: 'File not found' });
    const filePath = resolved.filePath;

    // Detect actual file type from magic bytes (extension may be wrong for old uploads)
    let ext = (filename || '').split('.').pop()?.toLowerCase() || '';
    let isImage = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'pef', 'srw', 'raf', 'psd', 'psb', 'exr', 'hdr', 'avif'].includes(ext);
    let isVideo = ['mp4', 'mov', 'avi', 'mkv', 'm4v', '3gp', 'webm'].includes(ext);
    
    // Check magic bytes to detect actual format (handles mismatched extensions)
    try {
        const fd = fs.openSync(filePath, 'r');
        const magicBuf = Buffer.alloc(12);
        fs.readSync(fd, magicBuf, 0, 12, 0);
        fs.closeSync(fd);
        
        const isPNG = magicBuf[0] === 0x89 && magicBuf[1] === 0x50 && magicBuf[2] === 0x4E && magicBuf[3] === 0x47;
        const isJPEG = magicBuf[0] === 0xFF && magicBuf[1] === 0xD8 && magicBuf[2] === 0xFF;
        const isGIF = magicBuf[0] === 0x47 && magicBuf[1] === 0x49 && magicBuf[2] === 0x46;
        const isWEBP = magicBuf[8] === 0x57 && magicBuf[9] === 0x45 && magicBuf[10] === 0x42 && magicBuf[11] === 0x50;
        
        // If magic bytes indicate image but extension says otherwise, trust magic bytes
        if (isPNG || isJPEG || isGIF || isWEBP) {
            const detectedFormat = isPNG ? 'PNG' : isJPEG ? 'JPEG' : isGIF ? 'GIF' : 'WEBP';
            if (!isImage) {
                console.log(`[THUMB] Magic bytes detected ${detectedFormat} for ${filename} (ext was ${ext})`);
            }
            isImage = true;
            isVideo = false;
        }
    } catch (e) {
        // If magic byte detection fails, fall back to extension
    }

    if (!isImage && !isVideo) {
        return res.status(400).json({ error: 'Not a media file' });
    }

    // Handle video thumbnails using ffmpeg
    if (isVideo) {
        const { execFile } = require('child_process');
        const tmpThumb = path.join(os.tmpdir(), `thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpegPath, [
                    '-i', filePath,
                    '-ss', '00:00:01',
                    '-vframes', '1',
                    '-vf', 'scale=150:150:force_original_aspect_ratio=increase,crop=150:150',
                    '-y',
                    tmpThumb
                ], { timeout: 10000 }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            if (fs.existsSync(tmpThumb)) {
                const thumbBuffer = fs.readFileSync(tmpThumb);
                fs.unlinkSync(tmpThumb);
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(thumbBuffer);
            }
        } catch (e) {
            if (fs.existsSync(tmpThumb)) fs.unlinkSync(tmpThumb);
            console.log('Video thumbnail generation failed:', e.message);
        }
        // Fallback: generate a simple placeholder for videos if ffmpeg fails
        if (sharp) {
            try {
                const placeholder = await sharp({
                    create: { width: 150, height: 150, channels: 3, background: { r: 40, g: 40, b: 60 } }
                }).jpeg({ quality: 70 }).toBuffer();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(placeholder);
            } catch (e2) {}
        }
        return res.status(500).json({ error: 'Video thumbnail generation failed' });
    }

    // If sharp is available, generate thumbnail for images
    if (sharp) {
        // Check if this is a HEIC file that needs conversion
        const isHeicFile = ['heic', 'heif'].includes(ext);
        let inputBuffer = null;
        
        // Try to convert HEIC to JPEG first if heic-convert is available
        if (isHeicFile && heicConvert) {
            try {
                console.log(`[THUMB] Converting HEIC: ${filename}`);
                const heicBuffer = fs.readFileSync(filePath);
                const jpegBuffer = await heicConvert({
                    buffer: heicBuffer,
                    format: 'JPEG',
                    quality: 0.8
                });
                inputBuffer = jpegBuffer;
                console.log(`[THUMB] HEIC converted: ${filename}, size: ${jpegBuffer.length}`);
            } catch (heicErr) {
                console.log(`[THUMB] HEIC conversion failed for ${filename}:`, heicErr.message);
            }
        }
        
        try {
            // Read file into buffer to avoid Sharp holding file handle open on Windows
            const sharpInput = inputBuffer || fs.readFileSync(filePath);
            const thumbBuffer = await sharp(sharpInput, { failOn: 'none', pages: 1 })
                .rotate()
                .resize(150, 150, { fit: 'cover', position: 'center' })
                .jpeg({ quality: 70 })
                .toBuffer();
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(thumbBuffer);
        } catch (e) {
            console.log(`[THUMB] Generation failed for ${filename}:`, e.message);
            // Generate a larger placeholder with gradient so client accepts it
            try {
                // Create a 150x150 gradient placeholder that's large enough to pass client check
                const placeholder = await sharp({
                    create: { width: 150, height: 150, channels: 3, background: { r: 60, g: 60, b: 80 } }
                })
                .composite([{
                    input: Buffer.from(`<svg width="150" height="150">
                        <rect width="150" height="150" fill="url(#grad)"/>
                        <defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" style="stop-color:#3a3a4a"/>
                            <stop offset="100%" style="stop-color:#5a5a6a"/>
                        </linearGradient></defs>
                        <text x="75" y="80" text-anchor="middle" fill="#888" font-size="12">No Preview</text>
                    </svg>`),
                    top: 0,
                    left: 0
                }])
                .jpeg({ quality: 80 })
                .toBuffer();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=3600'); // Shorter cache for placeholders
                return res.send(placeholder);
            } catch (e2) {
                console.log(`[THUMB] Placeholder failed for ${filename}:`, e2.message);
            }
        }
    }

    // Fallback: generate simple placeholder (don't serve huge original)
    if (sharp) {
        try {
            const placeholder = await sharp({
                create: { width: 150, height: 150, channels: 3, background: { r: 60, g: 60, b: 60 } }
            }).jpeg({ quality: 70 }).toBuffer();
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(placeholder);
        } catch (e) {}
    }
    res.status(500).json({ error: 'Thumbnail generation failed' });
});

// Download File
app.get('/api/files/:filename', authenticateToken, async (req, res) => {
    const filename = req.params.filename;
    console.log('[DOWNLOAD] Request for:', filename, 'user.id:', req.user && req.user.id, 'user.email:', req.user && req.user.email, 'device_uuid:', req.user && req.user.device_uuid);
    try {
        const uuids = await getUserDeviceUuids(req.user);
        console.log('[DOWNLOAD] Device UUIDs for user:', JSON.stringify(uuids));
        const resolved = await resolveClassicFileForUser(req.user, filename);
        if (!resolved) {
            console.error('[DOWNLOAD] File not found:', filename, 'searched UUIDs:', JSON.stringify(uuids), 'UPLOAD_DIR:', UPLOAD_DIR);
            return res.status(404).json({ error: 'File not found' });
        }
        const filePath = resolved.filePath;
        console.log('[DOWNLOAD] Resolved path:', filePath);

        let stat;
        try {
            stat = fs.statSync(filePath);
            console.log('[DOWNLOAD] File stat: size=', stat.size, 'mode=', stat.mode.toString(8), 'uid=', stat.uid, 'gid=', stat.gid);
        } catch (statErr) {
            console.error('[DOWNLOAD] stat failed:', statErr.message);
            return res.status(404).json({ error: 'File not accessible' });
        }

        try {
            fs.accessSync(filePath, fs.constants.R_OK);
        } catch (e) {
            console.error('[DOWNLOAD] Not readable, attempting chmod 644:', filePath);
            try { fs.chmodSync(filePath, 0o644); } catch (e2) { console.error('[DOWNLOAD] chmod failed:', e2.message); }
            try {
                fs.accessSync(filePath, fs.constants.R_OK);
            } catch (e3) {
                console.error('[DOWNLOAD] Still not readable after chmod:', e3.message);
                return res.status(403).json({ error: 'Permission denied' });
            }
        }

        // Use manual stream instead of res.download() for reliability under Electron
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.pdf': 'application/pdf' };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);

        const stream = fs.createReadStream(filePath);
        stream.on('error', (streamErr) => {
            console.error('[DOWNLOAD] Stream error for', filename, ':', streamErr.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download failed' });
            } else {
                res.destroy();
            }
        });
        stream.pipe(res);
    } catch (err) {
        console.error('[DOWNLOAD] Unhandled error for', filename, ':', err.message, err.stack);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
    }
});

// --- StealthCloud (zero-knowledge) routes ---
// Server stores encrypted chunks and encrypted manifests only.

// Server uptime status (honest, persistent, shared between main and Pi)
// Tracks real uptime and downtime with a rolling event log for accurate 24h percentage.
// Both main and Pi run the same server.js — the active instance writes heartbeats.
// Gaps between heartbeats > HEARTBEAT_GAP_THRESHOLD_MS are counted as real downtime.
//
// Failover support (bidirectional):
// Each server has PEER_SERVER_URL pointing to the other.
// On startup with a gap, it tries to fetch the peer's uptime state:
// - If peer responds: peer was serving during the gap → credit peer's uptime, only
//   count two short failover transitions (~30s each) as downtime.
// - If peer is unreachable: nobody was serving → count the full gap as downtime.
// This works for both directions: main→pi failover and pi→main recovery.
const UPTIME_STATE_PATH = process.env.UPTIME_STATE_PATH || path.join(DATA_DIR, 'uptime.json');
const SERVER_ROLE = process.env.SERVER_ROLE || 'main'; // 'main' or 'pi'
const PEER_SERVER_URL = process.env.PEER_SERVER_URL || null; // main→pi or pi→main
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s heartbeat
const HEARTBEAT_GAP_THRESHOLD_MS = 2 * 60 * 1000; // >2 min gap = downtime
const FAILOVER_GAP_MS = 30 * 1000; // Assume ~30s downtime per failover transition
const EVENT_LOG_RETENTION_MS = 48 * 60 * 60 * 1000; // Keep 48h of events for 24h window calc

function loadUptimeState() {
    try {
        if (!fs.existsSync(UPTIME_STATE_PATH)) return null;
        const raw = fs.readFileSync(UPTIME_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        // Current format: v2 with event log
        if (parsed.v === 2 && Array.isArray(parsed.events)) {
            return {
                v: 2,
                totalUptimeMs: Math.max(0, Number(parsed.totalUptimeMs) || 0),
                totalDowntimeMs: Math.max(0, Number(parsed.totalDowntimeMs) || 0),
                lastHeartbeat: Number(parsed.lastHeartbeat) || 0,
                firstSeen: Number(parsed.firstSeen) || Date.now(),
                lastRole: parsed.lastRole || SERVER_ROLE,
                events: parsed.events, // [{t: timestamp, type: 'up'|'down', durationMs, role}]
            };
        }

        // Migrate from v1 (old format) — start fresh with honest counters
        return null;
    } catch (e) {
        return null;
    }
}

function saveUptimeState(state) {
    try {
        fs.mkdirSync(path.dirname(UPTIME_STATE_PATH), { recursive: true });
        fs.writeFileSync(UPTIME_STATE_PATH, JSON.stringify(state));
    } catch (e) {
        // best effort
    }
}

function pruneOldEvents(events, now) {
    const cutoff = now - EVENT_LOG_RETENTION_MS;
    return events.filter(e => e && e.t >= cutoff);
}

function computeUptimeForWindow(events, now, windowMs) {
    const windowStart = now - windowMs;
    let uptimeInWindow = 0;
    let downtimeInWindow = 0;

    for (const ev of events) {
        if (!ev || !ev.t || !ev.durationMs) continue;
        const evStart = ev.t;
        const evEnd = ev.t + ev.durationMs;
        // Clip to window
        const clippedStart = Math.max(evStart, windowStart);
        const clippedEnd = Math.min(evEnd, now);
        if (clippedEnd <= clippedStart) continue;
        const clippedDuration = clippedEnd - clippedStart;
        if (ev.type === 'up') uptimeInWindow += clippedDuration;
        else if (ev.type === 'down') downtimeInWindow += clippedDuration;
    }

    const totalTracked = uptimeInWindow + downtimeInWindow;
    if (totalTracked === 0) return { uptimeMs: 0, downtimeMs: 0, pct: null };
    const pct = totalTracked > 0 ? (uptimeInWindow / totalTracked) : 1;
    return { uptimeMs: uptimeInWindow, downtimeMs: downtimeInWindow, pct };
}

// Fetch uptime state from peer server (main↔pi)
async function fetchPeerUptimeState(url) {
    try {
        const http = url.startsWith('https') ? require('https') : require('http');
        return await new Promise((resolve) => {
            const req = http.get(`${url}/api/status/uptime/state`, { timeout: 3000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && parsed.ok && parsed.state && parsed.state.v === 2) {
                            resolve(parsed.state);
                        } else {
                            resolve(null);
                        }
                    } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    } catch (e) {
        return null;
    }
}

// Merge peer's events into local state, covering the gap period.
// peerState = remote uptime state, gapStart = when this server went down, now = current time
function mergeWithPeerState(localState, peerState, gapStart, now) {
    const peerRole = peerState.lastRole || (SERVER_ROLE === 'main' ? 'pi' : 'main');

    // Find peer events that overlap with our gap period
    let peerUptimeInGap = 0;
    let peerDowntimeInGap = 0;
    const peerEvents = Array.isArray(peerState.events) ? peerState.events : [];

    for (const ev of peerEvents) {
        if (!ev || !ev.t || !ev.durationMs) continue;
        const evEnd = ev.t + ev.durationMs;
        // Clip to our gap window
        const clippedStart = Math.max(ev.t, gapStart);
        const clippedEnd = Math.min(evEnd, now);
        if (clippedEnd <= clippedStart) continue;
        const dur = clippedEnd - clippedStart;
        if (ev.type === 'up') peerUptimeInGap += dur;
        else if (ev.type === 'down') peerDowntimeInGap += dur;
    }

    const gapDuration = now - gapStart;
    const peerCoverage = peerUptimeInGap + peerDowntimeInGap;

    if (peerCoverage > 0) {
        // Peer was active during (part of) the gap — credit its uptime
        // Time not covered by peer events = failover transitions (downtime)
        const uncoveredGap = Math.max(0, gapDuration - peerCoverage);
        // Cap uncovered gap: at most 2 failover transitions
        const failoverDowntime = Math.min(uncoveredGap, FAILOVER_GAP_MS * 2);
        // Any remaining uncovered time beyond 2 transitions is ambiguous; count as downtime
        const totalDowntimeForGap = peerDowntimeInGap + failoverDowntime + Math.max(0, uncoveredGap - FAILOVER_GAP_MS * 2);

        localState.totalUptimeMs += peerUptimeInGap;
        localState.totalDowntimeMs += totalDowntimeForGap;

        // Add peer's events to our log for accurate 24h window calculation
        for (const ev of peerEvents) {
            if (!ev || !ev.t || !ev.durationMs) continue;
            const evEnd = ev.t + ev.durationMs;
            if (evEnd <= gapStart || ev.t >= now) continue; // outside gap
            // Clip and add
            const clippedStart = Math.max(ev.t, gapStart);
            const clippedEnd = Math.min(evEnd, now);
            if (clippedEnd > clippedStart) {
                localState.events.push({
                    t: clippedStart,
                    type: ev.type,
                    durationMs: clippedEnd - clippedStart,
                    role: ev.role || peerRole,
                });
            }
        }

        // Add failover transition downtime events
        if (failoverDowntime > 0) {
            // Split into two transitions: this→peer and peer→this
            const halfGap = Math.min(FAILOVER_GAP_MS, Math.floor(failoverDowntime / 2));
            if (halfGap > 0) {
                localState.events.push({
                    t: gapStart,
                    type: 'down',
                    durationMs: halfGap,
                    role: 'failover',
                });
                localState.events.push({
                    t: now - halfGap,
                    type: 'down',
                    durationMs: halfGap,
                    role: 'failover',
                });
            }
        }

        console.log(`[Uptime] Merged peer(${peerRole}) state: credited ${(peerUptimeInGap / 3600000).toFixed(2)}h uptime, ${(totalDowntimeForGap / 1000).toFixed(0)}s downtime for ${(gapDuration / 3600000).toFixed(2)}h gap`);
        return true;
    }

    return false; // Peer had no events covering our gap
}

// Initialize uptime state
let uptimeState = loadUptimeState();
let uptimeReady = false; // Gate: heartbeat + endpoints wait until init completes
const nowInit = Date.now();

// Simple init: no gap or no peer configured — just detect gap as downtime
function initUptimeSimple() {
    if (!uptimeState) {
        uptimeState = {
            v: 2,
            totalUptimeMs: 0,
            totalDowntimeMs: 0,
            lastHeartbeat: nowInit,
            firstSeen: nowInit,
            lastRole: SERVER_ROLE,
            events: [],
        };
        saveUptimeState(uptimeState);
        uptimeReady = true;
        console.log(`[Uptime] Fresh start — tracking from now (role=${SERVER_ROLE})`);
    } else {
        const gap = Math.max(0, nowInit - uptimeState.lastHeartbeat);
        if (gap > HEARTBEAT_GAP_THRESHOLD_MS && uptimeState.lastHeartbeat > 0) {
            uptimeState.totalDowntimeMs += gap;
            uptimeState.events.push({
                t: uptimeState.lastHeartbeat,
                type: 'down',
                durationMs: gap,
                role: uptimeState.lastRole || SERVER_ROLE,
            });
            console.log(`[Uptime] Detected ${(gap / 1000 / 60).toFixed(1)} min downtime gap (no peer to check)`);
        }
        uptimeState.lastHeartbeat = nowInit;
        uptimeState.lastRole = SERVER_ROLE;
        uptimeState.events = pruneOldEvents(uptimeState.events, nowInit);
        saveUptimeState(uptimeState);
        uptimeReady = true;
        console.log(`[Uptime] Resumed — role=${SERVER_ROLE}, totalUp=${(uptimeState.totalUptimeMs / 3600000).toFixed(2)}h, totalDown=${(uptimeState.totalDowntimeMs / 3600000).toFixed(2)}h`);
    }
}

// Async init: try to fetch peer's state to cover the gap
async function initUptimeWithPeer() {
    if (!uptimeState) {
        // First run — no gap to merge, just start fresh
        initUptimeSimple();
        return;
    }

    const gap = Math.max(0, nowInit - uptimeState.lastHeartbeat);
    if (gap <= HEARTBEAT_GAP_THRESHOLD_MS) {
        // No significant gap — normal restart
        uptimeState.lastHeartbeat = nowInit;
        uptimeState.lastRole = SERVER_ROLE;
        uptimeState.events = pruneOldEvents(uptimeState.events, nowInit);
        saveUptimeState(uptimeState);
        uptimeReady = true;
        console.log(`[Uptime] Quick restart (${(gap / 1000).toFixed(0)}s gap) — role=${SERVER_ROLE}`);
        return;
    }

    // Significant gap — try to fetch peer's state
    const gapStart = uptimeState.lastHeartbeat;
    console.log(`[Uptime] ${(gap / 1000 / 60).toFixed(1)} min gap detected — fetching peer state from ${PEER_SERVER_URL}...`);
    const peerState = await fetchPeerUptimeState(PEER_SERVER_URL);

    if (peerState) {
        // Peer is reachable — merge its events covering our gap
        const merged = mergeWithPeerState(uptimeState, peerState, gapStart, nowInit);
        if (merged) {
            // Also adopt peer's firstSeen if it's older
            if (peerState.firstSeen && peerState.firstSeen < uptimeState.firstSeen) {
                uptimeState.firstSeen = peerState.firstSeen;
            }
        } else {
            // Peer responded but had no events covering our gap — count as downtime
            uptimeState.totalDowntimeMs += gap;
            uptimeState.events.push({
                t: gapStart,
                type: 'down',
                durationMs: gap,
                role: uptimeState.lastRole || SERVER_ROLE,
            });
            console.log(`[Uptime] Peer responded but had no events for gap — ${(gap / 1000 / 60).toFixed(1)} min downtime`);
        }
    } else {
        // Peer unreachable — nobody was serving, count full gap as downtime
        uptimeState.totalDowntimeMs += gap;
        uptimeState.events.push({
            t: gapStart,
            type: 'down',
            durationMs: gap,
            role: uptimeState.lastRole || SERVER_ROLE,
        });
        console.log(`[Uptime] Peer unreachable — ${(gap / 1000 / 60).toFixed(1)} min downtime`);
    }

    uptimeState.lastHeartbeat = nowInit;
    uptimeState.lastRole = SERVER_ROLE;
    uptimeState.events = pruneOldEvents(uptimeState.events, nowInit);
    saveUptimeState(uptimeState);
    uptimeReady = true;
    console.log(`[Uptime] Resumed — role=${SERVER_ROLE}, totalUp=${(uptimeState.totalUptimeMs / 3600000).toFixed(2)}h, totalDown=${(uptimeState.totalDowntimeMs / 3600000).toFixed(2)}h`);
}

// Run init
if (PEER_SERVER_URL) {
    initUptimeWithPeer().catch(e => {
        console.warn('[Uptime] Peer init failed, falling back to simple init:', e?.message);
        initUptimeSimple();
    });
} else {
    initUptimeSimple();
}

// Heartbeat: record uptime tick every 60s
setInterval(() => {
    if (!uptimeReady || !uptimeState) return; // Wait for init to complete
    const now = Date.now();
    const gap = Math.max(0, now - uptimeState.lastHeartbeat);

    if (gap > HEARTBEAT_GAP_THRESHOLD_MS) {
        // Unexpected large gap while running (e.g. system suspend) — count as downtime
        uptimeState.totalDowntimeMs += gap;
        uptimeState.events.push({
            t: uptimeState.lastHeartbeat,
            type: 'down',
            durationMs: gap,
            role: SERVER_ROLE,
        });
    } else {
        // Normal heartbeat — count as uptime
        uptimeState.totalUptimeMs += gap;
        uptimeState.events.push({
            t: uptimeState.lastHeartbeat,
            type: 'up',
            durationMs: gap,
            role: SERVER_ROLE,
        });
    }

    uptimeState.lastHeartbeat = now;
    uptimeState.lastRole = SERVER_ROLE;
    uptimeState.events = pruneOldEvents(uptimeState.events, now);
    saveUptimeState(uptimeState);
}, HEARTBEAT_INTERVAL_MS).unref();

app.get('/api/status/uptime', (_req, res) => {
    if (!uptimeReady || !uptimeState) {
        return res.json({ ok: false, error: 'Uptime system initializing', serverRole: SERVER_ROLE });
    }
    const now = Date.now();

    // Add current live interval (since last heartbeat) as uptime
    const liveSinceLastHb = Math.max(0, now - uptimeState.lastHeartbeat);
    const liveEvents = [...uptimeState.events];
    if (liveSinceLastHb > 0 && liveSinceLastHb <= HEARTBEAT_GAP_THRESHOLD_MS) {
        liveEvents.push({ t: uptimeState.lastHeartbeat, type: 'up', durationMs: liveSinceLastHb, role: SERVER_ROLE });
    }

    // 24h window
    const window24h = computeUptimeForWindow(liveEvents, now, 24 * 60 * 60 * 1000);
    // 7d window
    const window7d = computeUptimeForWindow(liveEvents, now, 7 * 24 * 60 * 60 * 1000);

    // Lifetime
    const totalUp = uptimeState.totalUptimeMs + liveSinceLastHb;
    const totalDown = uptimeState.totalDowntimeMs;
    const totalTracked = totalUp + totalDown;
    const pctLifetime = totalTracked > 0 ? Math.max(0, Math.min(1, totalUp / totalTracked)) : (totalUp > 0 ? 1 : null);

    // Current run duration (since this process started)
    const currentRunMs = Math.max(0, now - nowInit);
    const currentRunSec = Math.floor(currentRunMs / 1000);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
        ok: true,
        serverRole: SERVER_ROLE,
        firstSeen: uptimeState.firstSeen,
        now,
        currentRunSeconds: currentRunSec,
        currentRunHours: +(currentRunSec / 3600).toFixed(2),
        currentRunDays: +(currentRunSec / 86400).toFixed(3),
        uptimePct24h: window24h.pct !== null ? +(window24h.pct * 100).toFixed(2) : null,
        uptimePct7d: window7d.pct !== null ? +(window7d.pct * 100).toFixed(2) : null,
        pctLifetime: pctLifetime !== null ? +(pctLifetime * 100).toFixed(2) : null,
        totalUptimeHours: +(totalUp / 3600000).toFixed(2),
        totalDowntimeHours: +(totalDown / 3600000).toFixed(2),
    });
});

// Raw uptime state for Pi to fetch from main on startup (no auth — only aggregate counters)
app.get('/api/status/uptime/state', (_req, res) => {
    if (!uptimeReady || !uptimeState) {
        return res.json({ ok: false, error: 'Uptime system initializing' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
        ok: true,
        state: {
            v: 2,
            totalUptimeMs: uptimeState.totalUptimeMs,
            totalDowntimeMs: uptimeState.totalDowntimeMs,
            lastHeartbeat: uptimeState.lastHeartbeat,
            firstSeen: uptimeState.firstSeen,
            lastRole: uptimeState.lastRole,
            events: uptimeState.events || [],
        },
    });
});

// Admin: view raw uptime state for debugging (no modification)
app.get('/api/status/uptime/debug', (req, res) => {
    const secret = req.query.secret;
    const DEBUG_SECRET = process.env.DEBUG_SECRET || '';
    if (!DEBUG_SECRET || secret !== DEBUG_SECRET) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    const recentEvents = (uptimeState.events || []).slice(-50).map(e => ({
        ...e,
        ago: `${((now - e.t) / 60000).toFixed(1)}m`,
        duration: `${(e.durationMs / 1000).toFixed(0)}s`,
    }));
    return res.json({
        ok: true,
        role: SERVER_ROLE,
        state: {
            totalUptimeMs: uptimeState.totalUptimeMs,
            totalDowntimeMs: uptimeState.totalDowntimeMs,
            lastHeartbeat: uptimeState.lastHeartbeat,
            firstSeen: uptimeState.firstSeen,
            lastRole: uptimeState.lastRole,
            eventCount: (uptimeState.events || []).length,
        },
        recentEvents,
    });
});

// ============================================================================
// SERVER-SIDE DEDUPLICATION HELPERS
// Extra precaution: check all dedup criteria on server before accepting upload
// ============================================================================

// Hamming distance for 16-char hex hash (64 bits) - for perceptual hash fuzzy matching
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

// Cross-platform dHash threshold (1 bit = strict match, same as client)
const SERVER_DHASH_THRESHOLD = 1;

// Normalize filename for comparison
function normalizeFilenameForCompare(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    return trimmed.toLowerCase();
}

const serverDedupCache = new Map(); // manifestsDir -> { sets, files: Set<string> }

// Build server-side dedup sets from existing manifests (with incremental in-memory cache to fix O(N^2) bottleneck)
function buildServerDedupSets(manifestsDir) {
    const emptySets = {
        manifestIds: new Set(),
        filenames: new Set(),
        fileHashes: new Set(),
        perceptualHashes: new Set(),
        exifFull: new Set(),
        exifTimeModel: new Set(),
        exifTimeMake: new Set(),
    };
    
    if (!fs.existsSync(manifestsDir)) {
        serverDedupCache.delete(manifestsDir);
        return emptySets;
    }
    
    let cacheEntry = serverDedupCache.get(manifestsDir);
    if (!cacheEntry) {
        cacheEntry = { sets: emptySets, files: new Set() };
        serverDedupCache.set(manifestsDir, cacheEntry);
    }
    
    try {
        const currentFiles = fs.readdirSync(manifestsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
        
        // If files were deleted (rare), easiest is to invalidate and rebuild from scratch
        if (currentFiles.length < cacheEntry.files.size) {
            serverDedupCache.delete(manifestsDir);
            return buildServerDedupSets(manifestsDir);
        }
        
        // Incrementally add new files
        for (const f of currentFiles) {
            if (!cacheEntry.files.has(f)) {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), 'utf8'));
                    const manifestId = f.replace(/\.json$/, '');
                    cacheEntry.sets.manifestIds.add(manifestId);
                    
                    if (content.meta) {
                        if (content.meta.filename) {
                            const normalized = normalizeFilenameForCompare(content.meta.filename);
                            if (normalized) cacheEntry.sets.filenames.add(normalized);
                        }
                        if (content.meta.fileHash) cacheEntry.sets.fileHashes.add(content.meta.fileHash);
                        if (content.meta.perceptualHash) cacheEntry.sets.perceptualHashes.add(content.meta.perceptualHash);
                        
                        // EXIF-based dedup keys
                        const ct = content.meta.exifCaptureTime;
                        const mk = content.meta.exifMake;
                        const md = content.meta.exifModel;
                        if (ct && mk && md) cacheEntry.sets.exifFull.add(`${ct}|${mk}|${md}`);
                        if (ct && md) cacheEntry.sets.exifTimeModel.add(`${ct}|${md}`);
                        if (ct && mk) cacheEntry.sets.exifTimeMake.add(`${ct}|${mk}`);
                    }
                    cacheEntry.files.add(f);
                } catch (e) {
                    // Skip unreadable manifests
                }
            }
        }
    } catch (e) {
        console.warn('[SC] Failed to build dedup sets:', e.message);
    }
    
    return cacheEntry.sets;
}

// Check if perceptual hash matches any existing hash (fuzzy matching)
function findPerceptualHashMatchServer(hash, hashSet) {
    if (!hash || hash.length !== 16 || !hashSet || hashSet.size === 0) return { match: false };
    if (hashSet.has(hash)) return { match: true, reason: 'exact' };
    for (const existing of hashSet) {
        if (existing && existing.length === 16) {
            const dist = hammingDistance64(hash, existing);
            if (dist <= SERVER_DHASH_THRESHOLD) {
                return { match: true, reason: 'fuzzy', distance: dist };
            }
        }
    }
    return { match: false };
}

// DELETE /api/account - Delete user account and all associated data (GDPR compliance)
app.delete('/api/account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email || '';
        const userKey = getStealthCloudUserKey(req.user);
        
        console.log(`[Account Deletion] Starting deletion for user ${userId} (${userEmail})`);
        
        // Get user directories
        const userDir = path.join(CLOUD_DIR, 'users', userKey);
        const chunksDir = CHUNKS_DIR 
            ? path.join(CHUNKS_DIR, 'users', userKey)
            : path.join(userDir, 'chunks');
        const deviceDir = path.join(UPLOAD_DIR, req.user.device_uuid || '');
        
        // Clear dedup cache before deleting user directories
        try {
            const manifestsDir = path.join(userDir, 'manifests');
            serverDedupCache.delete(manifestsDir);
        } catch (e) {}

        // Delete all user files (chunks, manifests, classic uploads)
        const dirsToDelete = [chunksDir, userDir, deviceDir].filter(d => d && d.length > 10);
        for (const dir of dirsToDelete) {
            try {
                if (fs.existsSync(dir)) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    console.log(`[Account Deletion] Deleted directory: ${dir}`);
                }
            } catch (e) {
                console.error(`[Account Deletion] Error deleting ${dir}:`, e.message);
            }
        }
        
        // Delete every user-scoped row so no orphaned metadata survives
        // (files/devices/hashes/chunks/device-state all key on user_id).
        const USER_SCOPED_TABLES = ['user_plans', 'files', 'devices', 'platform_hashes', 'cloud_chunks', 'cloud_device_state'];
        for (const table of USER_SCOPED_TABLES) {
            await new Promise((resolve) => {
                db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId], (err) => {
                    if (err) console.error(`[Account Deletion] Error deleting ${table}:`, err.message);
                    resolve();
                });
            });
        }

        await new Promise((resolve, reject) => {
            db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                if (err) {
                    console.error('[Account Deletion] Error deleting user:', err.message);
                    reject(err);
                } else {
                    console.log(`[Account Deletion] User ${userId} deleted from database`);
                    resolve();
                }
            });
        });
        
        console.log(`[Account Deletion] Successfully deleted account for user ${userId}`);
        res.json({ success: true, message: 'Account and all associated data deleted successfully' });
    } catch (error) {
        console.error('[Account Deletion] Error:', error);
        res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
    }
});

// ============================================================================
// EXIF METADATA PRESERVATION (Universal cross-platform)
// ============================================================================

// EXIF data is stored by file hash for universal cross-platform preservation
// When files are synced/restored, EXIF can be applied regardless of source platform
const EXIF_DIR = path.join(CLOUD_DIR, 'exif');
if (!fs.existsSync(EXIF_DIR)) {
    fs.mkdirSync(EXIF_DIR, { recursive: true });
}

// Get EXIF file path by hash (uses first 2 chars as subdirectory for performance)
const getExifPath = (fileHash) => {
    const safeHash = String(fileHash || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 64);
    if (!safeHash || safeHash.length < 8) return null;
    const subDir = safeHash.slice(0, 2);
    const exifSubDir = path.join(EXIF_DIR, subDir);
    if (!fs.existsSync(exifSubDir)) {
        fs.mkdirSync(exifSubDir, { recursive: true });
    }
    return path.join(exifSubDir, `${safeHash}.json`);
};

// Store EXIF metadata by file hash
app.post('/api/exif/store', authenticateToken, async (req, res) => {
    try {
        const { fileHash, exif, platform } = req.body || {};
        
        if (!fileHash || typeof fileHash !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid fileHash' });
        }
        
        if (!exif || typeof exif !== 'object') {
            return res.status(400).json({ error: 'Missing or invalid exif object' });
        }
        
        const exifPath = getExifPath(fileHash);
        if (!exifPath) {
            return res.status(400).json({ error: 'Invalid fileHash format' });
        }
        
        // Don't overwrite existing EXIF (first upload wins) — atomic via O_EXCL
        const exifData = {
            fileHash: fileHash.slice(0, 64),
            platform: String(platform || 'unknown').slice(0, 20),
            storedAt: new Date().toISOString(),
            userId: req.user.id,
            exif: exif,
        };
        
        let fd;
        try {
            fd = fs.openSync(exifPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
            fs.writeSync(fd, JSON.stringify(exifData, null, 2), 0, 'utf8');
        } catch (excl) {
            if (excl.code === 'EEXIST') {
                return res.json({ ok: true, exists: true, message: 'EXIF already stored' });
            }
            throw excl;
        } finally {
            if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
        }
        console.log(`[EXIF] Stored EXIF for hash ${fileHash.slice(0, 16)}... (${platform})`);
        
        return res.json({ ok: true, stored: true });
    } catch (e) {
        console.error('[EXIF] Store error:', e.message);
        return res.status(500).json({ error: 'Failed to store EXIF' });
    }
});

// Retrieve EXIF metadata by file hash
app.get('/api/exif/:fileHash', authenticateToken, async (req, res) => {
    try {
        const fileHash = req.params.fileHash;
        
        if (!fileHash || typeof fileHash !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid fileHash' });
        }
        
        const exifPath = getExifPath(fileHash);
        if (!exifPath) {
            return res.status(400).json({ error: 'Invalid fileHash format' });
        }
        
        if (!fs.existsSync(exifPath)) {
            return res.status(404).json({ error: 'EXIF not found', fileHash });
        }
        
        const exifData = JSON.parse(fs.readFileSync(exifPath, 'utf8'));
        return res.json(exifData);
    } catch (e) {
        console.error('[EXIF] Retrieve error:', e.message);
        return res.status(500).json({ error: 'Failed to retrieve EXIF' });
    }
});

// Batch retrieve EXIF for multiple file hashes (for sync operations)
app.post('/api/exif/batch', authenticateToken, async (req, res) => {
    try {
        const { fileHashes } = req.body || {};
        
        if (!Array.isArray(fileHashes)) {
            return res.status(400).json({ error: 'fileHashes must be an array' });
        }
        
        // Limit batch size to prevent abuse
        const limitedHashes = fileHashes.slice(0, 100);
        const results = {};
        
        for (const hash of limitedHashes) {
            if (!hash || typeof hash !== 'string') continue;
            
            const exifPath = getExifPath(hash);
            if (!exifPath) continue;
            
            if (fs.existsSync(exifPath)) {
                try {
                    results[hash] = JSON.parse(fs.readFileSync(exifPath, 'utf8'));
                } catch (e) {
                    // Skip invalid files
                }
            }
        }
        
        return res.json({ exifData: results, found: Object.keys(results).length });
    } catch (e) {
        console.error('[EXIF] Batch retrieve error:', e.message);
        return res.status(500).json({ error: 'Failed to retrieve EXIF batch' });
    }
});

// Batch check which fileHashes are missing EXIF sidecar (for backfill module)
app.post('/api/exif/check-missing', authenticateToken, async (req, res) => {
    try {
        const { fileHashes } = req.body || {};
        if (!Array.isArray(fileHashes)) {
            return res.status(400).json({ error: 'fileHashes must be an array' });
        }
        const limited = fileHashes.slice(0, 500);
        const missing = [];
        for (const hash of limited) {
            if (!hash || typeof hash !== 'string') continue;
            const exifPath = getExifPath(hash);
            if (!exifPath) continue;
            if (!fs.existsSync(exifPath)) missing.push(hash);
        }
        return res.json({ missing, checked: limited.length });
    } catch (e) {
        console.error('[EXIF] check-missing error:', e.message);
        return res.status(500).json({ error: 'Failed to check EXIF' });
    }
});

// ============================================================================
// CROSS-APP DEVICE LINKING (QR pairing between installs)
// ============================================================================

const sanitizeUserKey = (v) => {
    const raw = String(v || '');
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    return safe || '';
};

// Get all device_uuids linked to a given device_uuid (includes the device itself)
const getLinkedDeviceUuids = (deviceUuid) => {
    return new Promise((resolve) => {
        const safeUuid = sanitizeUserKey(deviceUuid);
        if (!safeUuid) return resolve([]);
        db.all(
            `SELECT device_uuid_a, device_uuid_b FROM linked_devices
             WHERE device_uuid_a = ? OR device_uuid_b = ?`,
            [safeUuid, safeUuid],
            (err, rows) => {
                if (err || !rows) return resolve([safeUuid]);
                const linked = new Set([safeUuid]);
                rows.forEach(r => {
                    if (r.device_uuid_a) linked.add(r.device_uuid_a);
                    if (r.device_uuid_b) linked.add(r.device_uuid_b);
                });
                resolve([...linked]);
            }
        );
    });
};

// Link two devices — POST /api/device/link
// Body: { target_device_uuid, label? }
// The caller's device_uuid comes from their JWT token.
app.post('/api/device/link', authenticateToken, async (req, res) => {
    try {
        const myUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);
        const targetUuid = sanitizeUserKey(req.body.target_device_uuid);
        const label = (req.body.label || '').toString().slice(0, 200);

        if (!myUuid || !targetUuid) {
            return res.status(400).json({ error: 'Missing device UUID' });
        }
        if (myUuid === targetUuid) {
            return res.status(400).json({ error: 'Cannot link device to itself' });
        }

        // Sort UUIDs to ensure consistent ordering (avoids duplicate pairs)
        const [uuidA, uuidB] = [myUuid, targetUuid].sort();

        db.run(
            `INSERT OR IGNORE INTO linked_devices (device_uuid_a, device_uuid_b, created_at, label)
             VALUES (?, ?, ?, ?)`,
            [uuidA, uuidB, Date.now(), label],
            function (err) {
                if (err) {
                    console.error('[DeviceLink] Error:', err);
                    return res.status(500).json({ error: 'Failed to link devices' });
                }
                console.log(`[DeviceLink] Linked: ${uuidA} <-> ${uuidB} (label: ${label || 'none'})`);
                res.json({ success: true, linked: { device_uuid_a: uuidA, device_uuid_b: uuidB } });
            }
        );
    } catch (e) {
        console.error('[DeviceLink] Error:', e);
        res.status(500).json({ error: 'Failed to link devices' });
    }
});

// List linked devices — GET /api/device/links
app.get('/api/device/links', authenticateToken, async (req, res) => {
    try {
        const myUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);
        if (!myUuid) return res.json({ links: [] });

        db.all(
            `SELECT id, device_uuid_a, device_uuid_b, created_at, label FROM linked_devices
             WHERE device_uuid_a = ? OR device_uuid_b = ?`,
            [myUuid, myUuid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: 'Failed to get links' });
                const links = (rows || []).map(r => ({
                    id: r.id,
                    paired_device_uuid: r.device_uuid_a === myUuid ? r.device_uuid_b : r.device_uuid_a,
                    created_at: r.created_at,
                    label: r.label,
                }));
                res.json({ links });
            }
        );
    } catch (e) {
        res.status(500).json({ error: 'Failed to get links' });
    }
});

// Unlink a device — DELETE /api/device/link
// Body: { target_device_uuid }
app.delete('/api/device/link', authenticateToken, async (req, res) => {
    try {
        const myUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);
        const targetUuid = sanitizeUserKey(req.body.target_device_uuid);

        if (!myUuid || !targetUuid) {
            return res.status(400).json({ error: 'Missing device UUID' });
        }

        db.run(
            `DELETE FROM linked_devices
             WHERE (device_uuid_a = ? AND device_uuid_b = ?)
                OR (device_uuid_a = ? AND device_uuid_b = ?)`,
            [myUuid, targetUuid, targetUuid, myUuid],
            function (err) {
                if (err) {
                    console.error('[DeviceLink] Unlink error:', err);
                    return res.status(500).json({ error: 'Failed to unlink' });
                }
                console.log(`[DeviceLink] Unlinked: ${myUuid} <-> ${targetUuid} (changes: ${this.changes})`);
                res.json({ success: true, removed: this.changes });
            }
        );
    } catch (e) {
        res.status(500).json({ error: 'Failed to unlink' });
    }
});

// ============================================================================
// EXIF BACKFILL (temporary — fills missing EXIF sidecars for old uploads)
// Runs once at startup, resumes from cursor, self-disables when complete.
// ============================================================================
const EXIF_BACKFILL_CURSOR_PATH = path.join(CLOUD_DIR, '.exif_backfill_cursor.json');
const EXIF_BACKFILL_IMAGE_EXTS = /\.(jpg|jpeg|png|heic|heif|gif|bmp|webp|tiff?|raw|cr2|cr3|nef|arw|dng|orf|rw2|pef|srw|raf|avif)$/i;

let _exifBackfillRunning = false;
const startExifBackfill = async () => {
    if (_exifBackfillRunning) {
        console.log('[ExifBackfill] Already running, skipping');
        return;
    }
    if (!sharp) {
        console.log('[ExifBackfill] sharp not available, skipping');
        return;
    }
    _exifBackfillRunning = true;

    try {
    // Load cursor
    let cursor = { completedAt: null, processedFiles: [] };
    try {
        if (fs.existsSync(EXIF_BACKFILL_CURSOR_PATH)) {
            cursor = JSON.parse(fs.readFileSync(EXIF_BACKFILL_CURSOR_PATH, 'utf8'));
        }
    } catch (_) {}

    if (cursor.completedAt) {
        console.log(`[ExifBackfill] Already completed at ${cursor.completedAt}`);
        return;
    }

    const processedSet = new Set(cursor.processedFiles || []);
    console.log(`[ExifBackfill] Starting server-side backfill (${processedSet.size} previously processed)`);

    // Collect all uploaded files across all device directories
    let allFiles = [];
    try {
        const deviceDirs = fs.readdirSync(UPLOAD_DIR).filter(d => {
            if (d.startsWith('.')) return false;
            try { return fs.statSync(path.join(UPLOAD_DIR, d)).isDirectory(); } catch (_) { return false; }
        });
        for (const dd of deviceDirs) {
            const dirPath = path.join(UPLOAD_DIR, dd);
            try {
                const files = fs.readdirSync(dirPath).filter(f => EXIF_BACKFILL_IMAGE_EXTS.test(f));
                for (const f of files) {
                    allFiles.push({ dir: dirPath, filename: f, key: `${dd}/${f}` });
                }
            } catch (_) {}
        }
    } catch (e) {
        console.error('[ExifBackfill] Failed to scan upload dirs:', e.message);
        return;
    }

    // Filter out already-processed
    allFiles = allFiles.filter(f => !processedSet.has(f.key));
    console.log(`[ExifBackfill] ${allFiles.length} files to check`);

    if (allFiles.length === 0) {
        cursor.completedAt = new Date().toISOString();
        try { fs.writeFileSync(EXIF_BACKFILL_CURSOR_PATH, JSON.stringify(cursor)); } catch (_) {}
        console.log('[ExifBackfill] Nothing to backfill — marking complete');
        return;
    }

    let stored = 0, skipped = 0, errors = 0;

    for (let i = 0; i < allFiles.length; i++) {
        const { dir, filename, key } = allFiles[i];
        const filePath = path.join(dir, filename);

        try {
            // Compute SHA-256 file hash
            const fileHash = await new Promise((resolve, reject) => {
                const hash = crypto.createHash('sha256');
                const stream = fs.createReadStream(filePath);
                stream.on('data', d => hash.update(d));
                stream.on('end', () => resolve(hash.digest('hex')));
                stream.on('error', reject);
            });

            // Check if EXIF sidecar already exists
            const exifPath = getExifPath(fileHash);
            if (exifPath && fs.existsSync(exifPath)) {
                skipped++;
                processedSet.add(key);
                continue;
            }

            // Extract EXIF using sharp
            let meta;
            try {
                meta = await sharp(filePath).metadata();
            } catch (e) {
                // sharp can't read this format — skip
                processedSet.add(key);
                continue;
            }

            if (!meta) {
                processedSet.add(key);
                continue;
            }

            // Build EXIF sidecar object (same structure as mobile extractFullExif)
            const r4 = (v) => {
                const n = Number(v);
                if (n == null || isNaN(n)) return null;
                return Number.isInteger(n) ? n : Math.round(n * 1e4) / 1e4;
            };
            const t4 = (v) => {
                const n = Number(v);
                if (n == null || isNaN(n)) return null;
                return Math.trunc(n * 1e4) / 1e4;
            };

            // Parse EXIF from sharp's raw exif buffer using exif-reader (bundled with sharp)
            let exifTags = {};
            if (meta.exif) {
                try {
                    const exifReader = require('exif-reader');
                    exifTags = exifReader(meta.exif) || {};
                    // Flatten nested structure: { image: {}, exif: {}, gps: {} }
                    const flat = {};
                    if (exifTags.image) Object.assign(flat, exifTags.image);
                    if (exifTags.exif) Object.assign(flat, exifTags.exif);
                    if (exifTags.gps) {
                        // Map GPS fields with proper names
                        if (exifTags.gps.GPSLatitude) flat.GPSLatitude = exifTags.gps.GPSLatitude;
                        if (exifTags.gps.GPSLongitude) flat.GPSLongitude = exifTags.gps.GPSLongitude;
                        if (exifTags.gps.GPSAltitude) flat.GPSAltitude = exifTags.gps.GPSAltitude;
                        if (exifTags.gps.GPSLatitudeRef) flat.GPSLatitudeRef = exifTags.gps.GPSLatitudeRef;
                        if (exifTags.gps.GPSLongitudeRef) flat.GPSLongitudeRef = exifTags.gps.GPSLongitudeRef;
                        if (exifTags.gps.GPSAltitudeRef) flat.GPSAltitudeRef = exifTags.gps.GPSAltitudeRef;
                    }
                    exifTags = flat;
                } catch (e) {
                    exifTags = {};
                }
            }

            const exif = {
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

            // DateTimeOriginal
            let dto = exifTags.DateTimeOriginal || exifTags.DateTimeDigitized;
            if (dto instanceof Date) {
                exif.captureTime = dto.toISOString().slice(0, 19);
            } else if (typeof dto === 'string') {
                const normalized = dto.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
                if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(normalized)) exif.captureTime = normalized.slice(0, 19);
            }

            if (exifTags.Make) exif.make = String(exifTags.Make).replace(/\0/g, '').trim().toLowerCase() || null;
            if (exifTags.Model) exif.model = String(exifTags.Model).replace(/\0/g, '').trim().toLowerCase() || null;
            if (exifTags.OffsetTimeOriginal) exif.offsetTimeOriginal = String(exifTags.OffsetTimeOriginal).trim();
            if (exifTags.SubSecTimeOriginal != null) exif.subSecTimeOriginal = String(exifTags.SubSecTimeOriginal);
            if (exifTags.ExposureTime != null) exif.exposureTime = r4(exifTags.ExposureTime);
            if (exifTags.FNumber != null) exif.fNumber = r4(exifTags.FNumber);
            if (exifTags.ISO != null) exif.iso = Number(exifTags.ISO);
            else if (exifTags.ISOSpeedRatings != null) exif.iso = Array.isArray(exifTags.ISOSpeedRatings) ? exifTags.ISOSpeedRatings[0] : Number(exifTags.ISOSpeedRatings);
            if (exifTags.FocalLength != null) exif.focalLength = r4(exifTags.FocalLength);
            if (exifTags.FocalLengthIn35mmFormat != null) exif.focalLengthIn35mm = r4(exifTags.FocalLengthIn35mmFormat);
            if (exifTags.Flash != null) exif.flash = typeof exifTags.Flash === 'number' ? exifTags.Flash : null;
            if (exifTags.WhiteBalance != null) exif.whiteBalance = Number(exifTags.WhiteBalance);
            if (exifTags.MeteringMode != null) exif.meteringMode = Number(exifTags.MeteringMode);
            if (exifTags.ExposureProgram != null) exif.exposureProgram = Number(exifTags.ExposureProgram);
            if (exifTags.ExposureBiasValue != null) exif.exposureBias = r4(exifTags.ExposureBiasValue);
            exif.width = meta.width || null;
            exif.height = meta.height || null;
            if (exifTags.Orientation != null) exif.orientation = Number(exifTags.Orientation);
            else if (meta.orientation) exif.orientation = meta.orientation;
            if (exifTags.ColorSpace != null) exif.colorSpace = Number(exifTags.ColorSpace);
            if (exifTags.Software) exif.software = String(exifTags.Software).replace(/\0/g, '').trim() || null;
            if (exifTags.LensMake) exif.lensMake = String(exifTags.LensMake).replace(/\0/g, '').trim() || null;
            if (exifTags.LensModel) exif.lensModel = String(exifTags.LensModel).replace(/\0/g, '').trim() || null;

            // GPS — convert DMS arrays to decimal, then truncate to 4dp
            if (Array.isArray(exifTags.GPSLatitude) && exifTags.GPSLatitude.length === 3) {
                const [d, m, s] = exifTags.GPSLatitude;
                let lat = d + m / 60 + s / 3600;
                if (exifTags.GPSLatitudeRef === 'S') lat = -lat;
                exif.gpsLatitude = t4(lat);
            } else if (typeof exifTags.GPSLatitude === 'number') {
                let lat = exifTags.GPSLatitude;
                if (exifTags.GPSLatitudeRef === 'S' && lat > 0) lat = -lat;
                exif.gpsLatitude = t4(lat);
            }
            if (Array.isArray(exifTags.GPSLongitude) && exifTags.GPSLongitude.length === 3) {
                const [d, m, s] = exifTags.GPSLongitude;
                let lon = d + m / 60 + s / 3600;
                if (exifTags.GPSLongitudeRef === 'W') lon = -lon;
                exif.gpsLongitude = t4(lon);
            } else if (typeof exifTags.GPSLongitude === 'number') {
                let lon = exifTags.GPSLongitude;
                if (exifTags.GPSLongitudeRef === 'W' && lon > 0) lon = -lon;
                exif.gpsLongitude = t4(lon);
            }
            if (exifTags.GPSAltitude != null) {
                let alt = Number(exifTags.GPSAltitude);
                if (exifTags.GPSAltitudeRef === 1 && alt > 0) alt = -alt;
                exif.gpsAltitude = t4(alt);
            }

            // Only store if we have meaningful data
            if (!exif.captureTime && !exif.make && exif.gpsLatitude == null) {
                processedSet.add(key);
                continue;
            }

            // Write EXIF sidecar
            const exifData = {
                fileHash: fileHash.slice(0, 64),
                platform: 'server',
                storedAt: new Date().toISOString(),
                userId: 'backfill',
                exif,
            };
            if (exifPath) {
                fs.writeFileSync(exifPath, JSON.stringify(exifData, null, 2), 'utf8');
                stored++;
            }

            processedSet.add(key);

            if (stored % 50 === 0 || (i + 1) % 200 === 0) {
                console.log(`[ExifBackfill] Progress: ${i + 1}/${allFiles.length}, stored=${stored}, skipped=${skipped}, errors=${errors}`);
            }

            // Save cursor every 100 stored
            if (stored % 100 === 0) {
                try {
                    fs.writeFileSync(EXIF_BACKFILL_CURSOR_PATH, JSON.stringify({
                        processedFiles: [...processedSet].slice(-10000),
                        updatedAt: new Date().toISOString(),
                    }));
                } catch (_) {}
            }

            // Throttle: yield to event loop every file (non-blocking)
            await new Promise(r => setImmediate(r));

        } catch (e) {
            errors++;
            processedSet.add(key);
            if (errors <= 5) console.warn(`[ExifBackfill] Error on ${filename}:`, e.message);
        }
    }

    // Save final cursor
    const finalCursor = {
        processedFiles: [...processedSet].slice(-10000),
        completedAt: new Date().toISOString(),
    };
    try { fs.writeFileSync(EXIF_BACKFILL_CURSOR_PATH, JSON.stringify(finalCursor)); } catch (_) {}
    console.log(`[ExifBackfill] Complete. stored=${stored}, skipped=${skipped}, errors=${errors}, total=${allFiles.length}`);

    } finally {
        _exifBackfillRunning = false;
    }
};

// Multer size-cap errors → clean 413 instead of Express' HTML error page.
// Must be registered after all routes to catch their next(err) calls.
app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
        const tooLarge = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'File too large' : 'Upload rejected' });
    }
    next(err);
});

const startHttp = () => {
    const httpServer = http.createServer(app);
    // Disable the whole-request deadline: multi-GB uploads legitimately take
    // far longer than Node's 300s default requestTimeout. headersTimeout still
    // applies, and auth runs before the body is consumed.
    httpServer.requestTimeout = 0;
    httpServer.listen(PORT, HOST, () => {
        console.log(`\n🚀 Secure Backup Server running on ${HOST}:${PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        setTimeout(() => startExifBackfill().catch(e => console.error('[ExifBackfill] Fatal:', e.message)), 30000);
    });
};

const startHttps = () => {
    if (!TLS_KEY_PATH || !TLS_CERT_PATH) {
        console.error('HTTPS enabled but TLS_KEY_PATH or TLS_CERT_PATH is missing. Falling back to HTTP.');
        return startHttp();
    }
    if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
        console.error('HTTPS enabled but TLS key/cert files not found. Falling back to HTTP.');
        return startHttp();
    }

    const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH)
    };

    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.requestTimeout = 0; // same reason as HTTP — long uploads
    httpsServer.listen(HTTPS_PORT, HOST, () => {
        console.log(`\n🔐 HTTPS enabled on ${HOST}:${HTTPS_PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        setTimeout(() => startExifBackfill().catch(e => console.error('[ExifBackfill] Fatal:', e.message)), 30000);
    });

    if (FORCE_HTTPS_REDIRECT) {
        const redirectApp = express();
        redirectApp.use((req, res) => {
            const hostHeader = req.headers.host || '';
            const host = hostHeader.includes(':') ? hostHeader.split(':')[0] : hostHeader;
            const portPart = String(HTTPS_PORT) === '443' ? '' : `:${HTTPS_PORT}`;
            const location = `https://${host}${portPart}${req.originalUrl}`;
            res.redirect(301, location);
        });
        http.createServer(redirectApp).listen(PORT, HOST, () => {
            console.log(`↪️  HTTP redirect enabled on ${HOST}:${PORT} -> HTTPS`);
        });
    }
};

if (ENABLE_HTTPS) startHttps();
else startHttp();
