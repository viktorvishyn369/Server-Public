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
const updater = require('./updater');
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
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-secret-key-change-this';
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

const reserveStealthCloudIncomingBytes = async ({ userId, incomingBytes }) => {
    const inc = typeof incomingBytes === 'number' && Number.isFinite(incomingBytes) ? Math.max(0, incomingBytes) : 0;
    if (inc <= 0) {
        return {
            allowed: true,
            quotaBytes: await getUserQuotaBytes(userId),
            usedBytes: await getUserUsedBytes(userId),
            reservedBytes: Number(cloudUploadReservedBytes.get(String(userId)) || 0) || 0,
            remainingBytes: 0,
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            release: () => {},
        };
    }

    const releaseLock = await acquireCloudUploadLock(userId);
    try {
        const quotaBytes = await getUserQuotaBytes(userId);
        const usedBytes = await getUserUsedBytes(userId);
        const key = String(userId);
        const reservedBytes = Number(cloudUploadReservedBytes.get(key) || 0) || 0;
        const allowed = quotaBytes <= 0 ? true : (usedBytes + reservedBytes + inc + USER_QUOTA_MARGIN_BYTES) <= quotaBytes;
        const remaining = quotaBytes <= 0 ? 0 : Math.max(0, quotaBytes - (usedBytes + reservedBytes));

        if (!allowed) {
            return {
                allowed: false,
                quotaBytes,
                usedBytes,
                reservedBytes,
                remainingBytes: remaining,
                marginBytes: USER_QUOTA_MARGIN_BYTES,
                release: () => {},
            };
        }

        cloudUploadReservedBytes.set(key, reservedBytes + inc);
        let released = false;
        const releaseReservation = () => {
            if (released) return;
            released = true;
            const cur = Number(cloudUploadReservedBytes.get(key) || 0) || 0;
            const next = Math.max(0, cur - inc);
            if (next <= 0) cloudUploadReservedBytes.delete(key);
            else cloudUploadReservedBytes.set(key, next);
        };

        return {
            allowed: true,
            quotaBytes,
            usedBytes,
            reservedBytes: reservedBytes + inc,
            remainingBytes: remaining,
            marginBytes: USER_QUOTA_MARGIN_BYTES,
            release: releaseReservation,
        };
    } finally {
        releaseLock();
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

const SUBSCRIPTION_GRACE_DAYS = Number.parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
const TRIAL_COMPLIMENTARY_DAYS = Number.parseInt(process.env.TRIAL_COMPLIMENTARY_DAYS || '3', 10);
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';
const USER_QUOTA_MARGIN_BYTES = Number.parseInt(process.env.USER_QUOTA_MARGIN_BYTES || String(50 * 1024 * 1024), 10);
const ENABLE_CLOUD_UPLOAD_LOCK = String(process.env.ENABLE_CLOUD_UPLOAD_LOCK || 'true').toLowerCase() !== 'false';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD_BCRYPT = process.env.ADMIN_PASSWORD_BCRYPT || '';
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_HTML_TITLE = 'StealthCloud Admin';

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
app.use(morgan('common')); // Logging
// Allow larger JSON payloads (on-chain SVG data URIs for NFT payment image tokens)
app.use(express.json({ limit: '25mb' }));

// Serve static files from public directory (company website assets)
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Desktop app downloads directory (builds uploaded here become available at /photolynk/download)
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(AUX_ROOT, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) { try { fs.mkdirSync(DOWNLOADS_DIR, { recursive: true }); } catch (_) {} }

// Serve .well-known directory for capacity JSON
app.use('/.well-known', express.static(path.join(AUX_ROOT, '.well-known')));

// Basic IP allowlist helper
const isIpAllowed = (ip) => {
    if (!ADMIN_IP_ALLOWLIST.length) return true;
    const clean = (ip || '').replace('::ffff:', '');
    return ADMIN_IP_ALLOWLIST.includes(clean);
};

// Admin auth middleware (Basic Auth + bcrypt + optional IP allowlist)
const adminAuth = async (req, res, next) => {
    try {
        if (!ADMIN_USER || !ADMIN_PASSWORD_BCRYPT) {
            return res.status(403).send('Admin access not configured');
        }
        if (!isIpAllowed(req.ip)) {
            return res.status(403).send('IP not allowed');
        }
        const header = req.headers['authorization'] || '';
        if (!header.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate', 'Basic').send('Auth required');
        const decoded = Buffer.from(header.split(' ')[1] || '', 'base64').toString('utf8');
        const [user, ...rest] = decoded.split(':');
        const pass = rest.join(':');
        if (user !== ADMIN_USER) return res.status(401).send('Invalid credentials');
        const ok = await bcrypt.compare(pass, ADMIN_PASSWORD_BCRYPT);
        if (!ok) return res.status(401).send('Invalid credentials');
        next();
    } catch (e) {
        return res.status(401).send('Unauthorized');
    }
};

// Admin page (Basic Auth + IP allowlist + no cache)
app.get('/admin', adminAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${ADMIN_HTML_TITLE}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--surface:#111827;--surface2:#1a2236;--border:#1e293b;--border2:#2d3a52;--accent:#4fd1c5;--accent2:#38b2ac;--text:#e2e8f0;--muted:#64748b;--danger:#ef4444;--warn:#f59e0b;--success:#22c55e;--info:#3b82f6;--trial:#8b5cf6;font-family:'Inter',system-ui,-apple-system,sans-serif}
body{background:var(--bg);color:var(--text);min-height:100vh}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.header h1{font-size:18px;font-weight:700;letter-spacing:-0.3px}
.header h1 span{color:var(--accent);font-weight:400}
.header .stats{display:flex;gap:16px;font-size:13px;color:var(--muted)}
.header .stats b{color:var(--text);font-weight:600}
.toolbar{padding:12px 24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--surface);border-bottom:1px solid var(--border)}
.search-box{flex:1;min-width:220px;max-width:480px;position:relative}
.search-box input{width:100%;padding:9px 12px 9px 36px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none;transition:border .15s}
.search-box input:focus{border-color:var(--accent)}
.search-box svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);width:16px;height:16px}
.filter-pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:all .15s}
.pill:hover{border-color:var(--accent);color:var(--text)}
.pill.active{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.pill .count{opacity:.7;margin-left:4px}
.table-wrap{padding:0 24px 24px;overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;margin-top:12px;font-size:13px}
thead th{position:sticky;top:0;background:var(--surface2);color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:10px 12px;text-align:left;border-bottom:2px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
thead th:hover{color:var(--accent)}
thead th .sort-arrow{margin-left:4px;opacity:.4;font-size:10px}
thead th.sorted .sort-arrow{opacity:1;color:var(--accent)}
tbody tr{transition:background .1s}
tbody tr:hover{background:rgba(79,209,197,.04)}
tbody td{padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;letter-spacing:.3px}
.badge-active{background:rgba(34,197,94,.15);color:#4ade80}
.badge-trial{background:rgba(139,92,246,.15);color:#a78bfa}
.badge-grace{background:rgba(245,158,11,.15);color:#fbbf24}
.badge-expired,.badge-trial_expired{background:rgba(239,68,68,.15);color:#f87171}
.badge-none,.badge-deleted{background:rgba(100,116,139,.15);color:#94a3b8}
.email-cell{color:var(--accent);font-weight:500}
.date-cell{color:var(--muted);font-size:12px}
.id-cell{color:var(--muted);font-weight:600;font-size:12px}
.uuid-cell{color:var(--muted);font-size:11px;max-width:90px;overflow:hidden;text-overflow:ellipsis;cursor:pointer;font-family:monospace;letter-spacing:-.3px}
.uuid-cell:hover{color:var(--accent)}
.plan-cell{font-weight:700}
.actions-cell{display:flex;gap:4px}
.btn-sm{padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text);transition:all .15s}
.btn-sm:hover{border-color:var(--accent);color:var(--accent)}
.btn-danger{border-color:rgba(239,68,68,.3);color:var(--danger)}
.btn-danger:hover{background:rgba(239,68,68,.1);border-color:var(--danger)}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:24px;width:520px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.modal h2{font-size:16px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.modal .close-btn{margin-left:auto;background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:4px 8px;border-radius:6px}
.modal .close-btn:hover{color:var(--text);background:rgba(255,255,255,.05)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group.full{grid-column:1/-1}
.form-group label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.form-group input,.form-group select{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none}
.form-group input:focus,.form-group select:focus{border-color:var(--accent)}
.modal-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.btn{padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.btn-primary{background:var(--accent);color:var(--bg)}
.btn-primary:hover{background:var(--accent2)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-ghost:hover{border-color:var(--muted)}
.btn-red{background:var(--danger);color:#fff}
.btn-red:hover{background:#dc2626}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;z-index:300;animation:slideIn .3s ease;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.toast-success{background:var(--success);color:#fff}
.toast-error{background:var(--danger);color:#fff}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
.empty-state{text-align:center;padding:60px 20px;color:var(--muted)}
.empty-state svg{width:48px;height:48px;margin-bottom:12px;opacity:.3}
.loading{text-align:center;padding:40px;color:var(--muted)}
.payment-badge{font-size:11px;padding:2px 6px;border-radius:6px;font-weight:600}
.payment-apple{background:rgba(255,255,255,.08);color:#e2e8f0}
.payment-google{background:rgba(59,130,246,.15);color:#60a5fa}
.payment-solana{background:rgba(139,92,246,.15);color:#a78bfa}
.nft-premium{background:rgba(153,69,255,.15);color:#b794f6}
.nft-deposit{background:rgba(34,197,94,.12);color:#4ade80}
.storage-bar{width:80px;height:6px;background:rgba(255,255,255,.06);border-radius:3px;display:inline-block;vertical-align:middle;margin-left:6px}
.storage-fill{height:100%;border-radius:3px;background:var(--accent);transition:width .2s}
.storage-fill.warn{background:var(--warn)}
.storage-fill.full{background:var(--danger)}
.money-cell{font-weight:600;font-size:12px;color:#4ade80}
.money-cell.zero{color:var(--muted);font-weight:400}
.nft-count{font-size:12px;font-weight:600;color:var(--accent)}
.login-active{color:#4ade80}
.login-stale{color:var(--warn)}
.login-inactive{color:var(--danger)}
.detail-row{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.mini-tag{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,.04);color:var(--muted);white-space:nowrap}
</style>
</head>
<body>
<div class="header">
  <h1>StealthCloud <span>Admin</span></h1>
  <div class="stats" id="header-stats"></div>
</div>
<div class="toolbar">
  <div class="search-box">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" id="search" placeholder="Search by email, ID, status, plan, payment..." oninput="applyFilters()"/>
  </div>
  <div class="filter-pills" id="status-filters"></div>
</div>
<div class="table-wrap">
  <div id="loading" class="loading">Loading users...</div>
  <table id="users-table" style="display:none">
    <thead><tr>
      <th data-col="id" onclick="sortBy('id')">ID <span class="sort-arrow">&#9650;</span></th>
      <th data-col="email" onclick="sortBy('email')">Email <span class="sort-arrow">&#9650;</span></th>
      <th data-col="device_uuids" onclick="sortBy('device_uuids')">Device UUID <span class="sort-arrow">&#9650;</span></th>
      <th data-col="last_login" onclick="sortBy('last_login')">Last Login <span class="sort-arrow">&#9650;</span></th>
      <th data-col="storage_used" onclick="sortBy('storage_used')">Storage <span class="sort-arrow">&#9650;</span></th>
      <th data-col="plan_gb" onclick="sortBy('plan_gb')">Plan <span class="sort-arrow">&#9650;</span></th>
      <th data-col="status" onclick="sortBy('status')">Status <span class="sort-arrow">&#9650;</span></th>
      <th data-col="nft_mints" onclick="sortBy('nft_mints')">NFTs <span class="sort-arrow">&#9650;</span></th>
      <th data-col="total_paid" onclick="sortBy('total_paid')">Total Paid <span class="sort-arrow">&#9650;</span></th>
      <th data-col="payment_type" onclick="sortBy('payment_type')">Pay Type <span class="sort-arrow">&#9650;</span></th>
      <th data-col="created_at" onclick="sortBy('created_at')">Registered <span class="sort-arrow">&#9650;</span></th>
      <th data-col="expires_at" onclick="sortBy('expires_at')">Expires <span class="sort-arrow">&#9650;</span></th>
      <th data-col="updated_at" onclick="sortBy('updated_at')">Updated <span class="sort-arrow">&#9650;</span></th>
      <th>Actions</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div id="empty" class="empty-state" style="display:none">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0"/></svg>
    <p>No users match your search</p>
  </div>
</div>

<div class="modal-overlay" id="edit-modal">
  <div class="modal">
    <h2>Edit User <span id="edit-title" style="color:var(--accent)"></span>
      <button class="close-btn" onclick="closeModal()">&times;</button>
    </h2>
    <div class="form-grid">
      <div class="form-group"><label>User ID</label><input id="e-id" readonly style="opacity:.6"/></div>
      <div class="form-group"><label>Email</label><input id="e-email" readonly style="opacity:.6"/></div>
      <div class="form-group full"><label>UUID</label><input id="e-uuid" readonly style="opacity:.6;font-family:monospace;font-size:12px" onclick="this.select();document.execCommand('copy');toast('UUID copied','success')"/></div>
      <div class="form-group"><label>Plan GB</label>
        <select id="e-planGb"><option value="">unchanged</option><option value="100">100 GB</option><option value="200">200 GB</option><option value="400">400 GB</option><option value="1000">1 TB</option></select>
      </div>
      <div class="form-group"><label>Status</label>
        <select id="e-status"><option value="">unchanged</option><option value="active">active</option><option value="trial">trial</option><option value="grace">grace</option><option value="expired">expired</option><option value="deleted">deleted</option><option value="none">none</option></select>
      </div>
      <div class="form-group"><label>Extend Trial (days)</label><input id="e-extTrialDays" type="number" placeholder="e.g. 7"/></div>
      <div class="form-group"><label>Extend Expires (days)</label><input id="e-extExpDays" type="number" placeholder="e.g. 30"/></div>
      <div class="form-group"><label>Trial Until (epoch ms)</label><input id="e-trialUntil" placeholder="absolute epoch"/></div>
      <div class="form-group"><label>Expires At (epoch ms)</label><input id="e-expiresAt" placeholder="absolute epoch"/></div>
      <div class="form-group"><label>Grace Until (epoch ms)</label><input id="e-graceUntil" placeholder="absolute epoch"/></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEdit()">Save Changes</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="delete-modal">
  <div class="modal">
    <h2 style="color:var(--danger)">Delete User <span id="del-title" style="color:var(--danger)"></span>
      <button class="close-btn" onclick="closeDeleteModal()">&times;</button>
    </h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:12px">This will permanently delete the user, their devices, plan, cloud chunks from DB, and optionally files from disk. This cannot be undone.</p>
    <input type="hidden" id="del-id"/>
    <div class="form-group" style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="del-files" checked style="width:auto;accent-color:var(--danger)"/>
      <label style="font-size:13px;color:var(--text);text-transform:none;letter-spacing:0">Also delete files from disk</label>
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn btn-ghost" onclick="closeDeleteModal()">Cancel</button>
      <button class="btn btn-red" onclick="confirmDelete()">Delete Permanently</button>
    </div>
  </div>
</div>

<script>
var allUsers=[];var filteredUsers=[];var sortCol='id';var sortDir='desc';var activeFilter='all';var serverTime='';

function fmtDate(iso){if(!iso)return'<span class="date-cell">-</span>';var d=new Date(iso);var now=new Date();var diff=d-now;var s=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});if(diff<0&&diff>-86400000*3)s='<span style="color:var(--warn)">'+s+'</span>';else if(diff<0)s='<span style="color:var(--danger)">'+s+'</span>';return'<span class="date-cell">'+s+'</span>'}

function fmtLogin(iso){if(!iso)return'<span class="date-cell login-inactive">Never</span>';var d=new Date(iso);var now=new Date();var ago=now-d;var mins=Math.floor(ago/60000);var hrs=Math.floor(ago/3600000);var days=Math.floor(ago/86400000);var label='';if(mins<5)label='Just now';else if(mins<60)label=mins+'m ago';else if(hrs<24)label=hrs+'h ago';else if(days<30)label=days+'d ago';else label=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});var cls=ago<3600000?'login-active':ago<86400000*7?'login-stale':'login-inactive';return'<span class="date-cell '+cls+'" title="'+d.toLocaleString()+'">'+label+'</span>'}

function fmtBytes(b){if(!b||b<=0)return'0';if(b<1048576)return(b/1024).toFixed(0)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB'}

function storageCell(used,quota){var usedStr=fmtBytes(used);var quotaStr=quota>0?fmtBytes(quota):'0';var pct=quota>0?Math.min(100,Math.round(used/quota*100)):0;var cls=pct>=90?'full':pct>=70?'warn':'';return'<span style="font-size:11px">'+usedStr+' / '+quotaStr+'</span><div class="storage-bar"><div class="storage-fill '+cls+'" style="width:'+pct+'%"></div></div>'}

function statusBadge(st){var c='badge-'+(st||'none').replace(/\\s/g,'_');return'<span class="badge '+c+'">'+(st||'none')+'</span>'}

function paymentBadges(u){var tags=[];if(u.payment_type){tags.push('<span class="payment-badge payment-'+(u.payment_type||'').toLowerCase()+'">'+u.payment_type+'</span>')}if(u.nft_is_premium){tags.push('<span class="payment-badge nft-premium">Premium</span>')}if(u.nft_payments&&u.nft_payments.length>0){var types={};u.nft_payments.forEach(function(p){var k=(p.platform||'iap')+':'+(p.type||'');types[k]=(types[k]||0)+1});Object.keys(types).forEach(function(k){var parts=k.split(':');tags.push('<span class="mini-tag">'+parts[0]+' x'+types[k]+'</span>')})}if(u.sol_payments&&u.sol_payments.length>0){tags.push('<span class="payment-badge payment-solana">SOL x'+u.sol_payments.length+'</span>')}return tags.length?tags.join(' '):'<span class="date-cell">-</span>'}

function totalPaidCell(u){var parts=[];var iap=u.nft_total_paid||0;var sol=u.sol_total_paid||0;if(iap>0)parts.push('$'+iap.toFixed(2));if(sol>0)parts.push(sol.toFixed(4)+' SOL');if(!parts.length)return'<span class="money-cell zero">-</span>';return'<span class="money-cell">'+parts.join('<br>')+'</span>'}

function planLabel(gb){if(!gb)return'-';return gb>=1000?(gb/1000)+'TB':gb+'GB'}

function toast(msg,type){var el=document.createElement('div');el.className='toast toast-'+(type||'success');el.textContent=msg;document.body.appendChild(el);setTimeout(function(){el.remove()},3000)}

async function loadUsers(){
  try{
    var r=await fetch('/admin/api/users');var d=await r.json();
    if(!r.ok)throw new Error(d.error||'Failed');
    serverTime=d.server_time||'';
    allUsers=d.users.map(function(u){return{id:u.id,email:u.email||'',user_uuid:u.user_uuid||'',device_uuids:u.device_uuids||'',last_login:u.last_login||0,last_login_date:u.last_login_date,storage_used:u.storage_used_bytes||0,storage_quota:u.storage_quota_bytes||0,file_count:u.file_count||0,plan_gb:u.plan.plan_gb||0,premium_gb:u.plan.premium_gb||0,status:u.plan.status||'none',trial_until:u.plan.trial_until,trial_until_date:u.plan.trial_until_date,expires_at:u.plan.expires_at,expires_at_date:u.plan.expires_at_date,grace_until:u.plan.grace_until,created_at:u.user_created_at,created_at_date:u.user_created_at_date,payment_type:u.plan.payment_type||'',payment_at:u.plan.payment_at,payment_at_date:u.plan.payment_at_date,updated_at:u.plan.updated_at,updated_at_date:u.plan.updated_at_date,nft_is_premium:u.nft.is_premium,nft_mints:u.nft.mint_count||0,nft_free_remaining:u.nft.free_mints_remaining||0,nft_balance:u.nft.balance_usd||0,nft_total_paid:u.nft.total_paid_usd||0,nft_total_purchased:u.nft.total_purchased_usd||0,nft_total_spent:u.nft.total_spent_usd||0,nft_payments:u.nft.payments||[],sol_payments:u.solana.payments||[],sol_total_paid:u.solana.total_paid_sol||0,total_paid:(u.nft.total_paid_usd||0)+(u.solana.total_paid_sol||0)*100}});
    updateStats();buildFilters();applyFilters();
    document.getElementById('loading').style.display='none';
    document.getElementById('users-table').style.display='';
  }catch(e){document.getElementById('loading').textContent='Error: '+e.message}
}

function updateStats(){
  var total=allUsers.length;
  var active=allUsers.filter(function(u){return u.status==='active'}).length;
  var trial=allUsers.filter(function(u){return u.status==='trial'||u.status==='trial_complimentary'}).length;
  var paying=allUsers.filter(function(u){return u.total_paid>0}).length;
  var premium=allUsers.filter(function(u){return u.nft_is_premium}).length;
  var totalRev=allUsers.reduce(function(s,u){return s+(u.nft_total_paid||0)},0);
  var recentLogin=allUsers.filter(function(u){return u.last_login&&(Date.now()-u.last_login)<86400000*7}).length;
  var st=serverTime?'<span>Server: <b>'+new Date(serverTime).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'</b></span>':'';
  document.getElementById('header-stats').innerHTML=st+'<span>Total: <b>'+total+'</b></span><span>Active: <b>'+active+'</b></span><span>Trial: <b>'+trial+'</b></span><span>Paying: <b>'+paying+'</b></span><span>Premium: <b>'+premium+'</b></span><span>7d Active: <b>'+recentLogin+'</b></span><span>Revenue: <b>$'+totalRev.toFixed(2)+'</b></span>';
}

function buildFilters(){
  var counts={};allUsers.forEach(function(u){var s=u.status||'none';counts[s]=(counts[s]||0)+1});
  var html='<button class="pill active" data-f="all" onclick="setFilter(this,&apos;all&apos;)">All<span class="count">'+allUsers.length+'</span></button>';
  var order=['active','trial','trial_complimentary','grace','expired','trial_expired','trial_complimentary_expired','none','deleted'];
  order.forEach(function(s){if(counts[s])html+='<button class="pill" data-f="'+s+'" onclick="setFilter(this,&apos;'+s+'&apos;)">'+s+'<span class="count">'+counts[s]+'</span></button>'});
  // Special filters
  var premCount=allUsers.filter(function(u){return u.nft_is_premium}).length;
  var paidCount=allUsers.filter(function(u){return u.total_paid>0}).length;
  if(premCount)html+='<button class="pill" data-f="premium" onclick="setFilter(this,&apos;premium&apos;)">premium<span class="count">'+premCount+'</span></button>';
  if(paidCount)html+='<button class="pill" data-f="paid" onclick="setFilter(this,&apos;paid&apos;)">paid<span class="count">'+paidCount+'</span></button>';
  document.getElementById('status-filters').innerHTML=html;
}

function setFilter(el,f){
  activeFilter=f;
  document.querySelectorAll('.pill').forEach(function(p){p.classList.remove('active')});
  el.classList.add('active');
  applyFilters();
}

function applyFilters(){
  var q=(document.getElementById('search').value||'').toLowerCase().trim();
  filteredUsers=allUsers.filter(function(u){
    if(activeFilter==='premium')return u.nft_is_premium;
    if(activeFilter==='paid')return u.total_paid>0;
    if(activeFilter!=='all'&&u.status!==activeFilter)return false;
    if(!q)return true;
    return(String(u.id).includes(q)||u.email.toLowerCase().includes(q)||(u.status||'').toLowerCase().includes(q)||String(u.plan_gb).includes(q)||(u.payment_type||'').toLowerCase().includes(q)||(u.device_uuids||'').toLowerCase().includes(q)||(u.user_uuid||'').toLowerCase().includes(q));
  });
  doSort();renderTable();
}

function sortBy(col){
  if(sortCol===col)sortDir=sortDir==='asc'?'desc':'asc';
  else{sortCol=col;sortDir=col==='id'||col==='total_paid'||col==='nft_mints'||col==='storage_used'||col==='last_login'?'desc':'asc'}
  document.querySelectorAll('thead th').forEach(function(th){th.classList.remove('sorted');if(th.dataset.col===col)th.classList.add('sorted')});
  document.querySelectorAll('.sort-arrow').forEach(function(a){a.innerHTML='&#9650;'});
  var th=document.querySelector('th[data-col="'+col+'"]');
  if(th)th.querySelector('.sort-arrow').innerHTML=sortDir==='asc'?'&#9650;':'&#9660;';
  doSort();renderTable();
}

function doSort(){
  filteredUsers.sort(function(a,b){
    var va=a[sortCol],vb=b[sortCol];
    if(va==null)va='';if(vb==null)vb='';
    if(typeof va==='number'&&typeof vb==='number')return sortDir==='asc'?va-vb:vb-va;
    va=String(va).toLowerCase();vb=String(vb).toLowerCase();
    if(va<vb)return sortDir==='asc'?-1:1;
    if(va>vb)return sortDir==='asc'?1:-1;
    return 0;
  });
}

function renderTable(){
  var tbody=document.getElementById('tbody');
  var empty=document.getElementById('empty');
  if(!filteredUsers.length){tbody.innerHTML='';empty.style.display='';return}
  empty.style.display='none';
  var html='';
  filteredUsers.forEach(function(u){
    html+='<tr>';
    html+='<td class="id-cell">#'+u.id+'</td>';
    html+='<td class="email-cell" title="'+u.email+'">'+u.email+'</td>';
    html+='<td class="uuid-cell" title="'+(u.device_uuids||'')+'" onclick="copyUuid(this,&apos;'+((u.device_uuids||'').replace(/'/g,'&apos;'))+'&apos;)">'+((u.device_uuids||'').substring(0,13)||'-')+'</td>';
    html+='<td>'+fmtLogin(u.last_login_date)+'</td>';
    html+='<td>'+storageCell(u.storage_used,u.storage_quota)+'</td>';
    var planStr=planLabel(u.plan_gb);if(u.premium_gb)planStr+=' <span class="payment-badge nft-premium" style="font-size:9px">+'+u.premium_gb+'GB</span>';
    html+='<td class="plan-cell">'+planStr+'</td>';
    html+='<td>'+statusBadge(u.status)+'</td>';
    var nftStr=u.nft_mints>0?'<span class="nft-count">'+u.nft_mints+'</span>':'<span class="date-cell">0</span>';
    if(u.nft_is_premium)nftStr+=' <span class="payment-badge nft-premium" style="font-size:9px">P</span>';
    if(u.nft_free_remaining>0)nftStr+='<br><span class="mini-tag">'+u.nft_free_remaining+' free left</span>';
    html+='<td>'+nftStr+'</td>';
    html+='<td>'+totalPaidCell(u)+'</td>';
    html+='<td>'+paymentBadges(u)+'</td>';
    html+='<td>'+fmtDate(u.created_at_date)+'</td>';
    html+='<td>'+fmtDate(u.expires_at_date)+'</td>';
    html+='<td>'+fmtDate(u.updated_at_date)+'</td>';
    html+='<td class="actions-cell">';
    html+='<button class="btn-sm" onclick="openEdit('+u.id+')">Edit</button>';
    html+='<button class="btn-sm btn-danger" onclick="openDelete('+u.id+',&apos;'+u.email.replace(/'/g,'&apos;')+'&apos;)">&times;</button>';
    html+='</td></tr>';
  });
  tbody.innerHTML=html;
}

function openEdit(id){
  var u=allUsers.find(function(x){return x.id===id});if(!u)return;
  document.getElementById('e-id').value=u.id;
  document.getElementById('e-email').value=u.email;
  document.getElementById('e-uuid').value=u.user_uuid||'';
  document.getElementById('e-planGb').value='';
  document.getElementById('e-status').value='';
  document.getElementById('e-extTrialDays').value='';
  document.getElementById('e-extExpDays').value='';
  document.getElementById('e-trialUntil').value='';
  document.getElementById('e-expiresAt').value='';
  document.getElementById('e-graceUntil').value='';
  document.getElementById('edit-title').textContent='#'+u.id+' '+u.email;
  document.getElementById('edit-modal').classList.add('open');
}
function closeModal(){document.getElementById('edit-modal').classList.remove('open')}

async function saveEdit(){
  var uid=Number(document.getElementById('e-id').value);
  var payload={userId:uid};
  var v;
  v=document.getElementById('e-planGb').value;if(v)payload.planGb=Number(v);
  v=document.getElementById('e-status').value;if(v)payload.status=v;
  v=document.getElementById('e-extTrialDays').value;if(v)payload.extendTrialDays=Number(v);
  v=document.getElementById('e-extExpDays').value;if(v)payload.extendExpiresDays=Number(v);
  v=document.getElementById('e-trialUntil').value;if(v)payload.trialUntil=Number(v);
  v=document.getElementById('e-expiresAt').value;if(v)payload.expiresAt=Number(v);
  v=document.getElementById('e-graceUntil').value;if(v)payload.graceUntil=Number(v);
  try{
    var r=await fetch('/admin/api/user/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    var d=await r.json();
    if(!r.ok)throw new Error(d.error||'Failed');
    toast('User #'+uid+' updated','success');closeModal();loadUsers();
  }catch(e){toast('Error: '+e.message,'error')}
}

function openDelete(id,email){
  document.getElementById('del-id').value=id;
  document.getElementById('del-title').textContent='#'+id+' '+email;
  document.getElementById('delete-modal').classList.add('open');
}
function closeDeleteModal(){document.getElementById('delete-modal').classList.remove('open')}

async function confirmDelete(){
  var uid=Number(document.getElementById('del-id').value);
  var delFiles=document.getElementById('del-files').checked;
  try{
    var r=await fetch('/admin/api/user/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:uid,deleteFiles:delFiles})});
    var d=await r.json();
    if(!r.ok)throw new Error(d.error||'Failed');
    toast('User #'+uid+' deleted','success');closeDeleteModal();loadUsers();
  }catch(e){toast('Error: '+e.message,'error')}
}

function copyUuid(el,uuid){if(!uuid||uuid==='-')return;navigator.clipboard.writeText(uuid).then(function(){toast('UUID copied','success')}).catch(function(){var t=document.createElement('textarea');t.value=uuid;document.body.appendChild(t);t.select();document.execCommand('copy');document.body.removeChild(t);toast('UUID copied','success')})}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeModal();closeDeleteModal()}});
loadUsers();
</script>
</body>
</html>`;
    res.send(html);
});

// Admin API: lookup user (email | userUuid | deviceUuid)
app.get('/admin/api/user', adminAuth, async (req, res) => {
    try {
        const email = (req.query.email || '').toString().trim().toLowerCase();
        const userUuid = (req.query.userUuid || req.query.user_uuid || '').toString().trim();
        const deviceUuid = (req.query.deviceUuid || req.query.device_uuid || '').toString().trim();
        if (!email && !userUuid && !deviceUuid) {
            return res.status(400).json({ error: 'email, userUuid, or deviceUuid required' });
        }

        let user = null;
        if (email) {
            user = await dbGetAsync(`SELECT * FROM users WHERE lower(email) = ?`, [email]);
        }
        if (!user && userUuid) {
            user = await dbGetAsync(`SELECT * FROM users WHERE user_uuid = ?`, [userUuid]);
        }
        if (!user && deviceUuid) {
            user = await dbGetAsync(
                `SELECT u.* FROM users u
                  JOIN devices d ON u.id = d.user_id
                 WHERE d.device_uuid = ?
                 LIMIT 1`,
                [deviceUuid]
            );
        }

        if (!user) return res.status(404).json({ error: 'User not found' });

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [user.id]);
        const payments = await dbAllAsync(
            `SELECT * FROM solana_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [user.id]
        );

        return res.json({ user, plan, payments });
    } catch (e) {
        console.error('[Admin] lookup error', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Admin API: update plan fields
app.post('/admin/api/user/plan', adminAuth, async (req, res) => {
    try {
        const {
            userId,
            planGb,
            extendExpiresDays,
            extendTrialDays,
            expiresAt,
            graceUntil,
            trialUntil,
            status,
        } = req.body || {};

        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) return res.status(400).json({ error: 'userId required' });

        const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [uid]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        await ensurePlanRow(uid);

        const currentPlan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);

        const updates = [];
        const params = [];
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;

        if (planGb !== undefined && planGb !== null && planGb !== '') {
            const normalized = normalizeTierGb(planGb);
            if (!normalized) return res.status(400).json({ error: 'Invalid planGb' });
            updates.push('plan_gb = ?');
            params.push(normalized);
        }
        const numericOrNull = (v) => {
            if (v === undefined || v === null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };

        // Handle extend expires by days
        if (extendExpiresDays !== undefined && extendExpiresDays !== null && extendExpiresDays !== '') {
            const days = Number(extendExpiresDays);
            if (!Number.isFinite(days)) return res.status(400).json({ error: 'Invalid extendExpiresDays' });
            const currentExpires = currentPlan?.expires_at || now;
            const baseTime = currentExpires > now ? currentExpires : now;
            updates.push('expires_at = ?');
            params.push(baseTime + days * DAY_MS);
        }

        // Handle extend trial by days
        if (extendTrialDays !== undefined && extendTrialDays !== null && extendTrialDays !== '') {
            const days = Number(extendTrialDays);
            if (!Number.isFinite(days)) return res.status(400).json({ error: 'Invalid extendTrialDays' });
            const currentTrial = currentPlan?.trial_until || now;
            const baseTime = currentTrial > now ? currentTrial : now;
            updates.push('trial_until = ?');
            params.push(baseTime + days * DAY_MS);
        }

        // Absolute epoch values (override extend if both provided)
        const exp = numericOrNull(expiresAt);
        if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
            if (exp === null) return res.status(400).json({ error: 'Invalid expiresAt' });
            updates.push('expires_at = ?');
            params.push(exp);
        }
        const gu = numericOrNull(graceUntil);
        if (graceUntil !== undefined && graceUntil !== null && graceUntil !== '') {
            if (gu === null) return res.status(400).json({ error: 'Invalid graceUntil' });
            updates.push('grace_until = ?');
            params.push(gu);
        }
        const tu = numericOrNull(trialUntil);
        if (trialUntil !== undefined && trialUntil !== null && trialUntil !== '') {
            if (tu === null) return res.status(400).json({ error: 'Invalid trialUntil' });
            updates.push('trial_until = ?');
            params.push(tu);
        }
        if (status !== undefined && status !== null && status !== '') {
            const allowed = new Set(['active', 'trial', 'grace', 'expired', 'deleted', 'none']);
            if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' });
            updates.push('status = ?');
            params.push(String(status));
        }

        if (!updates.length) return res.status(400).json({ error: 'No updates provided' });

        updates.push('updated_at = ?');
        params.push(now, uid);

        const sql = `UPDATE user_plans SET ${updates.join(', ')} WHERE user_id = ?`;
        await dbRunAsync(sql, params);

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [uid]);
        return res.json({ ok: true, plan });
    } catch (e) {
        console.error('[Admin] plan update error', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Admin API: list all users with plans
app.get('/admin/api/users', adminAuth, async (req, res) => {
    try {
        // Get all users with their plans, last login, and storage usage
        const users = await dbAllAsync(`
            SELECT 
                u.id,
                u.email,
                u.user_uuid,
                u.created_at AS user_created_at,
                GROUP_CONCAT(DISTINCT d.device_uuid) AS device_uuids,
                MAX(d.last_seen) AS last_login,
                p.plan_gb,
                p.premium_gb,
                p.status as plan_status,
                p.trial_until,
                p.expires_at,
                p.grace_until,
                p.payment_type,
                p.payment_at,
                p.updated_at as plan_updated_at,
                COALESCE(cc.storage_used, 0) AS storage_used_bytes,
                COALESCE(fc.file_count, 0) AS file_count
            FROM users u
            LEFT JOIN user_plans p ON u.id = p.user_id
            LEFT JOIN devices d ON u.id = d.user_id
            LEFT JOIN (SELECT user_id, SUM(size) AS storage_used FROM cloud_chunks GROUP BY user_id) cc ON u.id = cc.user_id
            LEFT JOIN (SELECT user_id, COUNT(*) AS file_count FROM files GROUP BY user_id) fc ON u.id = fc.user_id
            GROUP BY u.id
            ORDER BY u.id DESC
        `);

        // Try to get NFT service data (payments, premium, mint counts)
        let nftPaymentsByUser = {};
        let nftPremiumByUser = {};
        let nftBalanceByUser = {};
        let solanaPaymentsByUser = {};
        try {
            const nftService = require('../nft-service');
            nftService.balance.init();
            // Get all NFT payments
            const allPayments = nftService.balance.getAllPayments();
            for (const p of allPayments) {
                if (!nftPaymentsByUser[p.user_id]) nftPaymentsByUser[p.user_id] = [];
                nftPaymentsByUser[p.user_id].push(p);
            }
            // Get premium + balance for each user
            for (const u of users) {
                try {
                    nftPremiumByUser[u.id] = nftService.balance.getPremiumStatus(u.id);
                } catch (_) {}
                try {
                    nftBalanceByUser[u.id] = nftService.balance.getBalance(u.id);
                } catch (_) {}
            }
        } catch (_) { /* nft-service not available */ }

        // Get Solana payments
        try {
            const solPayments = await dbAllAsync(`SELECT user_id, sol_amount, tier_gb, duration, created_at, verified_at FROM solana_payments ORDER BY created_at DESC`);
            for (const sp of solPayments) {
                if (!solanaPaymentsByUser[sp.user_id]) solanaPaymentsByUser[sp.user_id] = [];
                solanaPaymentsByUser[sp.user_id].push(sp);
            }
        } catch (_) {}

        const formattedUsers = users.map(user => {
            const nftPayments = nftPaymentsByUser[user.id] || [];
            const premium = nftPremiumByUser[user.id] || {};
            const balance = nftBalanceByUser[user.id] || {};
            const solPayments = solanaPaymentsByUser[user.id] || [];
            const totalNftPaid = nftPayments.reduce((s, p) => s + (p.amount_usd || 0), 0);
            const totalSolPaid = solPayments.reduce((s, p) => s + (p.sol_amount || 0), 0);
            // Compute effective storage quota in bytes
            const planQuotaBytes = (user.plan_gb || 0) * 1073741824;
            const premiumQuotaBytes = premium.cloudQuotaBytes || ((user.premium_gb || 0) * 1073741824);
            const totalQuotaBytes = planQuotaBytes + premiumQuotaBytes;

            return {
                id: user.id,
                email: user.email,
                user_uuid: user.user_uuid,
                device_uuids: user.device_uuids || null,
                user_created_at: user.user_created_at,
                user_created_at_date: user.user_created_at ? new Date(user.user_created_at).toISOString() : null,
                last_login: user.last_login,
                last_login_date: user.last_login ? new Date(user.last_login).toISOString() : null,
                storage_used_bytes: user.storage_used_bytes || 0,
                storage_quota_bytes: totalQuotaBytes,
                file_count: user.file_count || 0,
                plan: {
                    plan_gb: user.plan_gb,
                    premium_gb: user.premium_gb,
                    status: user.plan_status,
                    trial_until: user.trial_until,
                    trial_until_date: user.trial_until ? new Date(user.trial_until).toISOString() : null,
                    expires_at: user.expires_at,
                    expires_at_date: user.expires_at ? new Date(user.expires_at).toISOString() : null,
                    grace_until: user.grace_until,
                    payment_type: user.payment_type,
                    payment_at: user.payment_at,
                    payment_at_date: user.payment_at ? new Date(user.payment_at).toISOString() : null,
                    updated_at: user.plan_updated_at,
                    updated_at_date: user.plan_updated_at ? new Date(user.plan_updated_at).toISOString() : null,
                },
                nft: {
                    is_premium: !!(premium.isPremium),
                    mint_count: premium.mintCount || 0,
                    free_mints_remaining: premium.freeMintsRemaining || 0,
                    balance_usd: balance.balance_usd || 0,
                    total_purchased_usd: balance.total_purchased_usd || 0,
                    total_spent_usd: balance.total_spent_usd || 0,
                    payments: nftPayments.map(p => ({ type: p.payment_type, amount: p.amount_usd, platform: p.platform, date: p.created_at })),
                    total_paid_usd: totalNftPaid,
                },
                solana: {
                    payments: solPayments.map(sp => ({ sol: sp.sol_amount, tier_gb: sp.tier_gb, duration: sp.duration, date: sp.created_at ? new Date(sp.created_at).toISOString() : null })),
                    total_paid_sol: totalSolPaid,
                },
            };
        });

        return res.json({
            total_users: formattedUsers.length,
            server_time: new Date().toISOString(),
            users: formattedUsers,
        });
    } catch (e) {
        console.error('[Admin] list users error', e);
        return res.status(500).json({ error: 'Server error', details: e?.message });
    }
});

// Admin API: delete user completely
app.post('/admin/api/user/delete', adminAuth, async (req, res) => {
    try {
        const { userId, deleteFiles } = req.body;
        
        if (!userId || typeof userId !== 'number') {
            return res.status(400).json({ error: 'userId (number) required' });
        }

        // Get user info first
        const user = await dbGetAsync(`SELECT * FROM users WHERE id = ?`, [userId]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get all devices for this user
        const devices = await dbAllAsync(`SELECT * FROM devices WHERE user_id = ?`, [userId]);
        
        // Get user key for file deletion
        const userKey = user.user_uuid || String(userId);
        
        const deletedItems = {
            user: user.email || user.user_uuid,
            userId: userId,
            devices: devices.length,
            filesDeleted: false,
            directories: []
        };

        // Delete files from disk if requested
        if (deleteFiles) {
            const dirsToDelete = new Set();
            
            // Collect all possible user keys (old uuid folders + new numeric id folders)
            const possibleKeys = new Set();
            possibleKeys.add(String(userId)); // numeric user id
            if (user.user_uuid) possibleKeys.add(user.user_uuid); // user_uuid
            
            // Also add device UUIDs as they may have been used as folder keys
            for (const device of devices) {
                if (device.device_uuid) {
                    possibleKeys.add(device.device_uuid);
                }
            }
            
            // Check all possible keys in CLOUD_DIR/users/
            for (const key of possibleKeys) {
                const cloudDir = path.join(CLOUD_DIR, 'users', key);
                if (fs.existsSync(cloudDir)) {
                    dirsToDelete.add(cloudDir);
                }
            }
            
            // Check all possible keys in CHUNKS_DIR/users/ (if separate)
            if (CHUNKS_DIR) {
                for (const key of possibleKeys) {
                    const chunksDir = path.join(CHUNKS_DIR, 'users', key);
                    if (fs.existsSync(chunksDir)) {
                        dirsToDelete.add(chunksDir);
                    }
                }
            }
            
            // Device upload directories in UPLOAD_DIR
            for (const device of devices) {
                if (device.device_uuid) {
                    const deviceDir = path.join(UPLOAD_DIR, device.device_uuid);
                    if (fs.existsSync(deviceDir)) {
                        dirsToDelete.add(deviceDir);
                    }
                }
            }
            
            // Delete all found directories
            for (const dir of dirsToDelete) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                    deletedItems.directories.push(dir);
                    console.log(`[Admin Delete] Removed directory: ${dir}`);
                } catch (e) {
                    console.error(`[Admin Delete] Failed to remove ${dir}:`, e.message);
                }
            }
            
            deletedItems.filesDeleted = dirsToDelete.size > 0;
            deletedItems.keysChecked = Array.from(possibleKeys);
        }

        // Delete from database (order matters due to foreign keys)
        await dbRunAsync(`DELETE FROM cloud_chunks WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM user_plans WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM devices WHERE user_id = ?`, [userId]);
        await dbRunAsync(`DELETE FROM users WHERE id = ?`, [userId]);

        console.log(`[Admin Delete] User ${userId} (${user.email || user.user_uuid}) deleted completely`);
        
        return res.json({ 
            ok: true, 
            message: `User ${userId} deleted successfully`,
            deleted: deletedItems
        });
    } catch (e) {
        console.error('[Admin] delete user error', e);
        return res.status(500).json({ error: 'Server error', details: e?.message });
    }
});

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
 * the user seamlessly. Also renames NFT folders.
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
    const nftRoot = path.join(CLOUD_DIR, 'nft');

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
        // NFT dir
        safeRename(path.join(nftRoot, oldKey), path.join(nftRoot, safeNew), 'nft');
    }

    console.log(`[FolderMigrate] User ${userId} (${userEmail || '?'}): migrated folders from [${[...oldKeys].join(', ')}] -> ${safeNew}`);
};

const resolveClassicFileForUser = async (user, filename) => {
    const safeName = path.basename(filename || '').replace(/\0/g, '');
    if (!safeName) return null;
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

const resolveSubscriptionState = async (userId) => {
    const now = Date.now();
    const row = await ensurePlanRow(userId);
    if (!row) return { allowed: false, status: 'none', premiumGb: 0 };

    const expiresAt = typeof row.expires_at === 'number' ? row.expires_at : (row.expires_at ? Number(row.expires_at) : null);
    const graceUntil = typeof row.grace_until === 'number' ? row.grace_until : (row.grace_until ? Number(row.grace_until) : null);
    const deletedAt = typeof row.deleted_at === 'number' ? row.deleted_at : (row.deleted_at ? Number(row.deleted_at) : null);
    const trialUntil = typeof row.trial_until === 'number' ? row.trial_until : (row.trial_until ? Number(row.trial_until) : null);
    const updatedAt = typeof row.updated_at === 'number' ? row.updated_at : (row.updated_at ? Number(row.updated_at) : null);
    const premiumGb = row.premium_gb && Number.isFinite(Number(row.premium_gb)) && Number(row.premium_gb) > 0 ? Number(row.premium_gb) : 0;

    if (deletedAt && deletedAt > 0) {
        // Premium users keep access even after subscription deletion (they own 10GB permanently)
        return {
            allowed: premiumGb > 0,
            status: premiumGb > 0 ? 'premium_only' : 'deleted',
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            deletedAt,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    const complimentaryMs = Math.max(0, TRIAL_COMPLIMENTARY_DAYS) * 24 * 60 * 60 * 1000;
    const complimentaryUntil = trialUntil ? (trialUntil + complimentaryMs) : null;

    // If user has a paid active subscription (e.g. Solana/Apple/Google), return 'active'
    // even if trial_until is still in the future (user paid during trial period)
    if (row.status === 'active' && expiresAt && expiresAt > 0 && expiresAt > now) {
        return {
            allowed: true,
            status: 'active',
            trialUntil: trialUntil || null,
            expiresAt,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    if (trialUntil && trialUntil > now) {
        return {
            allowed: true,
            status: 'trial',
            trialUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
            complimentaryUntil,
        };
    }

    // Complimentary window after trial for sync-only access
    if (row.status === 'trial' && trialUntil && trialUntil > 0 && complimentaryUntil && now <= complimentaryUntil) {
        // Allow read/sync, block uploads via requireUploadSubscription (unless premium)
        return {
            allowed: true,
            status: premiumGb > 0 ? 'premium_only' : 'trial_complimentary',
            trialUntil,
            complimentaryUntil,
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    // Complimentary ended – clear plan selection to free it up
    if (row.status === 'trial' && trialUntil && trialUntil > 0 && complimentaryUntil && complimentaryUntil < now) {
        try {
            const updatedAt = Date.now();
            await dbRunAsync(
                `UPDATE user_plans SET status = ?, plan_gb = NULL, trial_until = NULL, grace_until = NULL, expires_at = NULL, updated_at = ? WHERE user_id = ?`,
                ['trial_complimentary_expired', updatedAt, userId]
            );
        } catch (e) {
            // ignore
        }
        return {
            allowed: premiumGb > 0,
            status: premiumGb > 0 ? 'premium_only' : 'trial_complimentary_expired',
            trialUntil,
            complimentaryUntil,
            expiresAt: null,
            graceUntil: null,
            planGb: null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    // Self-heal: if client/server marked the plan as active but a stale past expires_at remains,
    // don't immediately force grace/expired popups.
    if (row.status === 'active' && expiresAt && expiresAt > 0 && expiresAt <= now) {
        try {
            // Only clear if this row has been updated after the expiration timestamp.
            // This indicates expires_at is stale from a previous plan.
            if (updatedAt && updatedAt > expiresAt) {
                const now2 = Date.now();
                await dbRunAsync(
                    `UPDATE user_plans SET expires_at = NULL, grace_until = NULL, updated_at = ? WHERE user_id = ?`,
                    [now2, userId]
                );
                return {
                    allowed: true,
                    status: 'active',
                    expiresAt: null,
                    graceUntil: null,
                    planGb: row.plan_gb || null,
                    premiumGb,
                    paymentType: row.payment_type || null,
                };
            }
        } catch (e) {
            // ignore
        }
    }

    if (expiresAt && expiresAt > 0 && expiresAt <= now) {
        const graceMs = Math.max(0, SUBSCRIPTION_GRACE_DAYS) * 24 * 60 * 60 * 1000;
        const gu = graceUntil && graceUntil > 0 ? graceUntil : (expiresAt + graceMs);
        if (!graceUntil || graceUntil <= 0) {
            const updatedAt = Date.now();
            await dbRunAsync(
                `UPDATE user_plans SET status = ?, grace_until = ?, updated_at = ? WHERE user_id = ?`,
                ['grace', gu, updatedAt, userId]
            );
        }
        const allowedInGrace = gu && gu > 0 ? now <= gu : false;
        // Premium users keep access even after subscription expires
        return {
            allowed: allowedInGrace || premiumGb > 0,
            status: premiumGb > 0 && !allowedInGrace ? 'premium_only' : (allowedInGrace ? 'grace' : 'grace_expired'),
            expiresAt,
            graceUntil: gu,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    if (row.status === 'active') {
        return {
            allowed: true,
            status: 'active',
            expiresAt: expiresAt || null,
            graceUntil: graceUntil || null,
            planGb: row.plan_gb || null,
            premiumGb,
            paymentType: row.payment_type || null,
        };
    }

    // No active subscription — premium users still get access with their permanent 10GB
    return {
        allowed: premiumGb > 0,
        status: premiumGb > 0 ? 'premium_only' : (row.status || 'none'),
        trialUntil: trialUntil || null,
        expiresAt: expiresAt || null,
        graceUntil: graceUntil || null,
        planGb: row.plan_gb || null,
        premiumGb,
        paymentType: row.payment_type || null,
    };
};

// Allow read-only access to StealthCloud data even without an active subscription.
// We only block access after the data has been deleted server-side.
const blockDeletedSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }
        return next();
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
};

const requireActiveSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.allowed) return next();

        if (st.status === 'trial_complimentary') {
            return next(); // allow sync/read during complimentary window
        }

        if (st.status === 'grace' || st.status === 'grace_expired') {
            return res.status(402).json({
                error: 'Subscription expired',
                code: 'SUBSCRIPTION_EXPIRED',
                expiresAt: st.expiresAt,
                graceUntil: st.graceUntil,
                deleteInDays: SUBSCRIPTION_GRACE_DAYS,
            });
        }

        if (st.status === 'trial_expired' || st.status === 'trial_complimentary_expired') {
            return res.status(402).json({
                error: 'Trial expired',
                code: 'TRIAL_EXPIRED',
                trialUntil: st.trialUntil,
                complimentaryUntil: st.complimentaryUntil || null,
            });
        }

        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }

        return res.status(402).json({
            error: 'Subscription required',
            code: 'SUBSCRIPTION_REQUIRED',
        });
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
};

// Uploads are more restrictive than read-only sync.
// Policy: active + trial + premium_only can upload; grace/trial_expired can only sync/restore.
const requireUploadSubscription = async (req, res, next) => {
    try {
        const st = await resolveSubscriptionState(req.user.id);
        if (st.status === 'active' || st.status === 'trial' || st.status === 'premium_only') return next();

        if (st.status === 'trial_complimentary') {
            return res.status(402).json({
                error: 'Trial complimentary window (sync-only)',
                code: 'TRIAL_COMPLIMENTARY_SYNC_ONLY',
                trialUntil: st.trialUntil,
                complimentaryUntil: st.complimentaryUntil || null,
            });
        }

        if (st.status === 'grace' || st.status === 'grace_expired') {
            return res.status(402).json({
                error: 'Subscription expired (sync-only)',
                code: 'SUBSCRIPTION_EXPIRED_SYNC_ONLY',
                expiresAt: st.expiresAt,
                graceUntil: st.graceUntil,
                deleteInDays: SUBSCRIPTION_GRACE_DAYS,
            });
        }

        if (st.status === 'trial_expired') {
            return res.status(402).json({
                error: 'Trial expired (sync-only)',
                code: 'TRIAL_EXPIRED_SYNC_ONLY',
                trialUntil: st.trialUntil,
            });
        }

        if (st.status === 'deleted') {
            return res.status(410).json({
                error: 'Data deleted',
                code: 'SUBSCRIPTION_DATA_DELETED',
                deletedAt: st.deletedAt,
            });
        }

        return res.status(402).json({
            error: 'Subscription required',
            code: 'SUBSCRIPTION_REQUIRED',
        });
    } catch (e) {
        return res.status(500).json({ error: 'Subscription check failed' });
    }
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

    // Subscription/tier state (for StealthCloud / RevenueCat). Kept separate from auth rows.
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

    // Linked devices table — cross-app QR pairing (mobile-v2 ↔ solana-seeker etc.)
    // Links two device_uuids so their NFT/certificate data is merged on read.
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

const upload = multer({ storage: storage });

// Cloud chunk storage (encrypted blobs): keep server blind
const cloudStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        cb(null, chunksDir);
    },
    filename: (req, file, cb) => {
        const requestedId = req.headers['x-chunk-id'];
        const safeId = typeof requestedId === 'string' && requestedId.match(/^[a-f0-9]{64}$/i)
            ? requestedId.toLowerCase()
            : crypto.randomBytes(32).toString('hex');
        cb(null, safeId);
    }
});
const uploadCloudChunk = multer({ storage: cloudStorage });

// Raw encrypted chunk uploads (application/octet-stream)
const rawCloudChunk = express.raw({ type: '*/*', limit: '250mb' });

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

// ============================================================================
// PHOTOLYNK DESKTOP DOWNLOADS — Self-hosted build distribution with SHA-256
// ============================================================================

// Serve download page
app.get('/photolynk/download', (req, res) => {
    const dlPage = path.join(__dirname, 'public', 'photolynk-download.html');
    if (fs.existsSync(dlPage)) return res.sendFile(dlPage);
    res.status(404).send('Download page not found');
});

// SHA-256 checksums file (auto-generated on upload, persisted as JSON)
const CHECKSUMS_FILE = path.join(DOWNLOADS_DIR, 'checksums.json');

function loadChecksums() {
    try {
        if (fs.existsSync(CHECKSUMS_FILE)) return JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf8'));
    } catch (_) {}
    return {};
}

function saveChecksums(checksums) {
    fs.writeFileSync(CHECKSUMS_FILE, JSON.stringify(checksums, null, 2));
}

// Compute SHA-256 of a file
function computeSHA256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Parse build filename into structured info
// Pattern: "PhotoLynk Desktop-{version}-{platform}.{ext}"
function parseBuildFilename(filename) {
    // Match: PhotoLynk Desktop-2.0.0-mac-arm64.dmg, PhotoLynk Desktop-2.0.0-win-x64.exe, etc.
    const m = filename.match(/^PhotoLynk Desktop[- ](.+?)-(mac-arm64|mac-x64|win-x64|linux-x86_64)\.(dmg|exe|AppImage)$/i);
    if (!m) return null;
    const version = m[1];
    let platform = m[2].toLowerCase();
    const ext = m[3];
    // Normalize linux platform key
    if (platform === 'linux-x86_64') platform = 'linux-x64';
    return { version, platform, ext, filename };
}

// GET /api/downloads/list — Public: list available builds with SHA-256 (auto-computed if missing)
app.get('/api/downloads/list', async (req, res) => {
    try {
        if (!fs.existsSync(DOWNLOADS_DIR)) return res.json({ builds: [] });
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.dmg', '.exe', '.appimage'].includes(ext);
        });
        let checksums = loadChecksums();
        let needsSave = false;
        const builds = [];
        for (const f of files) {
            const info = parseBuildFilename(f);
            if (!info) continue;
            const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
            // Auto-compute SHA-256 if missing
            if (!checksums[f]) {
                console.log(`[Downloads] Auto-computing SHA-256 for ${f}...`);
                checksums[f] = await computeSHA256(path.join(DOWNLOADS_DIR, f));
                needsSave = true;
            }
            builds.push({
                filename: f,
                version: info.version,
                platform: info.platform,
                ext: info.ext,
                size: stat.size,
                sha256: checksums[f],
                uploadedAt: stat.mtime.toISOString(),
            });
        }
        // Save checksums if any were computed
        if (needsSave) saveChecksums(checksums);
        // Sort: latest version first, then by platform
        builds.sort((a, b) => {
            const vc = b.version.localeCompare(a.version, undefined, { numeric: true });
            if (vc !== 0) return vc;
            return a.platform.localeCompare(b.platform);
        });
        res.json({ builds });
    } catch (e) {
        console.error('[Downloads] List error:', e.message);
        res.status(500).json({ error: 'Failed to list builds' });
    }
});

// GET /api/downloads/file/:filename — Public: download a build file
app.get('/api/downloads/file/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        // Security: prevent path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const filePath = path.join(DOWNLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        const stat = fs.statSync(filePath);
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = { '.dmg': 'application/x-apple-diskimage', '.exe': 'application/x-msdownload', '.appimage': 'application/octet-stream' };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        console.error('[Downloads] File serve error:', e.message);
        res.status(500).json({ error: 'Download failed' });
    }
});

// POST /api/downloads/upload — Admin: upload a new build (requires auth token)
// Use: curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" -F "build=@file.dmg" https://stealthlynk.io/api/downloads/upload
const downloadUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DOWNLOADS_DIR),
        filename: (req, file, cb) => cb(null, file.originalname),
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.dmg', '.exe', '.appimage'].includes(ext)) return cb(null, true);
        cb(new Error('Only .dmg, .exe, and .AppImage files are allowed'));
    },
});

app.post('/api/downloads/upload', authenticateToken, downloadUpload.single('build'), async (req, res) => {
    try {
        // Only allow admin users to upload builds
        if (!req.user || (req.user.username !== 'admin' && req.user.role !== 'admin')) {
            // Also check if user is the server owner (userId 1)
            if (!req.user || req.user.userId !== 1) {
                if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(403).json({ error: 'Admin access required' });
            }
        }
        if (!req.file) return res.status(400).json({ error: 'No build file provided' });

        const filename = req.file.originalname;
        const filePath = path.join(DOWNLOADS_DIR, filename);
        const info = parseBuildFilename(filename);
        if (!info) {
            try { fs.unlinkSync(filePath); } catch (_) {}
            return res.status(400).json({ error: 'Invalid filename format. Expected: PhotoLynk Desktop-{version}-{platform}.{ext}' });
        }

        // Compute SHA-256
        const sha256 = await computeSHA256(filePath);

        // Save checksum
        const checksums = loadChecksums();
        checksums[filename] = sha256;
        saveChecksums(checksums);

        console.log(`[Downloads] Build uploaded: ${filename} (${(req.file.size / 1048576).toFixed(1)} MB) SHA-256: ${sha256}`);

        res.json({
            success: true,
            filename,
            version: info.version,
            platform: info.platform,
            size: req.file.size,
            sha256,
        });
    } catch (e) {
        console.error('[Downloads] Upload error:', e.message);
        res.status(500).json({ error: 'Upload failed: ' + e.message });
    }
});

// DELETE /api/downloads/file/:filename — Admin: remove a build
app.delete('/api/downloads/file/:filename', authenticateToken, (req, res) => {
    try {
        if (!req.user || (req.user.username !== 'admin' && req.user.role !== 'admin' && req.user.userId !== 1)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const filename = req.params.filename;
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const filePath = path.join(DOWNLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        fs.unlinkSync(filePath);
        // Remove checksum
        const checksums = loadChecksums();
        delete checksums[filename];
        saveChecksums(checksums);
        console.log(`[Downloads] Build removed: ${filename}`);
        res.json({ success: true, filename });
    } catch (e) {
        console.error('[Downloads] Delete error:', e.message);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// POST /api/downloads/rehash — Admin: recompute SHA-256 for all builds
app.post('/api/downloads/rehash', authenticateToken, async (req, res) => {
    try {
        if (!req.user || (req.user.username !== 'admin' && req.user.role !== 'admin' && req.user.userId !== 1)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.dmg', '.exe', '.appimage'].includes(ext);
        });
        const checksums = {};
        for (const f of files) {
            checksums[f] = await computeSHA256(path.join(DOWNLOADS_DIR, f));
        }
        saveChecksums(checksums);
        console.log(`[Downloads] Rehashed ${files.length} builds`);
        res.json({ success: true, count: files.length, checksums });
    } catch (e) {
        console.error('[Downloads] Rehash error:', e.message);
        res.status(500).json({ error: 'Rehash failed' });
    }
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

// Concurrency hardening:
// - Without this lock, two parallel chunk uploads for the same user can both pass the quota check
//   before either inserts into cloud_chunks, letting the user exceed their tier.
// - This is an in-memory mutex (single-node). If you run multiple Node processes behind a load balancer,
//   you should replace this with a distributed lock or an atomic quota reservation table.
const cloudUploadLocks = new Map();
const cloudUploadReservedBytes = new Map();

const acquireCloudUploadLock = async (userId) => {
    const key = String(userId);
    const prev = cloudUploadLocks.get(key) || Promise.resolve();
    let releaseNext;
    const gate = new Promise((resolve) => {
        releaseNext = resolve;
    });
    const chain = prev.then(() => gate);
    cloudUploadLocks.set(key, chain);
    await prev;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        try {
            releaseNext();
        } catch (e) {
            // ignore
        }
        setTimeout(() => {
            if (cloudUploadLocks.get(key) === chain) {
                cloudUploadLocks.delete(key);
            }
        }, 0);
    };
};

const lockStealthCloudUploadForUser = async (req, res, next) => {
    try {
        if (!ENABLE_CLOUD_UPLOAD_LOCK) return next();
        if (!req.user || !req.user.id) return next();
        const release = await acquireCloudUploadLock(req.user.id);
        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            release();
        };
        res.on('finish', cleanup);
        res.on('close', cleanup);
        req.on('aborted', cleanup);
        return next();
    } catch (e) {
        return next(e);
    }
};

// Capacity endpoint (recommended for proxies that only forward /api/*)
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
                const nftRoot = path.join(CLOUD_DIR, 'nft');

                const keyHasAnyDir = (k) => {
                    if (!k) return false;
                    try {
                        if (fs.existsSync(path.join(cloudUsersRoot, k))) return true;
                        if (chunksUsersRoot && fs.existsSync(path.join(chunksUsersRoot, k))) return true;
                        if (fs.existsSync(path.join(nftRoot, k))) return true;
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
// Used by wallet migration to switch from legacy email+password to wallet-derived
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

// Save user's Solana wallet address (called after wallet connect on any platform)
app.post('/api/save-wallet', authenticateToken, async (req, res) => {
    try {
        const { wallet_address } = req.body || {};
        if (!wallet_address || typeof wallet_address !== 'string' || wallet_address.length < 32 || wallet_address.length > 50) {
            return res.status(400).json({ error: 'Valid Solana wallet address required' });
        }
        await dbRunAsync(`UPDATE users SET wallet_address = ? WHERE id = ?`, [wallet_address.trim(), req.user.id]);
        console.log(`[Wallet] Saved wallet for user ${req.user.id}: ${wallet_address.trim()}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Wallet] Save error:', e.message);
        res.status(500).json({ error: 'Failed to save wallet address' });
    }
});

// Lookup wallet address by email (for NFT transfers by email)
app.post('/api/lookup-wallet', authenticateToken, async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        const normalizedEmail = String(email).toLowerCase().trim();
        const row = await dbGetAsync(
            `SELECT wallet_address FROM users WHERE (email = ? OR alias_email = ?) AND wallet_address IS NOT NULL AND wallet_address != ''`,
            [normalizedEmail, normalizedEmail]
        );
        if (!row || !row.wallet_address) {
            return res.status(404).json({ error: 'No wallet address found for this user' });
        }
        res.json({ address: row.wallet_address });
    } catch (e) {
        console.error('[Wallet] Lookup error:', e.message);
        res.status(500).json({ error: 'Failed to lookup wallet' });
    }
});

app.get('/api/subscription/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        // Self-heal: if user is premium in nft-service but premium_gb not set in user_plans, fix it
        try {
            const nftService = require('../nft-service');
            const premiumStatus = nftService.balance.getPremiumStatus(userId);
            if (premiumStatus && premiumStatus.isPremium) {
                const row = await dbGetAsync(`SELECT premium_gb FROM user_plans WHERE user_id = ?`, [userId]);
                if (!row || !row.premium_gb || Number(row.premium_gb) <= 0) {
                    await ensurePlanRow(userId);
                    await dbRunAsync(
                        `UPDATE user_plans SET premium_gb = 10, updated_at = ? WHERE user_id = ?`,
                        [Date.now(), userId]
                    );
                    console.log(`[Premium] Self-healed premium_gb=10 for user ${userId}`);
                }
            }
        } catch (_) { /* nft-service not available */ }
        const st = await resolveSubscriptionState(userId);
        return res.json(st);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to resolve subscription status' });
    }
});

// Check if user can downgrade to a specific tier based on current storage usage
const canDowngradeToTier = async (userId, targetTierGb) => {
    const usedBytes = await getUserUsedBytes(userId);
    const premiumGb = await getUserPremiumGb(userId);
    const GB = 1000 * 1000 * 1000;
    const targetBytes = (targetTierGb + premiumGb) * GB;
    // Allow downgrade only if used storage fits in target tier + permanent premium storage
    return usedBytes < targetBytes;
};

// Get minimum required tier based on current storage usage (accounts for permanent premium storage)
const getMinRequiredTier = async (userId) => {
    const usedBytes = await getUserUsedBytes(userId);
    const premiumGb = await getUserPremiumGb(userId);
    const GB = 1000 * 1000 * 1000;
    // If premium storage alone covers usage, no subscription tier needed
    if (premiumGb > 0 && usedBytes < premiumGb * GB) return 0;
    const tiers = [100, 200, 400, 1000];
    for (const tier of tiers) {
        if (usedBytes < (tier + premiumGb) * GB) return tier;
    }
    return 1000; // Max tier if usage exceeds all
};

// API endpoint to check downgrade eligibility
app.get('/api/subscription/downgrade-check', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const usedBytes = await getUserUsedBytes(userId);
        const currentPlan = await getUserPlanGb(userId);
        const premiumGb = await getUserPremiumGb(userId);
        const minRequiredTier = await getMinRequiredTier(userId);
        const GB = 1000 * 1000 * 1000;
        
        // Check each tier (account for permanent premium storage)
        const tiers = [100, 200, 400, 1000];
        const tierStatus = {};
        for (const tier of tiers) {
            const tierBytes = (tier + premiumGb) * GB;
            tierStatus[tier] = {
                allowed: usedBytes < tierBytes,
                tierBytes,
                usedBytes,
                usedPercent: tierBytes > 0 ? Math.round((usedBytes / tierBytes) * 100) : 0,
            };
        }
        
        return res.json({
            currentPlanGb: currentPlan,
            premiumGb,
            usedBytes,
            minRequiredTier,
            tiers: tierStatus,
        });
    } catch (e) {
        console.error('[Downgrade check] error', e);
        return res.status(500).json({ error: 'Downgrade check failed' });
    }
});

app.post('/api/subscription/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId, tierGb, entitlementId, paymentType, expiresAt: clientExpiresAt } = req.body || {};
        const tier = normalizeTierGb(tierGb) || normalizeTierGb(inferTierGbFromProductId(productId));
        if (!tier) return res.status(400).json({ error: 'Invalid or missing tier' });

        // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
        const currentPlanGb = await getUserPlanGb(userId);
        if (currentPlanGb && tier < currentPlanGb) {
            const canDowngrade = await canDowngradeToTier(userId, tier);
            if (!canDowngrade) {
                const usedBytes = await getUserUsedBytes(userId);
                const minTier = await getMinRequiredTier(userId);
                return res.status(400).json({
                    error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                    code: 'DOWNGRADE_BLOCKED',
                    usedBytes,
                    targetTierGb: tier,
                    minRequiredTier: minTier,
                });
            }
        }

        await ensurePlanRow(userId);
        const currentPlan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
        const now = Date.now();

        // Accept expires_at from app for Apple/Google subscribers (RevenueCat SDK provides it).
        // Solana handles its own expiry in /api/solana/verify-payment — don't overwrite here.
        const isSolana = String(paymentType).toLowerCase() === 'solana';
        const rawExpires = clientExpiresAt != null ? Number(clientExpiresAt) : null;
        const syncExpiresAt = (!isSolana && Number.isFinite(rawExpires) && rawExpires > 0) ? rawExpires : null;

        const trialUntil = currentPlan && currentPlan.trial_until ? Number(currentPlan.trial_until) : null;
        const isInTrialWindow = trialUntil && Number.isFinite(trialUntil) && trialUntil > now;
        // If syncing a real payment (has paymentType + expiresAt), mark as 'active' even during trial
        const hasPaidSubscription = paymentType && syncExpiresAt && syncExpiresAt > now;
        const nextStatus = (isInTrialWindow && !hasPaidSubscription) ? 'trial' : 'active';
        await dbRunAsync(
            `UPDATE user_plans
                SET plan_gb = ?,
                    status = ?,
                    rc_product_id = ?,
                    rc_entitlement = COALESCE(?, rc_entitlement),
                    rc_app_user_id = COALESCE(rc_app_user_id, ?),
                    payment_type = ?,
                    payment_at = ?,
                    expires_at = CASE WHEN ? IS NOT NULL AND ? > 0 THEN ? ELSE expires_at END,
                    grace_until = NULL,
                    deleted_at = NULL,
                    updated_at = ?
              WHERE user_id = ?`,
            [
                tier,
                nextStatus,
                productId || null,
                entitlementId || null,
                req.user.email || null,
                paymentType || null,
                now,
                syncExpiresAt, syncExpiresAt, syncExpiresAt,
                now,
                userId,
            ]
        );

        const plan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [userId]);
        return res.json({ ok: true, plan });
    } catch (e) {
        console.error('[Subscription sync] error', e);
        return res.status(500).json({ error: 'Sync failed' });
    }
});

app.post('/api/revenuecat/webhook', async (req, res) => {
    try {
        if (REVENUECAT_WEBHOOK_SECRET) {
            const auth = (req.headers['authorization'] || '').toString();
            if (auth !== `Bearer ${REVENUECAT_WEBHOOK_SECRET}`) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
        }

        const event = req.body || {};
        const appUserId = event && (event.app_user_id || event.appUserId) ? String(event.app_user_id || event.appUserId) : '';
        if (!appUserId) return res.status(400).json({ error: 'Missing app_user_id' });

        const expiresAtMs = event && (event.expiration_at_ms || event.expirationAtMs) ? Number(event.expiration_at_ms || event.expirationAtMs) : null;
        const productId = event && (event.product_id || event.productId) ? String(event.product_id || event.productId) : null;
        const entitlementId = event && (event.entitlement_id || event.entitlementId) ? String(event.entitlement_id || event.entitlementId) : null;
        const tierGbFromEvent = normalizeTierGb(event && (event.plan_gb || event.planGb || event.tier_gb || event.tierGb));
        const tierGb = tierGbFromEvent || normalizeTierGb(inferTierGbFromProductId(productId));

        const store = (event && (event.store || event.Store)) ? String(event.store || event.Store).toUpperCase() : '';
        const paymentType =
            store === 'APP_STORE' ? 'apple' :
            store === 'PLAY_STORE' ? 'google' :
            null;

        db.get(
            `SELECT up.user_id AS user_id
               FROM user_plans up
              WHERE up.rc_app_user_id = ?
              LIMIT 1`,
            [appUserId],
            async (err, row) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                if (!row || !row.user_id) return res.status(404).json({ error: 'User not found' });

                // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
                if (tierGb) {
                    const currentPlanGb = await getUserPlanGb(row.user_id);
                    if (currentPlanGb && tierGb < currentPlanGb) {
                        const canDowngrade = await canDowngradeToTier(row.user_id, tierGb);
                        if (!canDowngrade) {
                            const usedBytes = await getUserUsedBytes(row.user_id);
                            const minTier = await getMinRequiredTier(row.user_id);
                            console.log(`[RevenueCat Webhook] DOWNGRADE BLOCKED: user ${row.user_id} tried ${currentPlanGb}GB -> ${tierGb}GB, used ${usedBytes} bytes, min tier ${minTier}GB`);
                            return res.status(400).json({
                                error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                                code: 'DOWNGRADE_BLOCKED',
                                usedBytes,
                                targetTierGb: tierGb,
                                minRequiredTier: minTier,
                            });
                        }
                    }
                }

                const now = Date.now();
                const expiresMs = Number.isFinite(expiresAtMs) ? expiresAtMs : null;
                const isActive = expiresMs && expiresMs > now;

                if (isActive) {
                    await dbRunAsync(
                        `UPDATE user_plans
                            SET status = ?,
                                expires_at = ?,
                                grace_until = NULL,
                                deleted_at = NULL,
                                rc_product_id = ?,
                                rc_entitlement = ?,
                                payment_type = ?,
                                payment_at = ?,
                                plan_gb = COALESCE(?, plan_gb),
                                updated_at = ?
                          WHERE user_id = ?`,
                        ['active', expiresMs, productId, entitlementId, paymentType, now, tierGb, now, row.user_id]
                    );
                    return res.json({ ok: true });
                }

                const graceMs = Math.max(0, SUBSCRIPTION_GRACE_DAYS) * 24 * 60 * 60 * 1000;
                const graceUntil = (expiresMs && expiresMs > 0) ? (expiresMs + graceMs) : (now + graceMs);
                await dbRunAsync(
                    `UPDATE user_plans
                        SET status = ?,
                            expires_at = COALESCE(?, expires_at),
                            grace_until = COALESCE(grace_until, ?),
                            rc_product_id = ?,
                            rc_entitlement = ?,
                            payment_type = ?,
                            payment_at = ?,
                            updated_at = ?
                      WHERE user_id = ?`,
                    ['grace', expiresMs, graceUntil, productId, entitlementId, paymentType, now, now, row.user_id]
                );
                return res.json({ ok: true });
            }
        );
    } catch (e) {
        return res.status(500).json({ error: 'Webhook failed' });
    }
});

// ============================================================================
// SOLANA BLOCKCHAIN PAYMENT VERIFICATION
// ============================================================================
// Verifies SOL payments on Solana blockchain and activates subscriptions
// Payment wallet: 8uaqEooTysK7mtb5gLKMD1MJbsKVPoahEXVMAESwptMg

const SOLANA_PAYMENT_WALLET = 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1000000000;

// Plan durations in milliseconds
const PLAN_DURATION_MS = {
    monthly: 30 * 24 * 60 * 60 * 1000,
    yearly: 365 * 24 * 60 * 60 * 1000,
};

// Verify Solana payment transaction
app.post('/api/solana/verify-payment', async (req, res) => {
    const { txSignature, tierGb, duration, solAmount, paymentWallet } = req.body;
    
    // Extract user from JWT token in Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization token required' });
    }
    
    const token = authHeader.substring(7);
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    if (!txSignature || !tierGb) {
        return res.status(400).json({ error: 'Missing required fields: txSignature, tierGb' });
    }
    
    // Validate payment wallet matches
    if (paymentWallet && paymentWallet !== SOLANA_PAYMENT_WALLET) {
        return res.status(400).json({ error: 'Invalid payment wallet' });
    }
    
    // Normalize tier
    const normalizedTier = normalizeTierGb(tierGb);
    if (!normalizedTier) {
        return res.status(400).json({ error: 'Invalid tier' });
    }
    
    try {
        // Find user by ID from JWT token
        const user = await dbGetAsync(`SELECT id, email FROM users WHERE id = ?`, [decoded.id]);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // DOWNGRADE GUARD: Reject if user's storage exceeds target tier
        const currentPlanGb = await getUserPlanGb(user.id);
        if (currentPlanGb && normalizedTier < currentPlanGb) {
            const canDowngrade = await canDowngradeToTier(user.id, normalizedTier);
            if (!canDowngrade) {
                const usedBytes = await getUserUsedBytes(user.id);
                const minTier = await getMinRequiredTier(user.id);
                return res.status(400).json({
                    error: 'Cannot downgrade: storage usage exceeds target plan capacity',
                    code: 'DOWNGRADE_BLOCKED',
                    usedBytes,
                    targetTierGb: normalizedTier,
                    minRequiredTier: minTier,
                });
            }
        }
        
        // Verify transaction on Solana blockchain
        const txVerification = await verifySolanaTransaction(txSignature, solAmount);
        if (!txVerification.success) {
            return res.status(400).json({ error: txVerification.error || 'Transaction verification failed' });
        }
        
        // Check if this transaction was already processed
        const existingTx = await dbGetAsync(
            `SELECT * FROM solana_payments WHERE tx_signature = ?`,
            [txSignature]
        );
        if (existingTx) {
            return res.status(409).json({ error: 'Transaction already processed', existingPayment: existingTx });
        }
        
        // Calculate subscription expiry
        const now = Date.now();
        const durationMs = PLAN_DURATION_MS[duration] || PLAN_DURATION_MS.monthly;
        
        // Get current plan to check existing expiration
        const currentPlan = await dbGetAsync(`SELECT * FROM user_plans WHERE user_id = ?`, [user.id]);
        let expiresAt;
        
        if (currentPlan) {
            const currentExpires = currentPlan.expires_at;
            const currentTrial = currentPlan.trial_until;
            
            if (currentExpires && currentExpires > now) {
                // Renewal: extend from existing expiration date
                expiresAt = currentExpires + durationMs;
            } else if (currentTrial && currentTrial > now) {
                // First payment during trial: now + remaining trial days + subscription period
                const remainingTrialMs = currentTrial - now;
                expiresAt = now + remainingTrialMs + durationMs;
            } else {
                // No active plan or trial — start fresh from now
                expiresAt = now + durationMs;
            }
        } else {
            expiresAt = now + durationMs;
        }
        
        // Record the payment
        await dbRunAsync(
            `INSERT INTO solana_payments (user_id, tx_signature, sol_amount, tier_gb, duration, created_at, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.id, txSignature, solAmount || 0, normalizedTier, duration || 'monthly', now, now]
        );
        
        // Activate subscription
        await dbRunAsync(
            `INSERT INTO user_plans (user_id, plan_gb, status, expires_at, updated_at)
             VALUES (?, ?, 'active', ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                plan_gb = excluded.plan_gb,
                status = 'active',
                expires_at = excluded.expires_at,
                payment_type = 'solana',
                payment_at = excluded.updated_at,
                grace_until = NULL,
                updated_at = excluded.updated_at`,
            [user.id, normalizedTier, expiresAt, now]
        );
        
        console.log(`[Solana] Payment verified: ${txSignature} - User ${user.email} - ${normalizedTier}GB ${duration}`);
        
        return res.json({
            success: true,
            message: 'Payment verified and subscription activated',
            subscription: {
                tierGb: normalizedTier,
                status: 'active',
                expiresAt: new Date(expiresAt).toISOString(),
            },
        });
    } catch (e) {
        console.error('[Solana] Payment verification error:', e);
        return res.status(500).json({ error: 'Payment verification failed' });
    }
});

// Helper function to verify Solana transaction
async function verifySolanaTransaction(txSignature, expectedSolAmount) {
    console.log('[Solana] Verifying transaction:', txSignature, 'expected amount:', expectedSolAmount);
    
    // Retry up to 5 times with 2 second intervals to allow tx to propagate
    const maxRetries = 5;
    const retryDelay = 2000;
    let tx = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Solana] Attempt ${attempt}/${maxRetries} to fetch transaction`);
            const response = await axios.post(SOLANA_RPC_ENDPOINT, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    txSignature,
                    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
                ],
            }, {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            });
            
            tx = response.data?.result;
            if (tx) {
                console.log('[Solana] Transaction found on attempt', attempt);
                break;
            }
            
            if (attempt < maxRetries) {
                console.log(`[Solana] Transaction not found yet, waiting ${retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        } catch (e) {
            console.error(`[Solana] RPC error on attempt ${attempt}:`, e.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    if (!tx) {
        return { success: false, error: 'Transaction not found after retries - may still be propagating' };
    }
        
        // Check if transaction explicitly failed (only if meta exists)
        if (tx.meta && tx.meta.err) {
            return { success: false, error: 'Transaction failed on chain' };
        }
        
        // Parse transfer instructions to find sender, receiver, and amount
        const instructions = tx.transaction?.message?.instructions || [];
        let sender = null;
        let receiver = null;
        let transferAmount = 0;
        
        for (const ix of instructions) {
            // Look for System Program transfer instruction
            if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                sender = ix.parsed.info.source;
                receiver = ix.parsed.info.destination;
                transferAmount = ix.parsed.info.lamports / LAMPORTS_PER_SOL;
                console.log(`[Solana] Transfer found: ${sender} -> ${receiver}, amount: ${transferAmount} SOL`);
                break;
            }
        }
        
        if (!sender || !receiver || transferAmount <= 0) {
            console.log('[Solana] No valid transfer instruction found in transaction');
            console.log('[Solana] Instructions:', JSON.stringify(instructions, null, 2));
            return { success: false, error: 'No valid transfer found in transaction' };
        }
        
        // Verify the payment is TO our wallet
        if (receiver !== SOLANA_PAYMENT_WALLET) {
            console.log(`[Solana] Payment not to our wallet. Expected: ${SOLANA_PAYMENT_WALLET}, Got: ${receiver}`);
            return { success: false, error: 'Payment not sent to correct wallet' };
        }
        
        console.log(`[Solana] Valid payment: ${transferAmount} SOL from ${sender} to ${receiver}`);
        
    return { 
        success: true, 
        receivedAmount: transferAmount,
        sender,
        receiver,
        blockTime: tx.blockTime,
        slot: tx.slot,
    };
}

// Create solana_payments table if not exists
db.run(`CREATE TABLE IF NOT EXISTS solana_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tx_signature TEXT UNIQUE NOT NULL,
    sol_amount REAL,
    tier_gb INTEGER,
    duration TEXT DEFAULT 'monthly',
    created_at INTEGER,
    verified_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
)`);

// Upload File
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { filename, path: filePath, originalname, mimetype, size } = req.file;
    
    // Calculate file hash to detect duplicates
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    
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
        return res.status(500).json({ error: 'Failed to write upload' });
    });

    req.on('data', (chunk) => {
        try {
            writtenBytes += chunk.length;
            hasher.update(chunk);
        } catch (e) {
            // ignore
        }
    });

    out.on('finish', async () => {
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
                try { fs.chmodSync(correctedFinalPath, 0o644); } catch (e) {}
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
                if (!filename || filename.startsWith('.')) continue;
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
                const exifPath = getExifFilePath(hash);
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

// Diagnostic: test download without auth (remove after debugging)
app.get('/api/debug/download-test', (req, res) => {
    try {
        const dirs = fs.readdirSync(UPLOAD_DIR);
        let testFile = null;
        for (const d of dirs) {
            if (d.startsWith('.')) continue;
            const full = path.join(UPLOAD_DIR, d);
            try {
                if (!fs.statSync(full).isDirectory()) continue;
                const files = fs.readdirSync(full);
                for (const f of files) {
                    if (f.startsWith('.')) continue;
                    const fp = path.join(full, f);
                    if (fs.statSync(fp).isFile()) { testFile = fp; break; }
                }
                if (testFile) break;
            } catch (e) {}
        }
        if (!testFile) return res.json({ error: 'No files found', UPLOAD_DIR, dirs });
        const stat = fs.statSync(testFile);
        const readable = (() => { try { fs.accessSync(testFile, fs.constants.R_OK); return true; } catch (e) { return false; } })();
        // Try streaming
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(testFile);
        stream.on('error', (e) => {
            console.error('[DEBUG] Stream error:', e.message);
            if (!res.headersSent) res.status(500).json({ error: e.message, testFile, readable });
        });
        console.log('[DEBUG] Streaming test file:', testFile, 'size:', stat.size, 'readable:', readable);
        stream.pipe(res);
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack, UPLOAD_DIR });
    }
});

// Diagnostic: show server state (remove after debugging)
app.get('/api/debug/state', (req, res) => {
    try {
        const dirs = fs.readdirSync(UPLOAD_DIR);
        const info = { UPLOAD_DIR, cwd: process.cwd(), execPath: process.execPath, nodeVersion: process.version, dirs: [] };
        for (const d of dirs) {
            if (d.startsWith('.')) continue;
            const full = path.join(UPLOAD_DIR, d);
            try {
                const st = fs.statSync(full);
                if (st.isDirectory()) {
                    const files = fs.readdirSync(full).filter(f => !f.startsWith('.')).slice(0, 5);
                    info.dirs.push({ name: d, fileCount: fs.readdirSync(full).filter(f => !f.startsWith('.')).length, sampleFiles: files });
                }
            } catch (e) {}
        }
        db.all(`SELECT id, email, user_uuid FROM users`, [], (err, users) => {
            info.users = users || [];
            db.all(`SELECT user_id, device_uuid FROM devices`, [], (err2, devices) => {
                info.devices = devices || [];
                res.json(info);
            });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.post('/api/cloud/purge', authenticateToken, async (req, res) => {
    try {
        const { chunksDir, manifestsDir } = ensureStealthCloudUserDirs(req.user);
        const keysToPurge = getStealthCloudAllPossibleUserKeys(req.user);

        const countFiles = (dir) => {
            try {
                if (!fs.existsSync(dir)) return 0;
                return fs.readdirSync(dir).filter(f => f && !f.startsWith('.')).length;
            } catch (e) {
                return 0;
            }
        };

        const chunksBefore = countFiles(chunksDir);
        const manifestsBefore = countFiles(manifestsDir);

        // Delete only StealthCloud manifests + chunks for all possible keys.
        // This prevents the migration logic from repopulating manifests after purge,
        // while avoiding deletion of raw files, EXIF, NFTs, and DB state.
        for (const k of keysToPurge) {
            try {
                const cloudManifestsDir = path.join(CLOUD_DIR, 'users', k, 'manifests');
                if (cloudManifestsDir.startsWith(path.join(CLOUD_DIR, 'users'))) {
                    fs.rmSync(cloudManifestsDir, { recursive: true, force: true });
                }
            } catch (e) {}

            if (CHUNKS_DIR) {
                try {
                    const chunksUserDir = path.join(CHUNKS_DIR, 'users', k, 'chunks');
                    if (chunksUserDir.startsWith(path.join(CHUNKS_DIR, 'users'))) {
                        fs.rmSync(chunksUserDir, { recursive: true, force: true });
                    }
                } catch (e) {}
            } else {
                try {
                    const cloudChunksDir = path.join(CLOUD_DIR, 'users', k, 'chunks');
                    if (cloudChunksDir.startsWith(path.join(CLOUD_DIR, 'users'))) {
                        fs.rmSync(cloudChunksDir, { recursive: true, force: true });
                    }
                } catch (e) {}
            }
        }

        // Usage is calculated from cloud_chunks DB rows. Since purge deletes the files on disk,
        // clear the corresponding DB usage rows so /api/cloud/usage returns 0 immediately.
        try {
            await dbRunAsync(`DELETE FROM cloud_chunks WHERE user_id = ?`, [req.user.id]);
        } catch (e) {}

        // Recreate directories for the current (canonical) user key
        try { fs.mkdirSync(chunksDir, { recursive: true }); } catch (e) {}
        try { fs.mkdirSync(manifestsDir, { recursive: true }); } catch (e) {}
        
        // Clear dedup cache for this user since we just deleted their manifests
        try {
            if (typeof serverDedupCache !== 'undefined') {
                serverDedupCache.delete(manifestsDir);
            }
        } catch (e) {}

        console.log(`[Purge] User ${req.user.id}: chunks=${chunksBefore}, manifests=${manifestsBefore}`);

        return res.json({
            ok: true,
            deleted: {
                chunks: chunksBefore,
                manifests: manifestsBefore,
            }
        });
    } catch (e) {
        return res.status(500).json({ error: 'Purge failed' });
    }
});

app.get('/api/cloud/device-state', authenticateToken, blockDeletedSubscription, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('ETag', '');

        const deviceUuid = (req.user && (req.user.device_uuid || req.user.deviceUuid)) ? String(req.user.device_uuid || req.user.deviceUuid) : '';
        const row = await dbGetAsync(
            `SELECT state_json, updated_at FROM cloud_device_state WHERE user_id = ? AND device_uuid = ?`,
            [req.user.id, deviceUuid]
        );
        if (!row || !row.state_json) {
            return res.json({ state: null, updatedAt: null });
        }
        let parsed = null;
        try {
            parsed = JSON.parse(String(row.state_json));
        } catch (e) {
            parsed = null;
        }
        return res.json({ state: parsed, updatedAt: row.updated_at || null });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to load device state' });
    }
});

app.put('/api/cloud/device-state', authenticateToken, blockDeletedSubscription, async (req, res) => {
    try {
        const deviceUuid = (req.user && (req.user.device_uuid || req.user.deviceUuid)) ? String(req.user.device_uuid || req.user.deviceUuid) : '';
        const state = req && req.body && typeof req.body === 'object' ? (req.body.state !== undefined ? req.body.state : req.body) : null;

        if (state === null || typeof state !== 'object' || Array.isArray(state)) {
            return res.status(400).json({ error: 'state must be an object' });
        }

        const json = JSON.stringify(state);
        const bytes = Buffer.byteLength(json, 'utf8');
        if (bytes > 100 * 1024) {
            return res.status(413).json({ error: 'state too large' });
        }

        const now = Date.now();
        await dbRunAsync(
            `INSERT INTO cloud_device_state (user_id, device_uuid, state_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, device_uuid) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
            [req.user.id, deviceUuid, json, now]
        );
        return res.json({ ok: true, updatedAt: now });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save device state' });
    }
});

// Upload encrypted chunk blob
app.post('/api/cloud/chunks', authenticateToken, requireUploadSubscription, (req, res, next) => {
    const ct = (req.headers['content-type'] || '').toString().toLowerCase();
    if (ct.startsWith('application/octet-stream') || ct === 'application/octetstream') {
        return rawCloudChunk(req, res, next);
    }
    return uploadCloudChunk.single('chunk')(req, res, next);
}, async (req, res) => {
    const clientBuild = (req.headers['x-client-build'] || '').toString();
    if (clientBuild) {
        console.log(`[SC] /chunks client=${clientBuild} user=${req.user.id}`);
    }
    const requestedId = (req.headers['x-chunk-id'] || '').toString().toLowerCase();

    // If raw upload (no multipart), store from req.body
    if (!req.file) {
        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'No chunk uploaded' });
        }

        if (!requestedId || !requestedId.match(/^[a-f0-9]{64}$/i)) {
            return res.status(400).json({ error: 'Missing or invalid X-Chunk-Id' });
        }

        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        const target = path.join(chunksDir, requestedId);
        if (!target.startsWith(chunksDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (fs.existsSync(target)) {
            return res.json({ chunkId: requestedId, stored: true });
        }

        const reservation = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: req.body.length });
        if (!reservation.allowed) {
            return res.status(413).json({
                error: 'Storage limit reached',
                code: 'QUOTA_EXCEEDED',
                usedBytes: reservation.usedBytes,
                quotaBytes: reservation.quotaBytes,
                remainingBytes: reservation.remainingBytes,
            });
        }

        try {
            const actual = crypto.createHash('sha256').update(req.body).digest('hex');
            if (actual !== requestedId) {
                return res.status(400).json({ error: 'Chunk hash mismatch' });
            }
            fs.writeFileSync(target, req.body);
            db.run(
                `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
                [req.user.id, requestedId, req.body.length, Date.now()]
            );
            return res.json({ chunkId: requestedId, stored: true });
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        } finally {
            try { reservation.release(); } catch (e) {}
        }
    }

    const storedName = req.file.filename;
    const tmpPath = req.file.path;
    const tmpSize = (() => {
        try {
            const st = fs.statSync(tmpPath);
            return st && typeof st.size === 'number' ? Number(st.size) : 0;
        } catch (e) {
            return 0;
        }
    })();

    // If we already have this chunk, don't count it again.
    if (requestedId && requestedId.match(/^[a-f0-9]{64}$/i)) {
        const { chunksDir } = ensureStealthCloudUserDirs(req.user);
        const existing = path.join(chunksDir, requestedId);
        if (fs.existsSync(existing)) {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
            return res.json({ chunkId: requestedId, stored: true });
        }
    }

    const reservationMultipart = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: tmpSize });
    if (!reservationMultipart.allowed) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        return res.status(413).json({
            error: 'Storage limit reached',
            code: 'QUOTA_EXCEEDED',
            usedBytes: reservationMultipart.usedBytes,
            quotaBytes: reservationMultipart.quotaBytes,
            remainingBytes: reservationMultipart.remainingBytes,
        });
    }

    // Optional integrity check: if client provided a sha256 id, verify it
    if (requestedId && requestedId.match(/^[a-f0-9]{64}$/i)) {
        try {
            const buf = fs.readFileSync(req.file.path);
            const actual = crypto.createHash('sha256').update(buf).digest('hex');
            if (actual !== requestedId) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Chunk hash mismatch' });
            }

            // Ensure filename equals requested hash for idempotency
            if (storedName !== requestedId) {
                const dir = path.dirname(req.file.path);
                const target = path.join(dir, requestedId);
                if (fs.existsSync(target)) {
                    fs.unlinkSync(req.file.path);
                } else {
                    fs.renameSync(req.file.path, target);
                }
                const finalPath = fs.existsSync(target) ? target : req.file.path;
                let finalSize = tmpSize;
                try {
                    const st = fs.statSync(finalPath);
                    finalSize = st && typeof st.size === 'number' ? Number(st.size) : finalSize;
                } catch (e) {
                    finalSize = finalSize;
                }
                db.run(
                    `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
                    [req.user.id, requestedId, finalSize, Date.now()]
                );
                return res.json({ chunkId: requestedId, stored: true });
            }
        } catch (e) {
            return res.status(500).json({ error: 'Chunk verification failed' });
        } finally {
            try { reservationMultipart.release(); } catch (e) {}
        }
    }

    db.run(
        `INSERT OR IGNORE INTO cloud_chunks (user_id, chunk_id, size, created_at) VALUES (?, ?, ?, ?)`,
        [req.user.id, storedName, tmpSize, Date.now()]
    );
    try {
        res.json({ chunkId: storedName, stored: true });
    } finally {
        try { reservationMultipart.release(); } catch (e) {}
    }
});

// Download encrypted chunk blob
app.get('/api/cloud/chunks/:chunkId', authenticateToken, blockDeletedSubscription, (req, res) => {
    const chunkId = (req.params.chunkId || '').toLowerCase();
    if (!chunkId.match(/^[a-f0-9]{64}$/i)) {
        return res.status(400).json({ error: 'Invalid chunk id' });
    }
    const { chunksDir: chunksRoot } = ensureStealthCloudUserDirs(req.user);
    const chunkPath = path.join(chunksRoot, chunkId);
    if (!chunkPath.startsWith(chunksRoot)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (fs.existsSync(chunkPath)) {
        return res.download(chunkPath);
    }
    
    return res.status(404).json({ error: 'Chunk not found' });
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

// Upload encrypted manifest JSON
// Now includes comprehensive server-side deduplication as extra precaution
app.post('/api/cloud/manifests', authenticateToken, requireUploadSubscription, (req, res) => {
    const {
        manifestId,
        encryptedManifest,
        chunkCount,
        filename,
        originalSize,
        fileHash,
        perceptualHash,
        creationTime,
        exifCaptureTime,
        exifMake,
        exifModel,
        mediaType,
        thumbChunkId,
        thumbNonce,
        thumbSize,
        thumbW,
        thumbH,
        thumbMime,
    } = req.body || {};
    const clientBuild = (req.headers['x-client-build'] || '').toString();
    if (clientBuild) {
        console.log(`[SC] /manifests client=${clientBuild} user=${req.user.id} chunkCount=${typeof chunkCount === 'number' ? chunkCount : 'na'}`);
    }
    if (!manifestId || typeof manifestId !== 'string') return res.status(400).json({ error: 'manifestId required' });
    if (!encryptedManifest || typeof encryptedManifest !== 'string') return res.status(400).json({ error: 'encryptedManifest required' });

    if (typeof chunkCount === 'number' && chunkCount <= 0) {
        return res.status(400).json({ error: 'Invalid manifest: chunkCount must be > 0' });
    }

    const safeId = manifestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeId) return res.status(400).json({ error: 'Invalid manifestId' });

    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);

    // ========== SERVER-SIDE DEDUPLICATION (Minimal - only reliable checks) ==========
    // Build dedup sets from existing manifests
    const dedupSets = buildServerDedupSets(manifestsDir);
    console.log(`[SC-Dedup] Checking ${safeId}: ${dedupSets.manifestIds.size} manifestIds, ${dedupSets.fileHashes.size} fHashes, ${dedupSets.perceptualHashes.size} pHashes`);
    
    // Check 1: ManifestId (filename + size hash) - exact match only
    if (dedupSets.manifestIds.has(safeId)) {
        console.log(`[SC-Dedup] Skipping ${safeId} - manifestId already exists`);
        return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'manifestId' });
    }
    
    // Check 2: Exact file hash match (byte-identical files)
    if (fileHash && dedupSets.fileHashes.has(fileHash)) {
        console.log(`[SC-Dedup] Skipping ${safeId} - fileHash already exists`);
        return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'fileHash' });
    }
    
    // Check 3: Perceptual hash match (images - 1-bit tolerance for identical)
    if (perceptualHash) {
        const phashMatch = findPerceptualHashMatchServer(perceptualHash, dedupSets.perceptualHashes);
        if (phashMatch.match) {
            console.log(`[SC-Dedup] Skipping ${safeId} - perceptualHash match (${phashMatch.reason}${phashMatch.distance !== undefined ? ', dist=' + phashMatch.distance : ''})`);
            return res.json({ ok: true, manifestId: safeId, skipped: true, reason: 'perceptualHash' });
        }
    }
    
    // NOTE: Removed filename-only and EXIF-only dedup checks - too many false positives
    // Client already does thorough dedup, server is just a safety net
    
    // ========== No duplicates found - store the manifest ==========
    const manifestPath = path.join(manifestsDir, `${safeId}.json`);
    
    // Store encrypted manifest + unencrypted metadata for fast dedup lookups
    const payload = {
        manifestId: safeId,
        encryptedManifest,
        createdAt: new Date().toISOString(),
        // Unencrypted metadata for fast dedup (hashes don't reveal content)
        meta: {
            filename: typeof filename === 'string' ? filename : null,
            mediaType: typeof mediaType === 'string' ? mediaType : null,
            originalSize: typeof originalSize === 'number' ? originalSize : null,
            fileHash: typeof fileHash === 'string' ? fileHash : null,
            perceptualHash: typeof perceptualHash === 'string' ? perceptualHash : null,
            creationTime: creationTime || null,
            exifCaptureTime: typeof exifCaptureTime === 'string' ? exifCaptureTime : null,
            exifMake: typeof exifMake === 'string' ? exifMake : null,
            exifModel: typeof exifModel === 'string' ? exifModel : null,
            thumbChunkId: typeof thumbChunkId === 'string' ? thumbChunkId : null,
            thumbNonce: typeof thumbNonce === 'string' ? thumbNonce : null,
            thumbSize: typeof thumbSize === 'number' ? thumbSize : null,
            thumbW: typeof thumbW === 'number' ? thumbW : null,
            thumbH: typeof thumbH === 'number' ? thumbH : null,
            thumbMime: typeof thumbMime === 'string' ? thumbMime : null,
        }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload));
    
    console.log(`[SC] Stored manifest ${safeId} for user ${req.user.id}`);
    res.json({ ok: true, manifestId: safeId });
});

// List manifests - now includes metadata for fast client-side deduplication
app.get('/api/cloud/manifests', authenticateToken, blockDeletedSubscription, (req, res) => {
    const rawOffset = req.query && req.query.offset ? req.query.offset : null;
    const rawLimit = req.query && req.query.limit ? req.query.limit : null;
    const includeMeta = req.query && req.query.meta === 'true'; // ?meta=true to include hash metadata
    const offset = rawOffset !== null ? Math.max(0, parseInt(String(rawOffset), 10) || 0) : 0;
    const limit = rawLimit !== null ? Math.max(0, parseInt(String(rawLimit), 10) || 0) : 0;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);
    if (!fs.existsSync(manifestsDir)) return res.json({ manifests: [], total: 0 });
    
    const files = fs.readdirSync(manifestsDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => !f.startsWith('.')); // Skip hidden files like .DS_Store
    
    let list = files.map(f => {
        const manifestId = f.replace(/\.json$/, '');
        const entry = { manifestId };
        
        // Include metadata if requested (for fast dedup without decryption)
        if (includeMeta) {
            try {
                const manifestPath = path.join(manifestsDir, f);
                const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (content.meta) {
                    entry.filename = content.meta.filename || null;
                    entry.mediaType = content.meta.mediaType || null;
                    entry.originalSize = content.meta.originalSize || null;
                    entry.fileHash = content.meta.fileHash || null;
                    entry.perceptualHash = content.meta.perceptualHash || null;
                    entry.creationTime = content.meta.creationTime || null;
                    // EXIF metadata for cross-platform dedup
                    entry.exifCaptureTime = content.meta.exifCaptureTime || null;
                    entry.exifMake = content.meta.exifMake || null;
                    entry.exifModel = content.meta.exifModel || null;
                    entry.thumbChunkId = content.meta.thumbChunkId || null;
                    entry.thumbNonce = content.meta.thumbNonce || null;
                    entry.thumbSize = content.meta.thumbSize || null;
                    entry.thumbW = content.meta.thumbW || null;
                    entry.thumbH = content.meta.thumbH || null;
                    entry.thumbMime = content.meta.thumbMime || null;
                }
            } catch (e) {
                // Ignore read errors, just return manifestId
            }
        }
        
        return entry;
    });

    list.sort((a, b) => String(a.manifestId || '').localeCompare(String(b.manifestId || '')));
    const total = list.length;
    if (limit > 0) {
        list = list.slice(offset, offset + limit);
    }

    res.json({ manifests: list, total });
});

// Download encrypted manifest
app.get('/api/cloud/manifests/:manifestId', authenticateToken, blockDeletedSubscription, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', '');
    const safeId = (req.params.manifestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeId) return res.status(400).json({ error: 'Invalid manifest id' });
    const { manifestsDir: manifestsRoot } = ensureStealthCloudUserDirs(req.user);
    const manifestPath = path.join(manifestsRoot, `${safeId}.json`);
    if (!manifestPath.startsWith(manifestsRoot)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Manifest not found' });
    res.sendFile(manifestPath);
});

// Update manifest metadata (backfill for old manifests missing metadata)
app.patch('/api/cloud/manifests/:manifestId', authenticateToken, (req, res) => {
    const safeId = (req.params.manifestId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    if (!safeId) return res.status(400).json({ error: 'Invalid manifest id' });
    
    const { manifestsDir } = ensureStealthCloudUserDirs(req.user);
    const manifestPath = path.join(manifestsDir, `${safeId}.json`);
    
    if (!manifestPath.startsWith(manifestsDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(manifestPath)) {
        return res.status(404).json({ error: 'Manifest not found' });
    }
    
    try {
        const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const {
            filename, mediaType, originalSize, fileHash, perceptualHash,
            creationTime, exifCaptureTime, exifMake, exifModel,
            thumbChunkId, thumbNonce, thumbSize, thumbW, thumbH, thumbMime
        } = req.body || {};
        
        // Initialize meta if missing
        if (!content.meta) content.meta = {};
        
        // Only update fields that are provided and not already set
        if (filename && !content.meta.filename) content.meta.filename = filename;
        if (mediaType && !content.meta.mediaType) content.meta.mediaType = mediaType;
        if (typeof originalSize === 'number' && !content.meta.originalSize) content.meta.originalSize = originalSize;
        if (fileHash && !content.meta.fileHash) content.meta.fileHash = fileHash;
        if (perceptualHash && !content.meta.perceptualHash) content.meta.perceptualHash = perceptualHash;
        if (creationTime && !content.meta.creationTime) content.meta.creationTime = creationTime;
        if (exifCaptureTime && !content.meta.exifCaptureTime) content.meta.exifCaptureTime = exifCaptureTime;
        if (exifMake && !content.meta.exifMake) content.meta.exifMake = exifMake;
        if (exifModel && !content.meta.exifModel) content.meta.exifModel = exifModel;
        if (thumbChunkId && !content.meta.thumbChunkId) content.meta.thumbChunkId = thumbChunkId;
        if (thumbNonce && !content.meta.thumbNonce) content.meta.thumbNonce = thumbNonce;
        if (typeof thumbSize === 'number' && !content.meta.thumbSize) content.meta.thumbSize = thumbSize;
        if (typeof thumbW === 'number' && !content.meta.thumbW) content.meta.thumbW = thumbW;
        if (typeof thumbH === 'number' && !content.meta.thumbH) content.meta.thumbH = thumbH;
        if (thumbMime && !content.meta.thumbMime) content.meta.thumbMime = thumbMime;
        
        fs.writeFileSync(manifestPath, JSON.stringify(content));
        // Invalidate dedup cache so backfilled hashes are picked up immediately
        try { serverDedupCache.delete(manifestsDir); } catch (e) {}
        console.log(`[SC] Updated metadata for manifest ${safeId}`);
        res.json({ ok: true, manifestId: safeId });
    } catch (e) {
        console.error('[SC] Failed to update manifest metadata:', e.message);
        res.status(500).json({ error: 'Failed to update manifest' });
    }
});

// ============================================================================
// STEALTHCLOUD RAW MODE (Unencrypted fast uploads - optional)
// ============================================================================

// Upload raw file to StealthCloud (unencrypted mode)
app.post('/api/cloud/raw', authenticateToken, requireUploadSubscription, express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    const filename = (req.headers['x-filename'] || '').toString();
    if (!filename) return res.status(400).json({ error: 'Missing X-Filename header' });
    
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    // Check quota
    const fileSize = req.body?.length || 0;
    const reservation = await reserveStealthCloudIncomingBytes({ userId: req.user.id, incomingBytes: fileSize });
    if (!reservation.allowed) {
        return res.status(413).json({
            error: 'Storage limit reached',
            code: 'QUOTA_EXCEEDED',
            usedBytes: reservation.usedBytes,
            quotaBytes: reservation.quotaBytes,
            remainingBytes: reservation.remainingBytes,
        });
    }
    
    try {
        // Compute file hash for deduplication
        const fileHash = crypto.createHash('sha256').update(req.body).digest('hex');
        
        // Check if file already exists (by hash)
        const existingFiles = fs.readdirSync(rawDir);
        for (const existing of existingFiles) {
            const existingPath = path.join(rawDir, existing);
            if (fs.statSync(existingPath).isFile()) {
                const existingHash = crypto.createHash('sha256').update(fs.readFileSync(existingPath)).digest('hex');
                if (existingHash === fileHash) {
                    reservation.release();
                    return res.json({ 
                        success: true, 
                        filename: existing, 
                        fileHash,
                        duplicate: true,
                        message: 'File already exists (duplicate)'
                    });
                }
            }
        }
        
        // Write file
        fs.writeFileSync(filePath, req.body);
        
        console.log(`[SC-RAW] Uploaded: ${safeName} (${fileSize} bytes) for user ${req.user.id}`);
        
        res.json({ 
            success: true, 
            filename: safeName, 
            fileHash,
            size: fileSize,
            duplicate: false
        });
    } catch (e) {
        console.error(`[SC-RAW] Upload failed for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to save file' });
    } finally {
        try { reservation.release(); } catch (e) {}
    }
});

// Upload metadata (thumbnail, EXIF) for a raw file
app.post('/api/cloud/raw/:filename/meta', authenticateToken, express.json({ limit: '10mb' }), (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    
    if (!metaPath.startsWith(rawMetaDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const meta = req.body || {};
    
    try {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        console.log(`[SC-RAW] Saved metadata for ${safeName}`);
        res.json({ success: true, filename: safeName });
    } catch (e) {
        console.error(`[SC-RAW] Failed to save metadata for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to save metadata' });
    }
});

// List raw files
app.get('/api/cloud/raw', authenticateToken, (req, res) => {
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const includeMeta = req.query.meta === 'true';
    
    if (!fs.existsSync(rawDir)) {
        return res.json({ files: [], total: 0 });
    }
    
    try {
        const files = fs.readdirSync(rawDir)
            .filter(f => !f.startsWith('.'))
            .map(filename => {
                const filePath = path.join(rawDir, filename);
                const stats = fs.statSync(filePath);
                if (!stats.isFile()) return null;
                
                const file = {
                    type: 'raw',
                    filename,
                    size: stats.size,
                    createdAt: stats.mtime.toISOString(),
                };
                
                // Include metadata if requested
                if (includeMeta) {
                    const metaPath = path.join(rawMetaDir, `${filename}.json`);
                    if (fs.existsSync(metaPath)) {
                        try {
                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                            file.meta = meta;
                        } catch (e) {}
                    }
                }
                
                return file;
            })
            .filter(Boolean);
        
        res.json({ files, total: files.length });
    } catch (e) {
        console.error('[SC-RAW] List error:', e.message);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Download raw file
app.get('/api/cloud/raw/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    res.sendFile(filePath);
});

// Get thumbnail for raw file
app.get('/api/cloud/raw/:filename/thumb', authenticateToken, async (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    
    // First check if we have a stored thumbnail in metadata
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    if (fs.existsSync(metaPath)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.thumbBase64) {
                const thumbBuffer = Buffer.from(meta.thumbBase64, 'base64');
                res.setHeader('Content-Type', meta.thumbMime || 'image/jpeg');
                return res.send(thumbBuffer);
            }
        } catch (e) {}
    }
    
    // Generate thumbnail on-the-fly if sharp is available
    const filePath = path.join(rawDir, safeName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    const ext = path.extname(safeName).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw', '.raf', '.psd', '.psb', '.exr', '.hdr', '.avif'].includes(ext);
    const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp'].includes(ext);
    
    if (isImage && sharp) {
        try {
            // Read file into buffer first to avoid Sharp holding file handle open on Windows
            const fileBuffer = fs.readFileSync(filePath);
            const thumbBuffer = await sharp(fileBuffer, { pages: 1 })
                .resize(220, 220, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 60 })
                .toBuffer();
            res.setHeader('Content-Type', 'image/jpeg');
            return res.send(thumbBuffer);
        } catch (e) {
            console.log(`[SC-RAW] Thumb generation failed for ${safeName}:`, e.message);
        }
    }
    
    // For videos, try ffmpeg if available
    if (isVideo && ffmpegPath !== 'ffmpeg') {
        try {
            const { execSync } = require('child_process');
            const tmpThumb = path.join(rawMetaDir, `${safeName}.thumb.jpg`);
            execSync(`"${ffmpegPath}" -y -i "${filePath}" -ss 00:00:01 -vframes 1 -vf "scale=220:-1" "${tmpThumb}"`, { timeout: 10000 });
            if (fs.existsSync(tmpThumb)) {
                const thumbBuffer = fs.readFileSync(tmpThumb);
                fs.unlinkSync(tmpThumb);
                res.setHeader('Content-Type', 'image/jpeg');
                return res.send(thumbBuffer);
            }
        } catch (e) {
            console.log(`[SC-RAW] Video thumb failed for ${safeName}:`, e.message);
        }
    }
    
    res.status(404).json({ error: 'Thumbnail not available' });
});

// Delete raw file
app.delete('/api/cloud/raw/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    
    const { rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const filePath = path.join(rawDir, safeName);
    const metaPath = path.join(rawMetaDir, `${safeName}.json`);
    
    if (!filePath.startsWith(rawDir)) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        console.log(`[SC-RAW] Deleted: ${safeName}`);
        res.json({ success: true, filename: safeName });
    } catch (e) {
        console.error(`[SC-RAW] Delete failed for ${safeName}:`, e.message);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Unified list: Get both encrypted manifests and raw files
app.get('/api/cloud/files', authenticateToken, (req, res) => {
    const { manifestsDir, rawDir, rawMetaDir } = ensureStealthCloudUserDirs(req.user);
    const includeMeta = req.query.meta === 'true';
    
    const files = [];
    
    // Get encrypted files from manifests
    if (fs.existsSync(manifestsDir)) {
        try {
            const manifests = fs.readdirSync(manifestsDir)
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    try {
                        const manifestPath = path.join(manifestsDir, f);
                        const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        return {
                            type: 'encrypted',
                            manifestId: f.replace('.json', ''),
                            filename: content.filename || f,
                            size: content.size || 0,
                            createdAt: content.createdAt || null,
                            mediaType: content.mediaType || null,
                        };
                    } catch (e) {
                        return null;
                    }
                })
                .filter(Boolean);
            files.push(...manifests);
        } catch (e) {}
    }
    
    // Get raw files
    if (fs.existsSync(rawDir)) {
        try {
            const rawFiles = fs.readdirSync(rawDir)
                .filter(f => !f.startsWith('.'))
                .map(filename => {
                    const filePath = path.join(rawDir, filename);
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) return null;
                    
                    const file = {
                        type: 'raw',
                        filename,
                        size: stats.size,
                        createdAt: stats.mtime.toISOString(),
                    };
                    
                    if (includeMeta) {
                        const metaPath = path.join(rawMetaDir, `${filename}.json`);
                        if (fs.existsSync(metaPath)) {
                            try {
                                file.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                            } catch (e) {}
                        }
                    }
                    
                    return file;
                })
                .filter(Boolean);
            files.push(...rawFiles);
        } catch (e) {}
    }
    
    res.json({ files, total: files.length });
});

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
        
        // Delete user from database
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM user_plans WHERE user_id = ?', [userId], (err) => {
                if (err) console.error('[Account Deletion] Error deleting user_plans:', err.message);
                resolve();
            });
        });
        
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
// CROSS-APP DEVICE LINKING (QR Pairing: mobile-v2 ↔ solana-seeker etc.)
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
// NFT IMAGE STORAGE (StealthCloud-based, publicly accessible)
// ============================================================================

// NFT images are stored in a separate 'nft' folder per user
// They are NOT encrypted so they can be served publicly for NFT metadata
const NFT_DIR = path.join(CLOUD_DIR, 'nft');
if (!fs.existsSync(NFT_DIR)) {
    fs.mkdirSync(NFT_DIR, { recursive: true });
}

const resolveNftStorageKeyFromUser = (user) => {
    return sanitizeUserKey(getStealthCloudUserKey(user));
};

const resolveNftStorageKeyFromParam = async (userIdParam) => {
    const raw = String(userIdParam || '');
    if (!raw) return '';
    if (/^\d+$/.test(raw)) {
        try {
            // Look up the user's most recent device_uuid (primary storage key)
            const deviceRow = await dbGetAsync(
                `SELECT device_uuid FROM devices WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
                [Number(raw)]
            );
            if (deviceRow && deviceRow.device_uuid) {
                const key = sanitizeUserKey(deviceRow.device_uuid);
                if (key) return key;
            }
            // Fallback to storage_uuid if no device found
            const userRow = await dbGetAsync(`SELECT storage_uuid FROM users WHERE id = ?`, [Number(raw)]);
            const key = sanitizeUserKey(userRow && userRow.storage_uuid);
            return key || sanitizeUserKey(raw);
        } catch (e) {
            return sanitizeUserKey(raw);
        }
    }
    return sanitizeUserKey(raw);
};

// Ensure user NFT directory exists
const ensureUserNftDir = (userKey) => {
    const safeUserKey = sanitizeUserKey(userKey);
    const userNftDir = path.join(NFT_DIR, safeUserKey);
    if (!fs.existsSync(userNftDir)) {
        fs.mkdirSync(userNftDir, { recursive: true });
    }
    return userNftDir;
};

// Check if user has StealthCloud subscription with available space
const checkNftStorageEligibility = async (userId, fileSizeBytes) => {
    // First check subscription status - trial users should also be eligible
    const subscriptionState = await resolveSubscriptionState(userId);
    const isActiveSubscription = subscriptionState.status === 'active' || subscriptionState.status === 'trial' || subscriptionState.status === 'premium_only';
    
    if (!isActiveSubscription) {
        return { eligible: false, reason: 'No active StealthCloud plan' };
    }
    
    const quotaBytes = await getUserQuotaBytes(userId);
    const usedBytes = await getUserUsedBytes(userId);
    
    // If user has active/trial status but no plan_gb set, use default trial quota (5GB)
    const effectiveQuotaBytes = quotaBytes > 0 ? quotaBytes : (5 * 1000 * 1000 * 1000);
    
    const availableBytes = effectiveQuotaBytes - usedBytes;
    if (fileSizeBytes > availableBytes) {
        return { 
            eligible: false, 
            reason: 'Not enough space',
            availableBytes,
            requiredBytes: fileSizeBytes,
        };
    }
    
    return { 
        eligible: true, 
        quotaBytes: effectiveQuotaBytes, 
        usedBytes, 
        availableBytes,
    };
};

// Upload NFT image to StealthCloud (authenticated)
// POST /api/nft/upload
// Body: multipart form with 'image' file
// Returns: { success, imageId, publicUrl }
const nftUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        // Accept all image formats that mobile/desktop clients can send
        // Matches solana-seeker/nftOperations.js uploadToStealthCloud MIME map
        const allowed = /^(image\/(jpeg|png|gif|webp|heic|heif|tiff|avif|x-adobe-dng|x-canon-cr[23]|x-nikon-nef|x-sony-arw|x-fuji-raf|x-olympus-orf|x-panasonic-rw2|x-pentax-pef|x-samsung-srw)|application\/octet-stream)$/;
        if (allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported image format: ${file.mimetype}`));
        }
    },
});

app.post('/api/nft/upload', authenticateToken, (req, res, next) => {
    nftUpload.single('image')(req, res, (err) => {
        if (err) {
            console.error('[NFT] Upload multer error:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        
        const userId = req.user.id;
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const fileSize = req.file.size;
        
        // NFT uploads are allowed for all authenticated users without subscription check
        // NFT images/thumbnails are essential for NFT functionality and users pay commission per mint
        // No quota check - NFT storage is separate from backup storage
        
        // Generate unique image ID
        const imageId = crypto.randomBytes(16).toString('hex');
        const mimeToExt = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
            'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/avif': 'avif',
            'image/x-adobe-dng': 'dng', 'image/x-canon-cr2': 'cr2', 'image/x-canon-cr3': 'cr3',
            'image/x-nikon-nef': 'nef', 'image/x-sony-arw': 'arw', 'image/x-fuji-raf': 'raf',
            'image/x-olympus-orf': 'orf', 'image/x-panasonic-rw2': 'rw2', 'image/x-pentax-pef': 'pef',
            'image/x-samsung-srw': 'srw', 'application/octet-stream': 'bin',
        };
        const ext = mimeToExt[req.file.mimetype] || 'jpg';
        const filename = `${imageId}.${ext}`;
        
        // Save to user's NFT directory
        const userNftDir = ensureUserNftDir(userKey);
        const filePath = path.join(userNftDir, filename);
        fs.writeFileSync(filePath, req.file.buffer);
        
        // Public URL (served via nft.stealthlynk.io or /api/nft/image/:userId/:imageId)
        const publicUrl = `https://nft.stealthlynk.io/${userKey}/${filename}`;
        const fallbackUrl = `/api/nft/image/${userKey}/${filename}`;
        
        console.log(`[NFT] Image uploaded: user=${userId} id=${imageId} size=${fileSize}`);
        
        res.json({
            success: true,
            imageId,
            filename,
            publicUrl,
            fallbackUrl,
            size: fileSize,
        });
    } catch (error) {
        console.error('[NFT] Upload error:', error);
        res.status(500).json({ error: 'Failed to upload NFT image' });
    }
});

// Check NFT storage eligibility (for UI to show/hide option)
// GET /api/nft/eligibility?size=<bytes>
app.get('/api/nft/eligibility', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const fileSize = parseInt(req.query.size) || 5 * 1024 * 1024; // Default 5MB estimate
        
        const eligibility = await checkNftStorageEligibility(userId, fileSize);
        res.json(eligibility);
    } catch (error) {
        console.error('[NFT] Eligibility check error:', error);
        res.status(500).json({ error: 'Failed to check eligibility' });
    }
});

// List user's NFT images
// GET /api/nft/images
app.get('/api/nft/images', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const userNftDir = path.join(NFT_DIR, String(userKey));
        
        if (!fs.existsSync(userNftDir)) {
            return res.json({ images: [] });
        }
        
        const files = fs.readdirSync(userNftDir);
        const images = files.map(f => {
            const filePath = path.join(userNftDir, f);
            const stats = fs.statSync(filePath);
            return {
                filename: f,
                imageId: f.replace(/\.[^.]+$/, ''),
                publicUrl: `https://nft.stealthlynk.io/${userKey}/${f}`,
                fallbackUrl: `/api/nft/image/${userKey}/${f}`,
                size: stats.size,
                createdAt: stats.birthtime,
            };
        });
        
        res.json({ images });
    } catch (error) {
        console.error('[NFT] List images error:', error);
        res.status(500).json({ error: 'Failed to list NFT images' });
    }
});

// PUBLIC: Serve NFT image (no authentication required)
// GET /api/nft/image/:userId/:filename OR /:userId/:filename (for nft.stealthlynk.io subdomain)
// This endpoint is publicly accessible so NFT wallets/marketplaces can display images
const serveNftImage = async (req, res) => {
    try {
        const { userId, filename } = req.params;
        const safeFilename = String(filename).replace(/[^a-zA-Z0-9._-]/g, '');
        const safeKey = await resolveNftStorageKeyFromParam(userId);
        
        if (!safeKey || !safeFilename) {
            return res.status(400).json({ error: 'Invalid request' });
        }

        let filePath = path.join(NFT_DIR, safeKey, safeFilename);
        if (!fs.existsSync(filePath)) {
            // Backward compat: try the raw userId param as-is (could be old storage_uuid, device_uuid, or numeric id)
            const rawKey = sanitizeUserKey(userId);
            if (rawKey && rawKey !== safeKey) {
                const legacyPath = path.join(NFT_DIR, rawKey, safeFilename);
                if (fs.existsSync(legacyPath)) filePath = legacyPath;
            }
            // Also try storage_uuid if numeric
            if (!fs.existsSync(filePath) && /^\d+$/.test(String(userId))) {
                try {
                    const userRow = await dbGetAsync(`SELECT storage_uuid FROM users WHERE id = ?`, [Number(userId)]);
                    if (userRow && userRow.storage_uuid) {
                        const suKey = sanitizeUserKey(userRow.storage_uuid);
                        if (suKey && suKey !== safeKey) {
                            const suPath = path.join(NFT_DIR, suKey, safeFilename);
                            if (fs.existsSync(suPath)) filePath = suPath;
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        // Determine content type
        const ext = path.extname(safeFilename).toLowerCase();
        const contentTypes = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
            '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.tiff': 'image/tiff',
            '.tif': 'image/tiff', '.avif': 'image/avif', '.dng': 'image/x-adobe-dng',
            '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3', '.nef': 'image/x-nikon-nef',
            '.arw': 'image/x-sony-arw', '.raf': 'image/x-fuji-raf', '.orf': 'image/x-olympus-orf',
            '.rw2': 'image/x-panasonic-rw2', '.pef': 'image/x-pentax-pef', '.srw': 'image/x-samsung-srw',
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        
        // Set cache headers for CDN/browser caching
        // Override helmet's restrictive CORP header for public NFT images
        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable', // 1 year cache
            'Access-Control-Allow-Origin': '*', // Allow cross-origin for NFT viewers
            'Cross-Origin-Resource-Policy': 'cross-origin', // Allow embedding in any origin
        });
        
        res.sendFile(filePath);
    } catch (error) {
        console.error('[NFT] Serve image error:', error);
        res.status(500).json({ error: 'Failed to serve image' });
    }
};

// Register both routes for NFT image serving
app.get('/api/nft/image/:userId/:filename', serveNftImage);
// Also handle /:userId/:filename for nft.stealthlynk.io subdomain (no /api/nft/image prefix)
app.get('/:userId/:filename', (req, res, next) => {
    const { filename } = req.params;
    if (/\.(jpg|jpeg|png|gif|webp|bin|heic|heif|tiff|tif|avif|dng|cr2|cr3|nef|arw|raf|orf|rw2|pef|srw)$/i.test(filename)) {
        return serveNftImage(req, res);
    }
    next(); // Pass to other routes if not an NFT image request
});

// Delete NFT image (authenticated, owner only)
// DELETE /api/nft/image/:imageId
app.delete('/api/nft/image/:imageId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const { imageId } = req.params;
        
        const userNftDir = path.join(NFT_DIR, String(userKey));
        if (!fs.existsSync(userNftDir)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        // Find file with this imageId
        const files = fs.readdirSync(userNftDir);
        const file = files.find(f => f.startsWith(imageId));
        
        if (!file) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        const filePath = path.join(userNftDir, file);
        fs.unlinkSync(filePath);
        
        console.log(`[NFT] Image deleted: user=${userId} id=${imageId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('[NFT] Delete image error:', error);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// ============================================================================
// NFT ALBUM SYNC (persists NFT metadata across app reinstalls)
// ============================================================================

// NFT metadata storage file per user
const getNftMetadataPath = (userKey) => path.join(NFT_DIR, String(userKey), 'nft-album.json');

// Helper: read NFTs from all linked device folders and merge (dedup by mintAddress)
const readMergedNftsForDevice = async (deviceUuid) => {
    const linkedUuids = await getLinkedDeviceUuids(deviceUuid);
    const normalizeMint = (m) => m ? String(m).replace(/^cnft_/, '') : '';
    const seen = new Set();
    const merged = [];

    for (const uuid of linkedUuids) {
        const metaPath = getNftMetadataPath(uuid);
        if (!fs.existsSync(metaPath)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const nfts = data.nfts || [];
            for (const nft of nfts) {
                const key = normalizeMint(nft.mintAddress);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                // Strip large data: URIs before sending to mobile (prevents OOM on Android)
                // On-chain NFTs embed multi-MB base64 images that blow up JSON.parse on low-memory devices
                // The client re-fetches these from DAS/metadata if needed
                if (nft.imageUrl && nft.imageUrl.startsWith('data:') && nft.imageUrl.length > 5000) {
                    nft.imageUrl = undefined;
                }
                if (nft.arweaveUrl && nft.arweaveUrl.startsWith('data:') && nft.arweaveUrl.length > 5000) {
                    nft.arweaveUrl = undefined;
                }
                merged.push(nft);
            }
        } catch (e) {
            // Skip corrupt files
        }
    }
    return merged;
};

// Get user's NFT album (list of minted NFTs) — merges linked device folders
// GET /api/nft/list
app.get('/api/nft/list', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const deviceUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);

        const nfts = await readMergedNftsForDevice(deviceUuid || userKey);
        console.log(`[NFT] Album list: user=${userId} userKey=${userKey} count=${nfts.length} device_uuid=${deviceUuid || 'none'}`);
        res.json({ success: true, nfts });
    } catch (error) {
        console.error('[NFT] List error:', error);
        res.status(500).json({ error: 'Failed to get NFT list' });
    }
});

// Sync NFT album (add, remove, or backup NFTs)
// POST /api/nft/sync
// Body: { action: 'add'|'remove'|'backup', nft?: {}, mintAddress?: '', nfts?: [] }
app.post('/api/nft/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const { action, nft, mintAddress, nfts } = req.body;
        console.log(`[NFT] Sync request: user=${userId} userKey=${userKey} action=${action} device_uuid=${req.user.device_uuid || 'none'}`);
        
        const userNftDir = path.join(NFT_DIR, String(userKey));
        if (!fs.existsSync(userNftDir)) {
            fs.mkdirSync(userNftDir, { recursive: true });
        }
        
        const metadataPath = getNftMetadataPath(userKey);
        let data = { nfts: [] };
        
        if (fs.existsSync(metadataPath)) {
            try {
                data = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            } catch (e) {
                data = { nfts: [] };
            }
        }
        
        if (action === 'add' && nft) {
            // Add or update single NFT
            const idx = data.nfts.findIndex(n => n.mintAddress === nft.mintAddress);
            if (idx >= 0) {
                // Merge new fields into existing (preserves fields the sender may not have)
                const existing = data.nfts[idx];
                const mergeFields = ['encryptionData','thumbnailUrl','imageUrl','edition','encrypted','watermarked','license','storageType','nftType','isCompressed','assetId','txSignature','attributes','createdAt','mintedAt','ipfsThumbnailUrl','metadataUrl','contentHash','exifHash','exifRawHash','exifBindingHash','hasRfc3161','hasC2pa','certificationMode','mintPlatform'];
                let updated = 0;
                for (const f of mergeFields) {
                    if (nft[f] !== undefined && nft[f] !== null && (existing[f] === undefined || existing[f] === null)) {
                        existing[f] = nft[f];
                        updated++;
                    }
                }
                // Always overwrite encryptionData and thumbnailUrl if sender has them (these are critical)
                if (nft.encryptionData) { existing.encryptionData = nft.encryptionData; updated++; }
                if (nft.thumbnailUrl) { existing.thumbnailUrl = nft.thumbnailUrl; updated++; }
                data.nfts[idx] = existing;
                if (updated > 0) console.log(`[NFT] Album update: user=${userId} mint=${nft.mintAddress} fields=${updated}`);
            } else {
                data.nfts.push(nft);
                console.log(`[NFT] Album add: user=${userId} mint=${nft.mintAddress}`);
            }
        } else if (action === 'remove' && mintAddress) {
            // Remove NFT by mint address
            const before = data.nfts.length;
            data.nfts = data.nfts.filter(n => n.mintAddress !== mintAddress);
            console.log(`[NFT] Album remove: user=${userId} mint=${mintAddress} removed=${before - data.nfts.length}`);
        } else if (action === 'backup' && Array.isArray(nfts)) {
            // Backup: merge all NFTs (add new, update existing with missing fields)
            const existingMap = {};
            const existingMetaMap = {};
            data.nfts.forEach((n, i) => {
                if (n.mintAddress) existingMap[n.mintAddress] = i;
                if (n.metadataUrl) existingMetaMap[n.metadataUrl] = i;
            });
            let added = 0;
            let updated = 0;
            let deduped = 0;
            const mergeFields = ['encryptionData','thumbnailUrl','imageUrl','edition','encrypted','watermarked','license','storageType','nftType','isCompressed','assetId','txSignature','attributes','createdAt','mintedAt','ipfsThumbnailUrl','metadataUrl','contentHash','exifHash','exifRawHash','exifBindingHash','hasRfc3161','hasC2pa','certificationMode','mintPlatform'];
            for (const n of nfts) {
                if (!n.mintAddress) continue;
                // Skip tx_ temp entries if a real entry with same metadataUrl already exists
                if (n.mintAddress.startsWith('tx_') && n.metadataUrl && existingMetaMap[n.metadataUrl] !== undefined) {
                    const realIdx = existingMetaMap[n.metadataUrl];
                    if (data.nfts[realIdx] && !data.nfts[realIdx].mintAddress.startsWith('tx_')) {
                        // Merge encryption fields from tx_ entry into real entry
                        const real = data.nfts[realIdx];
                        if (n.encryptionData && !real.encryptionData) real.encryptionData = n.encryptionData;
                        if (n.thumbnailUrl && !real.thumbnailUrl) real.thumbnailUrl = n.thumbnailUrl;
                        deduped++;
                        continue;
                    }
                }
                const idx = existingMap[n.mintAddress];
                if (idx === undefined) {
                    // Before adding, check if a tx_ entry exists with same metadataUrl — replace it
                    if (n.metadataUrl && !n.mintAddress.startsWith('tx_') && existingMetaMap[n.metadataUrl] !== undefined) {
                        const oldIdx = existingMetaMap[n.metadataUrl];
                        if (data.nfts[oldIdx] && data.nfts[oldIdx].mintAddress.startsWith('tx_')) {
                            const old = data.nfts[oldIdx];
                            data.nfts[oldIdx] = { ...old, ...n };
                            existingMap[n.mintAddress] = oldIdx;
                            deduped++;
                            continue;
                        }
                    }
                    data.nfts.push(n);
                    existingMap[n.mintAddress] = data.nfts.length - 1;
                    if (n.metadataUrl) existingMetaMap[n.metadataUrl] = data.nfts.length - 1;
                    added++;
                } else {
                    // Merge missing fields + always overwrite critical encryption fields
                    const existing = data.nfts[idx];
                    for (const f of mergeFields) {
                        if (n[f] !== undefined && n[f] !== null && (existing[f] === undefined || existing[f] === null)) {
                            existing[f] = n[f];
                            updated++;
                        }
                    }
                    if (n.encryptionData) { existing.encryptionData = n.encryptionData; }
                    if (n.thumbnailUrl) { existing.thumbnailUrl = n.thumbnailUrl; }
                    data.nfts[idx] = existing;
                }
            }
            console.log(`[NFT] Album backup: user=${userId} added=${added} updated=${updated} total=${data.nfts.length}`);
        } else if (action === 'get') {
            // Return all NFTs for this user + linked devices (used by mobile-v2 to merge with DAS results)
            const deviceUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);
            const mergedNfts = await readMergedNftsForDevice(deviceUuid || userKey);
            return res.json({ success: true, nfts: mergedNfts });
        } else {
            return res.status(400).json({ error: 'Invalid action or missing data' });
        }
        
        // Strip large data: URIs before persisting (on-chain NFTs embed multi-MB base64)
        // Prevents nft-album.json from growing to 100MB+ and causing OOM on re-read
        for (const n of data.nfts) {
            if (n.imageUrl && n.imageUrl.startsWith('data:') && n.imageUrl.length > 5000) n.imageUrl = undefined;
            if (n.arweaveUrl && n.arweaveUrl.startsWith('data:') && n.arweaveUrl.length > 5000) n.arweaveUrl = undefined;
        }
        // Save updated metadata
        fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2));
        res.json({ success: true, count: data.nfts.length });
    } catch (error) {
        console.error('[NFT] Sync error:', error);
        res.status(500).json({ error: 'Failed to sync NFT album' });
    }
});

// Get/sync NFT certificates (Limited Edition CoA)
// GET /api/nft/certificates - returns all certificates for the user
// POST /api/nft/certificates - sync certificates { action: 'add'|'backup', certificate?: {}, certificates?: [] }
app.get('/api/nft/certificates', authenticateToken, async (req, res) => {
    try {
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const deviceUuid = sanitizeUserKey(req.user.device_uuid || req.user.deviceUuid);
        // Merge certificates from all linked device folders
        const linkedUuids = await getLinkedDeviceUuids(deviceUuid || userKey);
        const seenIds = new Set();
        let certs = [];
        for (const uuid of linkedUuids) {
            const cp = path.join(NFT_DIR, String(uuid), 'certificates.json');
            if (!fs.existsSync(cp)) continue;
            try {
                const parsed = JSON.parse(fs.readFileSync(cp, 'utf8'));
                for (const c of (Array.isArray(parsed) ? parsed : [])) {
                    const key = c.mintAddress || c.id || JSON.stringify(c);
                    if (seenIds.has(key)) continue;
                    seenIds.add(key);
                    certs.push(c);
                }
            } catch (_) {}
        }
        const full = req.query.full === 'true';
        // Fields safe for the API response (mobile OOM-safe — no large base64 blobs)
        const API_SLIM_KEYS = ['id','name','mintAddress','txSignature','creatorWallet','ownerAddress',
            'issuedAt','createdAt','edition','license','contentHash','exifHash','cameraHash',
            'exifRawHash','exifBindingHash','rfc3161Policy','mintedAt',
            'hasRfc3161','hasC2pa','encrypted','watermarked','storageType','nftType','isCompressed',
            'rfc3161Tsa','metadataUrl','description','version','type','imageUrl','certificationMode'];
        // Disk-safe keys: same as API + rfc3161Token + c2paManifest (these MUST survive on disk)
        const DISK_SAFE_KEYS = [...API_SLIM_KEYS, 'rfc3161Token', 'c2paManifest'];
        const keysToUse = full ? DISK_SAFE_KEYS : API_SLIM_KEYS;
        const slimForApi = (c) => {
            const copy = {};
            for (const k of keysToUse) { if (c[k] !== undefined) copy[k] = c[k]; }
            if (c.rfc3161Token) copy.hasRfc3161 = true;
            if (c.c2paManifest) copy.hasC2pa = true;
            // Strip base64 data URIs from imageUrl — these can be megabytes each
            if (copy.imageUrl && copy.imageUrl.startsWith('data:') && copy.imageUrl.length > 5000) delete copy.imageUrl;
            return copy;
        };
        const slimForDisk = (c) => {
            const copy = {};
            for (const k of DISK_SAFE_KEYS) { if (c[k] !== undefined) copy[k] = c[k]; }
            if (c.rfc3161Token) copy.hasRfc3161 = true;
            if (c.c2paManifest) copy.hasC2pa = true;
            if (copy.imageUrl && copy.imageUrl.startsWith('data:') && copy.imageUrl.length > 5000) delete copy.imageUrl;
            return copy;
        };
        let needsRewrite = false;
        const apiSlim = certs.map(c => {
            // Detect if disk has non-safe fields that should be stripped (metadata, encryptionData, imageData, large imageUrl data URIs)
            if (c.metadata || c.encryptionData || c.imageData
                || (c.imageUrl && c.imageUrl.startsWith('data:') && c.imageUrl.length > 5000)) needsRewrite = true;
            return slimForApi(c);
        });
        // Compact on-disk file: strip junk fields but PRESERVE rfc3161Token + c2paManifest
        if (needsRewrite) {
            try {
                const diskSlim = certs.map(slimForDisk);
                fs.writeFileSync(certsPath, JSON.stringify(diskSlim, null, 2));
                console.log(`[NFT] Compacted certificates.json on disk for user=${userKey} (${certs.length} certs, tokens preserved)`);
            } catch (e) { console.warn('[NFT] Failed to compact certificates.json:', e.message); }
        }
        res.json({ success: true, certificates: apiSlim });
    } catch (error) {
        console.error('[NFT] Certificates fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch certificates' });
    }
});

app.post('/api/nft/certificates', authenticateToken, async (req, res) => {
    try {
        const userKey = resolveNftStorageKeyFromUser(req.user);
        const userNftDir = path.join(NFT_DIR, String(userKey));
        if (!fs.existsSync(userNftDir)) fs.mkdirSync(userNftDir, { recursive: true });
        const certsPath = path.join(userNftDir, 'certificates.json');
        
        let certs = [];
        if (fs.existsSync(certsPath)) {
            try { certs = JSON.parse(fs.readFileSync(certsPath, 'utf8')); } catch (_) {}
        }
        
        const { action, certificate, certificates } = req.body;
        const existingIds = new Set(certs.map(c => c.id));
        
        // Disk-safe keys: preserve rfc3161Token + c2paManifest so the desktop can recover them
        const DISK_SAFE_KEYS = ['id','name','mintAddress','txSignature','creatorWallet','ownerAddress',
            'issuedAt','createdAt','edition','license','contentHash','exifHash','cameraHash',
            'exifRawHash','exifBindingHash','rfc3161Policy','mintedAt',
            'hasRfc3161','hasC2pa','encrypted','watermarked','storageType','nftType','isCompressed',
            'rfc3161Tsa','metadataUrl','description','version','type','imageUrl','certificationMode',
            'rfc3161Token','c2paManifest'];
        const slimCert = (c) => {
            const copy = {};
            for (const k of DISK_SAFE_KEYS) { if (c[k] !== undefined) copy[k] = c[k]; }
            if (c.rfc3161Token) copy.hasRfc3161 = true;
            if (c.c2paManifest) copy.hasC2pa = true;
            // Strip base64 data URIs from imageUrl — these can be megabytes each
            if (copy.imageUrl && copy.imageUrl.startsWith('data:') && copy.imageUrl.length > 5000) delete copy.imageUrl;
            return copy;
        };
        
        if (action === 'add' && certificate) {
            const slimmed = slimCert(certificate);
            if (!existingIds.has(slimmed.id)) {
                certs.push(slimmed);
                console.log(`[NFT] Certificate added: user=${req.user.id} id=${certificate.id}`);
            }
        } else if (action === 'backup' && Array.isArray(certificates)) {
            let added = 0, updated = 0;
            const existingMap = {};
            certs.forEach((c, i) => { if (c.id) existingMap[c.id] = i; });
            for (const c of certificates) {
                const sc = slimCert(c);
                if (!existingIds.has(sc.id)) {
                    certs.push(sc);
                    existingIds.add(sc.id);
                    added++;
                } else {
                    // Merge enrichment fields into existing cert (don't overwrite, only fill gaps)
                    const idx = existingMap[c.id];
                    if (idx !== undefined) {
                        const ex = certs[idx];
                        let changed = false;
                        if (c.hasRfc3161 && !ex.hasRfc3161) { ex.hasRfc3161 = true; changed = true; }
                        if (c.hasC2pa && !ex.hasC2pa) { ex.hasC2pa = true; changed = true; }
                        if (c.encrypted && !ex.encrypted) { ex.encrypted = true; changed = true; }
                        if (c.watermarked && !ex.watermarked) { ex.watermarked = true; changed = true; }
                        if (c.license && !ex.license) { ex.license = c.license; changed = true; }
                        if (c.storageType && !ex.storageType) { ex.storageType = c.storageType; changed = true; }
                        if (c.contentHash && !ex.contentHash) { ex.contentHash = c.contentHash; changed = true; }
                        if (c.exifRawHash && !ex.exifRawHash) { ex.exifRawHash = c.exifRawHash; changed = true; }
                        if (c.exifHash && !ex.exifHash) { ex.exifHash = c.exifHash; changed = true; }
                        if (c.exifBindingHash && !ex.exifBindingHash) { ex.exifBindingHash = c.exifBindingHash; changed = true; }
                        if (c.cameraHash && !ex.cameraHash) { ex.cameraHash = c.cameraHash; changed = true; }
                        if (c.rfc3161Token && !ex.rfc3161Token) { ex.rfc3161Token = c.rfc3161Token; ex.hasRfc3161 = true; changed = true; }
                        if (c.c2paManifest && !ex.c2paManifest) { ex.c2paManifest = c.c2paManifest; ex.hasC2pa = true; changed = true; }
                        if (changed) updated++;
                    }
                }
            }
            console.log(`[NFT] Certificates backup: user=${req.user.id} added=${added} updated=${updated} total=${certs.length}`);
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }
        
        // Ensure only whitelisted fields persist on disk
        const cleanCerts = certs.map(c => slimCert(c));
        fs.writeFileSync(certsPath, JSON.stringify(cleanCerts, null, 2));
        res.json({ success: true, count: certs.length });
    } catch (error) {
        console.error('[NFT] Certificates sync error:', error);
        res.status(500).json({ error: 'Failed to sync certificates' });
    }
});

// ============================================================================
// NFT SERVICE (server-side minting for mobile-v2)
// ============================================================================
try {
    const nftService = require('../nft-service');
    nftService.initialize();

    app.use('/api/nft-service', authenticateToken, nftService.routes);

    // After nft-service mounts, add a dedicated endpoint for client to confirm premium storage
    // Client calls this right after a successful /api/nft-service/upgrade-premium response
    const PREMIUM_STORAGE_GB = 10;
    app.post('/api/premium/activate-storage', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.id;
            // Verify the user actually has premium in the nft-service DB
            const premiumStatus = nftService.balance.getPremiumStatus(userId);
            if (!premiumStatus || !premiumStatus.isPremium) {
                return res.status(403).json({ error: 'Not a premium user', code: 'NOT_PREMIUM' });
            }
            await ensurePlanRow(userId);
            await dbRunAsync(
                `UPDATE user_plans SET premium_gb = ?, updated_at = ? WHERE user_id = ?`,
                [PREMIUM_STORAGE_GB, Date.now(), userId]
            );
            console.log(`[Premium] Set premium_gb=${PREMIUM_STORAGE_GB} for user ${userId}`);
            const st = await resolveSubscriptionState(userId);
            return res.json({ ok: true, premiumGb: PREMIUM_STORAGE_GB, subscription: st });
        } catch (e) {
            console.error('[Premium] Failed to activate storage:', e.message);
            return res.status(500).json({ error: 'Failed to activate premium storage' });
        }
    });
    console.log('[NFT Service] Mounted at /api/nft-service');
} catch (nftServiceErr) {
    console.log('[NFT Service] Not available:', nftServiceErr.message);
}

// Solana RPC proxy - avoids CORS issues when calling from browser
app.post('/solana-rpc', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    const rpcEndpoints = [
        process.env.SOLANA_RPC_ENDPOINT,          // Custom RPC if configured (highest priority)
        'https://api.mainnet-beta.solana.com',
        'https://solana-rpc.publicnode.com',       // PublicNode - reliable free tier
        'https://rpc.ankr.com/solana',
        'https://solana.drpc.org',                 // dRPC public
        (process.env.HELIUS_RPC_KEY || process.env.HELIUS_API_KEY) ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_RPC_KEY || process.env.HELIUS_API_KEY}` : null, // Helius (env)
        'https://solana-mainnet.g.alchemy.com/v2/demo'
    ].filter(Boolean);
    
    for (const rpc of rpcEndpoints) {
        try {
            const response = await axios.post(rpc, req.body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 8000
            });
            if (response.data && !response.data.error) {
                return res.json(response.data);
            }
            // RPC returned an error object — try next
            console.log('[Solana RPC] RPC error from', rpc, ':', JSON.stringify(response.data?.error)?.slice(0, 80));
        } catch (e) {
            console.log('[Solana RPC] Failed:', rpc, e.message);
        }
    }
    
    res.status(503).json({ error: 'All RPC endpoints failed' });
});

// Handle CORS preflight for solana-rpc
app.options('/solana-rpc', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(200);
});

// Serve local images via HTTP (for Electron renderer which can't access file:// directly)
app.get('/local-image', (req, res) => {
    const imagePath = req.query.path;
    if (!imagePath) {
        return res.status(400).json({ error: 'No path provided' });
    }
    
    const resolvedPath = path.resolve(imagePath);
    
    // Allow any path for now (desktop app is trusted)
    if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.heic': 'image/heic',
        '.heif': 'image/heif',
    };
    
    // Add CORS headers for Electron renderer
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(resolvedPath).pipe(res);
});

// Serve @solana/web3.js locally - avoids CDN failures on payment page
app.get('/lib/solana-web3.js', (req, res) => {
    const candidates = [
        path.join(__dirname, '../server-tray/node_modules/@solana/web3.js/lib/index.iife.min.js'),
        path.join(__dirname, 'node_modules/@solana/web3.js/lib/index.iife.min.js'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return fs.createReadStream(p).pipe(res);
        }
    }
    res.status(404).send('// solana web3 not found locally');
});

// SOL price proxy - avoids CORS when fetching from browser
app.get('/sol-price', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sources = [
        async () => {
            const r = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 5000 });
            const p = parseFloat(r.data?.price);
            if (p > 0) return p;
        },
        async () => {
            const r = await axios.get('https://price.jup.ag/v6/price?ids=SOL', { timeout: 5000 });
            const p = r.data?.data?.SOL?.price;
            if (p > 0) return parseFloat(p);
        },
        async () => {
            const r = await axios.get('https://api.kraken.com/0/public/Ticker?pair=SOLUSD', { timeout: 5000 });
            const p = parseFloat(r.data?.result?.SOLUSD?.c?.[0] || r.data?.result?.SOLUSDT?.c?.[0]);
            if (p > 0) return p;
        },
    ];
    for (const src of sources) {
        try {
            const price = await src();
            if (price && price > 0) return res.json({ solana: { usd: price } });
        } catch (_) {}
    }
    res.status(503).json({ error: 'Price unavailable' });
});

// Temporary image token store - holds large data URIs (e.g. on-chain SVG) for the payment page
// Avoids URL length limits when passing data: URIs as query params
const nftImageTokens = {};
app.post('/nft-image-token', (req, res) => {
    const { dataUri } = req.body;
    if (!dataUri) return res.status(400).json({ error: 'No dataUri' });
    const token = require('crypto').randomBytes(12).toString('hex');
    nftImageTokens[token] = { dataUri, expires: Date.now() + 10 * 60 * 1000 }; // 10 min TTL
    // Clean up expired tokens
    for (const k of Object.keys(nftImageTokens)) {
        if (nftImageTokens[k].expires < Date.now()) delete nftImageTokens[k];
    }
    res.json({ token });
});
app.get('/nft-image-token/:token', (req, res) => {
    const entry = nftImageTokens[req.params.token];
    if (!entry || entry.expires < Date.now()) return res.status(404).json({ error: 'Token expired or not found' });
    res.json({ dataUri: entry.dataUri });
});

// NFT Payment page - served via HTTP so Phantom extension can interact with it
app.get('/nft-payment', (req, res) => {
    // Set permissive CSP to allow Solana CDN and IPFS gateways
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://bundle.run; img-src 'self' data: blob: https: http:; connect-src 'self' https: wss:; style-src 'self' 'unsafe-inline';");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PhotoLynk NFT Payment</title>
  <script src="https://bundle.run/buffer@6.0.3" onerror="console.warn('buffer CDN failed')"></script>
  <script>if(typeof window.Buffer==='undefined'&&typeof buffer!=='undefined')window.Buffer=buffer.Buffer;</script>
  <script src="/lib/solana-web3.js" onerror="console.warn('[NFT] Local solana-web3 failed, trying CDN');var s=document.createElement('script');s.src='https://unpkg.com/@solana/web3.js@1.87.6/lib/index.iife.min.js';document.head.appendChild(s);"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .nft-preview { width: 120px; height: 120px; border-radius: 16px; margin: 0 auto 20px; overflow: hidden; border: 2px solid rgba(153, 69, 255, 0.5); background: #222; }
    .nft-preview img { width: 100%; height: 100%; object-fit: cover; }
    .nft-name { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .nft-type { font-size: 12px; color: #9945FF; margin-bottom: 20px; }
    .amount-box { background: rgba(20, 241, 149, 0.1); border: 1px solid rgba(20, 241, 149, 0.3); border-radius: 12px; padding: 16px; margin-bottom: 24px; }
    .amount-label { font-size: 12px; color: #888; margin-bottom: 4px; }
    .amount-value { font-size: 28px; font-weight: 700; color: #14F195; }
    .amount-usd { font-size: 14px; color: #888; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .wallet-info { font-size: 12px; color: #666; margin-top: 16px; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container" id="main-container">
    <div class="logo">⬡</div>
    <h1>PhotoLynk NFT</h1>
    <p class="subtitle">Complete payment to mint your memory</p>
    <div class="nft-preview"><img id="nft-image" src="" alt="NFT" onerror="this.style.display='none'"></div>
    <div class="nft-name" id="nft-name">Loading...</div>
    <div class="nft-type" id="nft-type">Compressed NFT</div>
    <div class="amount-box" id="estimated-box">
      <div class="amount-label">Estimated total</div>
      <div class="amount-value" id="estimated-sol">0.000 SOL</div>
      <div class="amount-usd" id="estimated-usd">≈ $0.00 USD</div>
      <div style="font-size:10px;color:#666;margin-top:6px;">Solana fees are charged separately during mint</div>
    </div>
    <button class="btn btn-phantom" id="pay-btn"><span>👻</span> Connect Phantom & Pay</button>
    <!-- QR code and external wallets hidden for future development -->
    <div style="display:none;margin:16px 0;color:#666;font-size:12px;">— or scan with any Solana wallet —</div>
    <div id="qr-container" style="display:none;background:#fff;padding:16px;border-radius:12px;margin-bottom:12px;min-width:180px;min-height:180px;"><canvas id="qr-code" width="180" height="180" style="display:block;"></canvas></div>
    <div style="display:none;font-size:10px;color:#888;margin-bottom:8px;">Compatible wallets:</div>
    <div id="wallet-links" style="display:none;flex-wrap:wrap;justify-content:center;gap:8px;margin-bottom:16px;"></div>
    <!-- End hidden QR section -->
    <button class="btn btn-secondary" onclick="window.close()" style="margin-top:16px;">Cancel</button>
    <div class="status" id="status"></div>
    <div class="wallet-info">Recipient: <span id="recipient">...</span></div>
  </div>
  <div class="container" id="success-container" style="display:none;">
    <div class="success-icon">✅</div>
    <h1>Payment Successful!</h1>
    <p class="subtitle">Your NFT is being minted on Solana</p>
    <div class="status success" style="display:block;" id="tx-link"></div>
    <div id="success-amount" style="margin-top:12px;font-size:13px;color:#888;"></div>
    <button class="btn btn-phantom" onclick="window.close()" style="margin-top:24px;">Close Window</button>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    const recipient = params.get('recipient') || '';
    let amount = parseFloat(params.get('amount')) || 0;
    const feeUsd = parseFloat(params.get('feeUsd')) || 0;
    let solPrice = parseFloat(params.get('solPrice')) || 0;
    const estimatedTotalUsd = parseFloat(params.get('estimatedTotalUsd')) || 0;
    const estimatedTotalSol = parseFloat(params.get('estimatedTotalSol')) || 0;
    const name = params.get('name') || 'PhotoLynk Memory';
    const imageToken = params.get('imageToken') || '';
    let imageUrl = params.get('imageUrl') || '';
    const nftType = params.get('nftType') || 'compressed';
    const storageOption = params.get('storageOption') || '';
    const fileSizeBytes = parseInt(params.get('fileSizeBytes') || '0', 10) || 0;
    document.getElementById('nft-name').textContent = name;
    const typeLabel = nftType === 'compressed' ? 'Compressed NFT (cNFT)' : 'Standard NFT';
    const storageLabel = storageOption === 'cloud' ? 'StealthCloud' : storageOption === 'onchain' ? 'Embedded SVG' : (storageOption === 'ipfs' ? 'IPFS' : '');
    document.getElementById('nft-type').textContent = storageLabel ? (typeLabel + ' • ' + storageLabel) : typeLabel;
    // For on-chain SVG, imageUrl is a large data URI passed via token to avoid URL length limits
    if (imageToken) {
      fetch('/nft-image-token/' + imageToken)
        .then(r => r.json())
        .then(d => {
          if (d.dataUri) {
            imageUrl = d.dataUri;
            const img = document.getElementById('nft-image');
            if (img) img.src = d.dataUri;
          }
        })
        .catch(() => {});
    } else if (imageUrl) {
      document.getElementById('nft-image').src = imageUrl;
    }
    function renderAmounts(extra) {
      const usdRate = solPrice > 0 ? solPrice : 200;

      // If feeUsd is provided, recompute SOL amount so the USD fee stays constant
      if (feeUsd > 0 && usdRate > 0) {
        amount = feeUsd / usdRate;
      }

      // Show estimated total (fall back to app fee if no estimate provided)
      let estSol = estimatedTotalSol > 0 ? estimatedTotalSol : (estimatedTotalUsd > 0 ? estimatedTotalUsd / usdRate : amount);
      let estUsd = estimatedTotalUsd > 0 ? estimatedTotalUsd : (estimatedTotalSol > 0 ? estimatedTotalSol * usdRate : amount * usdRate);

      if (extra && typeof extra.estSol === 'number' && extra.estSol > 0) {
        estSol = extra.estSol;
        estUsd = estSol * usdRate;
      }
      document.getElementById('estimated-sol').textContent = estSol.toFixed(6) + ' SOL';
      document.getElementById('estimated-usd').textContent = '≈ $' + estUsd.toFixed(2) + ' USD';
    }

    async function refreshSolPrice() {
      try {
        const res = await fetch('/sol-price', { cache: 'no-store' });
        const json = await res.json();
        const p = Number(json?.solana?.usd);
        if (Number.isFinite(p) && p > 0) {
          solPrice = p;
          renderAmounts();
        }
      } catch (e) {
        // ignore - use price passed in URL params
      }
    }

    async function rpc(method, params) {
      const res = await fetch('/solana-rpc', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
      });
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'RPC error');
      return json.result;
    }

    function storageUsdEstimate() {
      if (storageOption === 'cloud') return 0;
      const ARWEAVE_UPLOAD_BASE_USD = 0.01;
      const ARWEAVE_PER_KB_USD = 0.00001;
      const metadataBytes = 2000;
      const metaUsd = ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD;
      if (storageOption === 'onchain') return metaUsd; // image is embedded in metadata, no separate upload
      const imageBytes = fileSizeBytes > 0 ? fileSizeBytes : 0;
      const imgUsd = ARWEAVE_UPLOAD_BASE_USD + (imageBytes / 1024) * ARWEAVE_PER_KB_USD;
      return imgUsd + metaUsd;
    }

    async function refreshRealtimeEstimate() {
      try {
        const usdRate = solPrice > 0 ? solPrice : 200;

        // Priority fee market (median)
        let priorityLamports = 0;
        try {
          const fees = await rpc('getRecentPrioritizationFees', []);
          if (Array.isArray(fees) && fees.length) {
            const vals = fees.map(x => Number(x && x.prioritizationFee)).filter(n => Number.isFinite(n) && n >= 0).sort((a,b)=>a-b);
            const microLamportsPerCu = vals.length ? vals[Math.floor(vals.length/2)] : 0;
            const cuEstimate = nftType === 'compressed' ? 80000 : 250000;
            priorityLamports = Math.ceil((microLamportsPerCu * cuEstimate) / 1000000);
          }
        } catch (e) {}

        // Rent (standard NFT only)
        let rentLamports = 0;
        if (nftType !== 'compressed') {
          const sizes = [82, 165, 679, 282];
          const rents = await Promise.all(sizes.map(s => rpc('getMinimumBalanceForRentExemption', [s]).catch(()=>0)));
          rentLamports = rents.reduce((a,b)=>a+(Number(b)||0),0);
        }

        const baseFeeLamports = 5000;
        const networkLamports = rentLamports + baseFeeLamports + priorityLamports;
        const networkSol = networkLamports / 1e9;

        const feeSolLive = feeUsd > 0 ? (feeUsd / usdRate) : amount;
        const storageUsd = storageUsdEstimate();
        const storageSol = storageUsd / usdRate;

        const estSol = feeSolLive + networkSol + storageSol;
        renderAmounts({ estSol });
      } catch (e) {
        // ignore
      }
    }

    renderAmounts();
    refreshSolPrice();
    setInterval(refreshSolPrice, 30000);
    refreshRealtimeEstimate();
    setInterval(refreshRealtimeEstimate, 30000);
    document.getElementById('recipient').textContent = recipient ? recipient.slice(0,4) + '...' + recipient.slice(-4) : '...';
    // Set image: token fetch (on-chain SVG) is handled above; for regular imageUrl set it here
    if (!imageToken && imageUrl) {
      const img = document.getElementById('nft-image');
      img.src = imageUrl;
      img.onerror = function() { this.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;">📷</div>'; };
    }
    
    // Generate Solana Pay QR code
    const reference = params.get('reference') || crypto.randomUUID();
    const solanaPayUrl = 'solana:' + recipient + '?amount=' + amount + '&reference=' + reference + '&label=PhotoLynk&message=' + encodeURIComponent(name);
    
    // Compatible wallets with deep-links
    const wallets = [
      { name: 'Phantom', icon: '👻', deepLink: 'https://phantom.app/ul/v1/browse/' + encodeURIComponent(window.location.href) },
      { name: 'Solflare', icon: '🔆', deepLink: 'solflare:' + solanaPayUrl.replace('solana:', '') },
      { name: 'Glow', icon: '✨', deepLink: solanaPayUrl },
      { name: 'Backpack', icon: '🎒', deepLink: solanaPayUrl },
      { name: 'Trust', icon: '🛡️', deepLink: solanaPayUrl },
    ];
    
    // Render wallet buttons
    const walletLinksEl = document.getElementById('wallet-links');
    wallets.forEach(w => {
      const btn = document.createElement('a');
      btn.href = w.deepLink;
      btn.target = '_blank';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:rgba(255,255,255,0.1);border-radius:8px;color:#fff;text-decoration:none;font-size:11px;border:1px solid rgba(255,255,255,0.2);';
      btn.innerHTML = w.icon + ' ' + w.name;
      btn.onmouseover = function() { this.style.borderColor = '#9945FF'; };
      btn.onmouseout = function() { this.style.borderColor = 'rgba(255,255,255,0.2)'; };
      walletLinksEl.appendChild(btn);
    });
    
    const qrUiVisible = (function() {
      const el = document.getElementById('qr-container');
      return !!(el && getComputedStyle(el).display !== 'none');
    })();

    let qrAttempts = 0;
    function generateQR() {
      if (!qrUiVisible) return;
      qrAttempts++;
      console.log('[NFT Payment] QR attempt', qrAttempts, 'QRCode defined:', typeof QRCode !== 'undefined');
      if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
        const canvas = document.getElementById('qr-code');
        if (!canvas) {
          console.error('[NFT Payment] Canvas element not found');
          return;
        }
        QRCode.toCanvas(canvas, solanaPayUrl, { width: 180, margin: 1, color: { dark: '#000000', light: '#ffffff' } }, (err) => {
          if (err) {
            console.error('[NFT Payment] QR error:', err);
            if (qrAttempts < 5) setTimeout(generateQR, 500);
            else document.getElementById('qr-container').innerHTML = '<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">QR unavailable</div>';
          } else {
            console.log('[NFT Payment] QR generated successfully');
          }
        });
      } else if (qrAttempts < 10) {
        console.log('[NFT Payment] QRCode not ready, retrying in 300ms...');
        setTimeout(generateQR, 300);
      } else {
        console.warn('[NFT Payment] QRCode library failed to load after', qrAttempts, 'attempts');
        document.getElementById('qr-container').innerHTML = '<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">QR unavailable</div>';
      }
    }
    // Start QR generation with delay to ensure library loads
    if (qrUiVisible) setTimeout(generateQR, 100);
    
    // Poll for QR payment by checking recipient's recent transactions
    let qrPaymentDetected = false;
    let pollInterval = null;
    let lastKnownSig = null;
    const expectedLamports = Math.ceil(amount * 1e9);
    
    async function pollForQRPayment() {
      if (qrPaymentDetected) return;
      try {
        // Get recent signatures for the recipient
        const res = await fetch('/solana-rpc', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [recipient, {limit: 5}] })
        });
        const data = await res.json();
        if (data.result && data.result.length > 0) {
          // Check for new transactions since page load
          for (const tx of data.result) {
            if (lastKnownSig === null) {
              lastKnownSig = tx.signature; // First poll - just record current state
              break;
            }
            if (tx.signature === lastKnownSig) break; // Reached known transactions
            
            // New transaction found - verify it's a payment of correct amount
            console.log('[NFT Payment] New transaction detected:', tx.signature);
            qrPaymentDetected = true;
            clearInterval(pollInterval);
            showStatus('Payment detected! Minting NFT...', 'info');
            await processQRPayment(tx.signature);
            return;
          }
        }
      } catch (err) {
        console.log('[NFT Payment] Poll error:', err.message);
      }
    }
    
    async function processQRPayment(paymentSig) {
      try {
        // Get metadata URL from params
        const metadataUrl = params.get('metadataUrl') || '';
        const nftTypeParam = params.get('nftType') || 'compressed';
        
        // Call server to mint NFT
        const mintRes = await fetch('/api/nft/mint-after-payment', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            paymentSignature: paymentSig,
            recipient: recipient,
            metadataUrl: metadataUrl,
            nftType: nftTypeParam,
            name: name
          })
        });
        
        const mintData = await mintRes.json();
        if (mintData.success) {
          document.getElementById('main-container').style.display = 'none';
          document.getElementById('success-container').style.display = 'block';
          document.getElementById('tx-link').innerHTML = 'NFT Minted! <a href="https://solscan.io/tx/' + (mintData.signature || paymentSig) + '" target="_blank" style="color:#14F195;">View on Solscan</a>';
        } else {
          showStatus('Payment received but mint failed: ' + (mintData.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        console.error('[NFT Payment] Mint after QR payment failed:', err);
        showStatus('Payment received but mint failed: ' + err.message, 'error');
      }
    }
    
    // Start polling for QR payments (every 3 seconds) only when QR flow is visible
    if (qrUiVisible) {
      pollInterval = setInterval(pollForQRPayment, 3000);
      console.log('[NFT Payment] QR payment polling started for reference:', reference);
    }
    
    function showStatus(msg, type) { const el = document.getElementById('status'); el.textContent = msg; el.className = 'status ' + type; }
    function setLoading(loading) { const btn = document.getElementById('pay-btn'); btn.disabled = loading; btn.innerHTML = loading ? '<div class="spinner"></div> Processing...' : '<span>👻</span> Connect Phantom & Pay'; }
    
    async function rpcWithRetry(body, maxAttempts) {
      maxAttempts = maxAttempts || 5;
      let lastErr;
      for (let i = 0; i < maxAttempts; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 800 * i));
        try {
          const res = await fetch('/solana-rpc', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
          if (res.status === 503) { lastErr = new Error('RPC unavailable (503)'); continue; }
          const data = await res.json();
          if (data.error && !data.result) { lastErr = new Error('RPC error: ' + (data.error.message || JSON.stringify(data.error))); continue; }
          return data;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('All RPC attempts failed');
    }
    
    // Wrap Phantom signing with timeout so page doesn't hang forever
    function signWithTimeout(provider, tx, timeoutMs) {
      timeoutMs = timeoutMs || 90000;
      return Promise.race([
        provider.signAndSendTransaction(tx),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('Phantom did not respond in time. Click the Phantom icon in your browser toolbar to approve.')); }, timeoutMs); })
      ]);
    }

    function withTimeout(promise, timeoutMs, errorMessage) {
      timeoutMs = timeoutMs || 30000;
      return Promise.race([
        promise,
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error(errorMessage || 'Operation timed out')); }, timeoutMs); })
      ]);
    }
    
    async function connectAndPay() {
      console.log('[NFT Payment] connectAndPay called, solanaWeb3:', typeof solanaWeb3);
      if (typeof solanaWeb3 === 'undefined') { showStatus('Solana library still loading. Please wait a moment and try again.', 'error'); return; }
      const provider = window.phantom?.solana || window.solana;
      if (!provider?.isPhantom) { showStatus('Phantom wallet not found. Install it from phantom.app', 'error'); setTimeout(() => window.open('https://phantom.app/', '_blank'), 1500); return; }
      setLoading(true); showStatus('Connecting to Phantom...', 'info');
      try {
        // Try multiple connection methods
        let pubkeyStr;
        if (provider.publicKey) {
          // Already connected
          pubkeyStr = provider.publicKey.toString();
        } else {
          // Connect to Phantom - no timeout here, user must approve in the popup
          try {
            showStatus('Approve connection in Phantom popup...', 'info');
            const resp = await provider.connect({ onlyIfTrusted: false });
            pubkeyStr = resp.publicKey.toString();
          } catch (connectErr) {
            console.log('[NFT Payment] connect() failed:', connectErr.message);
            const msg = (connectErr?.message || '').toLowerCase();
            if (msg.includes('user rejected') || msg.includes('rejected')) {
              throw new Error('Connection rejected. Click the button and approve in Phantom.');
            }
            throw new Error('Could not connect to Phantom. Make sure Phantom is unlocked and try again.');
          }
        }
        showStatus('Connected: ' + pubkeyStr.slice(0,4) + '...' + pubkeyStr.slice(-4), 'info');
        
        // Get blockhash via local proxy (avoids CORS issues)
        showStatus('Getting blockhash...', 'info');
        const rpcData = await rpcWithRetry({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{commitment:'confirmed'}] });
        if (!rpcData.result?.value?.blockhash) throw new Error('Could not get blockhash from any RPC endpoint. Please try again.');
        const blockhash = rpcData.result.value.blockhash;
        console.log('[NFT Payment] Got blockhash:', blockhash.slice(0,8) + '...');
        
        // Use Solana web3.js to build transaction
        showStatus('Creating transaction...', 'info');
        
        if (typeof solanaWeb3 === 'undefined') {
          throw new Error('Solana library not loaded. Please refresh the page.');
        }
        
        const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, TransactionInstruction } = solanaWeb3;
        const fromPubkey = new PublicKey(pubkeyStr);
        const toPubkey = new PublicKey(recipient);
        const lamports = Math.ceil(amount * LAMPORTS_PER_SOL);
        
        // Fee wallet exemption: commission wallet pays fee to itself — skip SOL transfer
        // but keep all calculations visible (matches mobile nftOperations.js isFeeWalletExempt)
        const isFeeWalletExempt = pubkeyStr === recipient;
        let paymentSig = null;
        
        if (isFeeWalletExempt) {
          console.log('[NFT Payment] Fee wallet exempt — skipping commission transfer');
          showStatus('Fee wallet detected — skipping payment...', 'info');
          paymentSig = 'fee_wallet_exempt_' + Date.now();
        } else {
          console.log('[NFT Payment] Creating transfer:', lamports, 'lamports to', recipient);
          
          const paymentTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey,
              toPubkey,
              lamports
            })
          );
          paymentTx.recentBlockhash = blockhash;
          paymentTx.feePayer = fromPubkey;
          
          showStatus('Approve payment in Phantom... (check Phantom popup)', 'info');
          const result = await signWithTimeout(provider, paymentTx, 120000);
          paymentSig = result.signature;
          console.log('[NFT Payment] Payment confirmed on-chain:', paymentSig);
        }
        
        // Now mint the NFT based on type
        showStatus('Minting your NFT...', 'info');
        const nftTypeParam = new URLSearchParams(window.location.search).get('nftType') || 'compressed';
        
        // Get fresh blockhash for mint transaction
        showStatus('Preparing mint transaction...', 'info');
        const rpcData2 = await rpcWithRetry({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{commitment:'confirmed'}] });
        if (!rpcData2.result?.value?.blockhash) throw new Error('Could not get blockhash for mint. Payment was sent. Contact support with tx: ' + paymentSig);
        const blockhash2 = rpcData2.result.value.blockhash;
        
        let mintSig;
        
        if (nftTypeParam === 'standard') {
          // ========== STANDARD NFT MINTING ==========
          // Standard NFTs require SPL Token + Metaplex Token Metadata
          // This is more expensive (~0.02 SOL) but creates a traditional NFT
          
          const { Keypair } = solanaWeb3;
          const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
          const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
          const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
          const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');
          
          // Generate new mint keypair
          const mintKeypair = Keypair.generate();
          const mintPubkey = mintKeypair.publicKey;
          console.log('[NFT Payment] Standard NFT mint address:', mintPubkey.toBase58());
          
          // Derive PDAs
          const [associatedTokenAccount] = PublicKey.findProgramAddressSync(
            [fromPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          const [metadataAccount] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
            TOKEN_METADATA_PROGRAM_ID
          );
          const [masterEditionAccount] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer(), new TextEncoder().encode('edition')],
            TOKEN_METADATA_PROGRAM_ID
          );
          
          // Get rent for mint account (82 bytes)
          const rentData = await rpcWithRetry({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [82] });
          const mintRent = rentData.result;
          
          // 1. Create mint account
          const createMintIx = SystemProgram.createAccount({
            fromPubkey: fromPubkey,
            newAccountPubkey: mintPubkey,
            space: 82,
            lamports: mintRent,
            programId: TOKEN_PROGRAM_ID,
          });
          
          // 2. Initialize mint (0 decimals, owner is user)
          const initMintData = new Uint8Array([0, 0, ...fromPubkey.toBytes(), 1, ...fromPubkey.toBytes()]);
          const initMintIx = new TransactionInstruction({
            keys: [
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_PROGRAM_ID,
            data: initMintData,
          });
          
          // 3. Create ATA
          const createATAIx = new TransactionInstruction({
            keys: [
              { pubkey: fromPubkey, isSigner: true, isWritable: true },
              { pubkey: associatedTokenAccount, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: false, isWritable: false },
              { pubkey: mintPubkey, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            data: new Uint8Array([]),
          });
          
          // 4. Mint 1 token
          const mintToData = new Uint8Array([7, 1, 0, 0, 0, 0, 0, 0, 0]);
          const mintToIx = new TransactionInstruction({
            keys: [
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: associatedTokenAccount, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },
            ],
            programId: TOKEN_PROGRAM_ID,
            data: mintToData,
          });
          
          // 5. Create Metadata (CreateMetadataAccountV3 - discriminator 33)
          const nftNameParam = new URLSearchParams(window.location.search).get('name') || 'PhotoLynk Memory';
          const metadataUrlParam = new URLSearchParams(window.location.search).get('metadataUrl') || '';
          
          // Serialize metadata instruction data
          function serializeMetadataV3(name, symbol, uri, sellerFeeBasisPoints) {
            const nameBytes = new TextEncoder().encode(name.slice(0, 32));
            const symbolBytes = new TextEncoder().encode(symbol.slice(0, 10));
            const uriBytes = new TextEncoder().encode(uri.slice(0, 200));
            
            // Calculate total size: discriminator(1) + name(4+len) + symbol(4+len) + uri(4+len) + fee(2) + creators(1) + collection(1) + uses(1) + isMutable(1) + collectionDetails(1)
            const totalSize = 1 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 2 + 1 + 1 + 1 + 1 + 1;
            const data = new Uint8Array(totalSize);
            let offset = 0;
            
            data[offset++] = 33; // CreateMetadataAccountV3 discriminator
            
            // Name (borsh string)
            new DataView(data.buffer).setUint32(offset, nameBytes.length, true); offset += 4;
            data.set(nameBytes, offset); offset += nameBytes.length;
            
            // Symbol
            new DataView(data.buffer).setUint32(offset, symbolBytes.length, true); offset += 4;
            data.set(symbolBytes, offset); offset += symbolBytes.length;
            
            // URI
            new DataView(data.buffer).setUint32(offset, uriBytes.length, true); offset += 4;
            data.set(uriBytes, offset); offset += uriBytes.length;
            
            // Seller fee basis points
            new DataView(data.buffer).setUint16(offset, sellerFeeBasisPoints, true); offset += 2;
            
            // Creators: None (0)
            data[offset++] = 0;
            // Collection: None (0)
            data[offset++] = 0;
            // Uses: None (0)
            data[offset++] = 0;
            // Is mutable: true (1)
            data[offset++] = 1;
            // Collection details: None (0)
            data[offset++] = 0;
            
            return data;
          }
          
          const metadataData = serializeMetadataV3(nftNameParam, 'PLNK', metadataUrlParam, 500);
          const createMetadataIx = new TransactionInstruction({
            keys: [
              { pubkey: metadataAccount, isSigner: false, isWritable: true },
              { pubkey: mintPubkey, isSigner: false, isWritable: false },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // mint authority
              { pubkey: fromPubkey, isSigner: true, isWritable: true },   // payer
              { pubkey: fromPubkey, isSigner: false, isWritable: false }, // update authority
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_METADATA_PROGRAM_ID,
            data: metadataData,
          });
          
          // 6. Create Master Edition (CreateMasterEditionV3 - discriminator 17)
          // Data: discriminator(1) + max_supply Option<u64> = Some(0) means no prints
          const masterEditionData = new Uint8Array([17, 1, 0, 0, 0, 0, 0, 0, 0, 0]); // discriminator + Some(0)
          const createMasterEditionIx = new TransactionInstruction({
            keys: [
              { pubkey: masterEditionAccount, isSigner: false, isWritable: true },
              { pubkey: mintPubkey, isSigner: false, isWritable: true },
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // update authority
              { pubkey: fromPubkey, isSigner: true, isWritable: false },  // mint authority
              { pubkey: fromPubkey, isSigner: true, isWritable: true },   // payer
              { pubkey: metadataAccount, isSigner: false, isWritable: true },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            programId: TOKEN_METADATA_PROGRAM_ID,
            data: masterEditionData,
          });
          
          const standardTx = new Transaction()
            .add(createMintIx)
            .add(initMintIx)
            .add(createATAIx)
            .add(mintToIx)
            .add(createMetadataIx)
            .add(createMasterEditionIx);
          standardTx.recentBlockhash = blockhash2;
          standardTx.feePayer = fromPubkey;
          standardTx.partialSign(mintKeypair);
          
          showStatus('Approve standard NFT mint in Phantom... (check popup)', 'info');
          const result = await signWithTimeout(provider, standardTx, 120000);
          mintSig = result.signature;
          console.log('[NFT Payment] Standard NFT minted:', mintSig, 'Mint:', mintPubkey.toBase58());
          
          // Send success data to app (forward all edition/hash params from URL)
          const qsStd = new URLSearchParams(window.location.search);
          fetch('/nft-mint-success', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              paymentTx: paymentSig,
              mintTx: mintSig,
              name: qsStd.get('name') || '',
              imageUrl: qsStd.get('imageUrl') || '',
              amount: parseFloat(qsStd.get('amount') || '0'),
              estimatedTotalSol: parseFloat(qsStd.get('estimatedTotalSol') || '0'),
              estimatedTotalUsd: parseFloat(qsStd.get('estimatedTotalUsd') || '0'),
              solPrice: parseFloat(qsStd.get('solPrice') || '0'),
              nftType: 'standard',
              mintAddress: mintPubkey.toBase58(),
              metadataUrl: qsStd.get('metadataUrl') || '',
              wallet: qsStd.get('wallet') || '',
              edition: qsStd.get('edition') || '',
              license: qsStd.get('license') || '',
              watermark: qsStd.get('watermark') || 'false',
              encrypt: qsStd.get('encrypt') || 'false',
              storageOption: qsStd.get('storageOption') || '',
              contentHash: qsStd.get('contentHash') || '',
              exifHash: qsStd.get('exifHash') || '',
              exifRawHash: qsStd.get('exifRawHash') || '',
              exifBindingHash: qsStd.get('exifBindingHash') || '',
              certificationMode: qsStd.get('certificationMode') || '',
            })
          }).catch(e => console.log('Failed to notify app:', e));
          
          document.getElementById('main-container').style.display = 'none';
          document.getElementById('success-container').style.display = 'block';
          document.getElementById('tx-link').innerHTML = 'Payment: <a href="https://solscan.io/tx/' + paymentSig + '" target="_blank" style="color:#14F195;">' + paymentSig.slice(0,8) + '...</a><br>NFT Mint: <a href="https://solscan.io/tx/' + mintSig + '" target="_blank" style="color:#14F195;">' + mintSig.slice(0,8) + '...</a><br>Mint Address: <span style="color:#9945FF;font-size:10px;">' + mintPubkey.toBase58() + '</span>';
          
          // Auto-close after 3 seconds
          setTimeout(() => window.close(), 3000);
          return;
        }
        
        // ========== COMPRESSED NFT (cNFT) MINTING ==========
        // Bubblegum program IDs - PhotoLynk shared Merkle tree
        const MERKLE_TREE = '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS';
        const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
        const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
        const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
        const merkleTreePubkey = new PublicKey(MERKLE_TREE);
        
        // Derive tree config PDA
        const [treeConfig] = PublicKey.findProgramAddressSync(
          [merkleTreePubkey.toBuffer()],
          BUBBLEGUM_PROGRAM_ID
        );
        
        // Build metadata for the cNFT - exact borsh serialization matching mobile app
        const nftNameParam = new URLSearchParams(window.location.search).get('name') || 'PhotoLynk Memory';
        const metadataUrlParam = new URLSearchParams(window.location.search).get('metadataUrl') || '';
        
        // Serialize metadata args for Bubblegum mintV1 (exact order from mpl-bubblegum)
        function serializeString(str) {
          const bytes = new TextEncoder().encode(str || '');
          const len = new Uint8Array(4);
          new DataView(len.buffer).setUint32(0, bytes.length, true);
          return new Uint8Array([...len, ...bytes]);
        }
        
        const buffers = [];
        // name (string: 4-byte length + data)
        buffers.push(serializeString(nftNameParam.slice(0, 32)));
        // symbol (string)
        buffers.push(serializeString('PLNK'));
        // uri (string)
        buffers.push(serializeString(metadataUrlParam));
        // sellerFeeBasisPoints (u16) - 500 = 5%
        const feeBuf = new Uint8Array(2);
        new DataView(feeBuf.buffer).setUint16(0, 500, true);
        buffers.push(feeBuf);
        // primarySaleHappened (bool) - false
        buffers.push(new Uint8Array([0]));
        // isMutable (bool) - true
        buffers.push(new Uint8Array([1]));
        // editionNonce (Option<u8>): None = 0
        buffers.push(new Uint8Array([0]));
        // tokenStandard (Option<TokenStandard>): Some(NonFungible=0) = [1, 0]
        buffers.push(new Uint8Array([1, 0]));
        // collection (Option<Collection>): None = 0
        buffers.push(new Uint8Array([0]));
        // uses (Option<Uses>): None = 0
        buffers.push(new Uint8Array([0]));
        // tokenProgramVersion (enum: 0 = Original)
        buffers.push(new Uint8Array([0]));
        // creators (Vec<Creator>): 4-byte length + array
        const creatorsLen = new Uint8Array(4);
        new DataView(creatorsLen.buffer).setUint32(0, 1, true);
        buffers.push(creatorsLen);
        // Creator: address (32 bytes) + verified (bool) + share (u8)
        buffers.push(fromPubkey.toBytes());
        buffers.push(new Uint8Array([1])); // verified = true (matches successful tx)
        buffers.push(new Uint8Array([100])); // share = 100%
        
        // Combine all buffers
        const totalLen = buffers.reduce((acc, b) => acc + b.length, 0);
        const metadataArgs = new Uint8Array(totalLen);
        let offset = 0;
        for (const buf of buffers) { metadataArgs.set(buf, offset); offset += buf.length; }
        
        // Discriminator for mintV1 instruction
        const discriminator = new Uint8Array([145, 98, 192, 118, 184, 147, 118, 104]);
        const instructionData = new Uint8Array(discriminator.length + metadataArgs.length);
        instructionData.set(discriminator, 0);
        instructionData.set(metadataArgs, discriminator.length);
        
        const mintInstruction = new TransactionInstruction({
          keys: [
            { pubkey: treeConfig, isSigner: false, isWritable: true },       // 0: treeConfig
            { pubkey: fromPubkey, isSigner: false, isWritable: false },      // 1: leafOwner
            { pubkey: fromPubkey, isSigner: false, isWritable: false },      // 2: leafDelegate
            { pubkey: merkleTreePubkey, isSigner: false, isWritable: true }, // 3: merkleTree
            { pubkey: fromPubkey, isSigner: true, isWritable: true },        // 4: payer
            { pubkey: fromPubkey, isSigner: true, isWritable: false },       // 5: treeCreatorOrDelegate
            { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: BUBBLEGUM_PROGRAM_ID,
          data: instructionData,
        });
        
        const mintTx = new Transaction().add(mintInstruction);
        mintTx.recentBlockhash = blockhash2;
        mintTx.feePayer = fromPubkey;
        
        showStatus('Approve NFT mint in Phantom... (check popup)', 'info');
        const mintResult = await signWithTimeout(provider, mintTx, 120000);
        mintSig = mintResult.signature;
        console.log('[NFT Payment] NFT minted:', mintSig);
        
        // Resolve real cNFT asset ID via DAS (same approach as mobile solana-seeker)
        // Wait for Solana indexing, then search by metadataUrl or name
        const qs = new URLSearchParams(window.location.search);
        let resolvedMintAddress = '';
        if (nftTypeParam === 'compressed') {
          showStatus('Finalizing — resolving asset ID...', 'info');
          const walletAddr = qs.get('wallet') || '';
          const nftName = qs.get('name') || '';
          const metaUrl = qs.get('metadataUrl') || '';
          
          const dasKeys = [
            '${process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com'}',
          ];
          for (let dasAttempt = 0; dasAttempt < 5; dasAttempt++) {
            await new Promise(r => setTimeout(r, dasAttempt === 0 ? 2000 : 3000));
            for (const dasUrl of dasKeys) {
              try {
                const dasResp = await fetch(dasUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'resolve-cnft',
                    method: 'getAssetsByOwner',
                    params: {
                      ownerAddress: walletAddr,
                      page: 1,
                      limit: 10,
                      sortBy: { sortBy: 'created', sortDirection: 'desc' },
                    },
                  }),
                });
                if (dasResp.status === 429) { continue; }
                const dasData = await dasResp.json();
                if (dasData.result && dasData.result.items) {
                  const match = dasData.result.items.find(function(item) {
                    return (metaUrl && item.content && item.content.json_uri === metaUrl) ||
                      (nftName && item.content && item.content.metadata && item.content.metadata.name === nftName);
                  });
                  if (match) {
                    resolvedMintAddress = match.id;
                    console.log('[NFT Payment] Resolved real asset ID:', resolvedMintAddress);
                    break;
                  }
                }
                break; // success (even if no match), don't try next key
              } catch (dasErr) {
                console.log('[NFT Payment] DAS attempt ' + (dasAttempt + 1) + ' failed:', dasErr.message);
                break;
              }
            }
            if (resolvedMintAddress) break;
          }
          if (!resolvedMintAddress) {
            console.log('[NFT Payment] Could not resolve asset ID, using tx signature fallback');
          }
        }
        
        // Send success data to app (forward all edition/hash params from URL)
        fetch('/nft-mint-success', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentTx: paymentSig,
            mintTx: mintSig,
            name: qs.get('name') || '',
            imageUrl: imageUrl || qs.get('imageUrl') || '',
            imageToken: qs.get('imageToken') || '',
            amount: parseFloat(qs.get('amount') || '0'),
            estimatedTotalSol: parseFloat(qs.get('estimatedTotalSol') || '0'),
            estimatedTotalUsd: parseFloat(qs.get('estimatedTotalUsd') || '0'),
            solPrice: parseFloat(qs.get('solPrice') || '0'),
            nftType: nftTypeParam,
            mintAddress: resolvedMintAddress || '',
            metadataUrl: qs.get('metadataUrl') || '',
            wallet: qs.get('wallet') || '',
            edition: qs.get('edition') || '',
            license: qs.get('license') || '',
            watermark: qs.get('watermark') || 'false',
            encrypt: qs.get('encrypt') || 'false',
            storageOption: qs.get('storageOption') || '',
            contentHash: qs.get('contentHash') || '',
            exifHash: qs.get('exifHash') || '',
            exifRawHash: qs.get('exifRawHash') || '',
            exifBindingHash: qs.get('exifBindingHash') || '',
            certificationMode: qs.get('certificationMode') || '',
          })
        }).catch(e => console.log('Failed to notify app:', e));
        
        document.getElementById('main-container').style.display = 'none';
        document.getElementById('success-container').style.display = 'block';
        document.getElementById('tx-link').innerHTML = 'Payment: <a href="https://solscan.io/tx/' + paymentSig + '" target="_blank" style="color:#14F195;">' + paymentSig.slice(0,8) + '...</a><br>NFT Mint: <a href="https://solscan.io/tx/' + mintSig + '" target="_blank" style="color:#14F195;">' + mintSig.slice(0,8) + '...</a>';
        const liveRate = solPrice > 0 ? solPrice : 200;
        const totalSol = parseFloat(params.get('estimatedTotalSol') || '0') || parseFloat(params.get('amount') || '0');
        const totalUsd = parseFloat(params.get('estimatedTotalUsd') || '0') || (totalSol * liveRate);
        document.getElementById('success-amount').textContent = 'Paid: ' + totalSol.toFixed(6) + ' SOL (~$' + totalUsd.toFixed(2) + ' USD @ $' + liveRate.toFixed(0) + '/SOL)';
        
        // Auto-close after 3 seconds
        setTimeout(() => window.close(), 3000);
      } catch (err) {
        console.error('Payment error:', err);
        var errMsg = err.message || 'Payment failed';
        if (errMsg.includes('User rejected')) errMsg = 'Transaction rejected. Click the button to try again.';
        showStatus(errMsg, 'error');
        setLoading(false);
      }
    }

    // Ensure click wiring is always present (more reliable than inline handlers)
    window.connectAndPay = connectAndPay;
    const payBtn = document.getElementById('pay-btn');
    if (payBtn) {
      payBtn.addEventListener('click', function(e) {
        e.preventDefault();
        connectAndPay();
      });
    }

    // Reset stale UI state if page was restored from browser cache
    setLoading(false);
  </script>
</body>
</html>`);
});

// NFT mint success callback - receives mint details from browser to show in app
app.post('/nft-mint-success', (req, res) => {
    const { paymentTx, mintTx, name, imageUrl, imageToken, amount, estimatedTotalSol, estimatedTotalUsd, solPrice, nftType, mintAddress, metadataUrl, wallet, edition, license, watermark, encrypt, storageOption, contentHash, exifHash, exifRawHash, exifBindingHash, certificationMode } = req.body;
    console.log('[NFT] Mint success received:', { paymentTx, mintTx, amount, estimatedTotalSol, estimatedTotalUsd, nftType, edition, contentHash: contentHash?.substring(0, 16) });
    // Resolve imageToken server-side so album always gets the real image URL for onchain NFTs
    let resolvedImageUrl = imageUrl || '';
    if (!resolvedImageUrl && imageToken && nftImageTokens[imageToken]) {
        resolvedImageUrl = nftImageTokens[imageToken].dataUri || '';
        console.log('[NFT] Resolved imageToken to data URI for mint success, length:', resolvedImageUrl.length);
    }
    // Store for app to poll
    global.nftMintSuccess = {
        paymentTx,
        mintTx,
        name,
        imageUrl: resolvedImageUrl,
        amount,
        estimatedTotalSol,
        estimatedTotalUsd,
        solPrice,
        nftType,
        mintAddress,
        metadataUrl,
        wallet,
        edition,
        license,
        watermark,
        encrypt,
        storageOption,
        contentHash,
        exifHash,
        exifRawHash,
        exifBindingHash,
        certificationMode,
        timestamp: Date.now()
    };
    res.json({ success: true });
});

// NFT mint success poll endpoint - app polls this to get mint details
app.get('/nft-mint-success', (req, res) => {
    const data = global.nftMintSuccess;
    if (data && Date.now() - data.timestamp < 60000) { // Valid for 60 seconds
        global.nftMintSuccess = null; // Clear after reading
        res.json({ success: true, ...data });
    } else {
        res.json({ success: false });
    }
});

// NFT mint after QR payment - called when QR payment is detected via polling
app.post('/api/nft/mint-after-payment', async (req, res) => {
    const { paymentSignature, recipient, metadataUrl, nftType, name } = req.body;
    console.log('[NFT] Mint after QR payment:', { paymentSignature, nftType, name });
    
    try {
        // For now, store the success for the app to poll
        // In a full implementation, this would trigger actual NFT minting via Metaplex
        global.nftMintSuccess = {
            paymentTx: paymentSignature,
            mintTx: paymentSignature, // Same as payment for QR flow
            imageUrl: metadataUrl,
            amount: 0,
            nftType: nftType || 'compressed',
            name: name,
            timestamp: Date.now()
        };
        
        console.log('[NFT] QR payment mint success stored for app polling');
        res.json({ success: true, signature: paymentSignature });
    } catch (err) {
        console.error('[NFT] Mint after QR payment error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Wallet connected callback - receives address from browser and broadcasts to Electron app
app.post('/wallet-connected', (req, res) => {
    const { address } = req.body;
    if (!address) {
        return res.status(400).json({ success: false, error: 'No address provided' });
    }
    console.log('[Wallet] Connected from browser:', address);
    // Store in memory for the app to poll
    global.connectedWalletAddress = address;
    global.walletJustConnected = true; // Flag to bring app to front
    res.json({ success: true });
});

// Wallet address poll endpoint - Electron app polls this to get the connected address
// Note: Address is cleared 5 seconds after first read to allow multiple windows to receive it
app.get('/wallet-address', (req, res) => {
    const address = global.connectedWalletAddress;
    const bringToFront = global.walletJustConnected;
    if (address) {
        // Clear bringToFront immediately but keep address for 5 seconds
        // This allows multiple windows to receive the address
        if (bringToFront) {
            global.walletJustConnected = false;
            // Clear address after 5 seconds
            setTimeout(() => {
                if (global.connectedWalletAddress === address) {
                    global.connectedWalletAddress = null;
                }
            }, 5000);
        }
        res.json({ success: true, address, bringToFront });
    } else {
        res.json({ success: false });
    }
});

// Wallet connect page - for connecting Phantom in browser
app.get('/wallet-connect', (req, res) => {
    // Headers to help Phantom extension work properly
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob: https: http:; connect-src 'self' https: wss:; style-src 'self' 'unsafe-inline';");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Wallet - PhotoLynk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 20px; padding: 14px; border-radius: 10px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .wallet-address { font-family: monospace; font-size: 12px; word-break: break-all; margin-top: 8px; color: #14F195; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
    .copy-btn { background: rgba(153,69,255,0.2); border: none; color: #9945FF; padding: 8px 16px; border-radius: 8px; cursor: pointer; margin-top: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container" id="connect-container">
    <div class="logo">👻</div>
    <h1>Connect Phantom</h1>
    <p class="subtitle">Connect your Solana wallet to PhotoLynk</p>
    <p style="color:#AB9FF2;font-size:12px;margin-top:4px;margin-bottom:20px;">If Phantom not opened, unlock wallet and refresh this page in browser</p>
    <button class="btn btn-phantom" id="connect-btn"><span>🔗</span> Connect Phantom Wallet</button>
    <button class="btn btn-secondary" onclick="window.close()" style="margin-top:12px;">Cancel</button>
    <div class="status" id="status"></div>
  </div>
  <div class="container" id="waiting-container" style="display:none;">
    <div class="logo" style="animation: pulse 2s infinite;">👻</div>
    <h1>Waiting for Phantom...</h1>
    <p class="subtitle">Approve the connection in your Phantom wallet</p>
    <div class="spinner" style="margin: 20px auto;"></div>
    <button class="btn btn-secondary" onclick="cancelConnect()" style="margin-top:12px;">Cancel</button>
  </div>
  <style>@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }</style>
  <div class="container" id="success-container" style="display:none;">
    <div class="success-icon">✅</div>
    <h1>Wallet Connected!</h1>
    <p class="subtitle">Copy your address and paste it in PhotoLynk</p>
    <div class="wallet-address" id="wallet-address"></div>
    <button class="copy-btn" onclick="copyAddress()">📋 Copy Address</button>
    <div class="status success" style="display:block; margin-top:16px;">You can now close this window and paste the address in PhotoLynk</div>
  </div>
  <script>
    let connectedAddress = '';
    let connectPollInterval = null;
    
    function showStatus(msg, type) { const el = document.getElementById('status'); el.textContent = msg; el.className = 'status ' + type; el.style.display = 'block'; }
    function setLoading(loading) { const btn = document.getElementById('connect-btn'); btn.disabled = loading; btn.innerHTML = loading ? '<div class="spinner"></div> Connecting...' : '<span>🔗</span> Connect Phantom Wallet'; }
    
    function showWaiting() {
      document.getElementById('connect-container').style.display = 'none';
      document.getElementById('waiting-container').style.display = 'block';
    }
    
    function hideWaiting() {
      document.getElementById('waiting-container').style.display = 'none';
      document.getElementById('connect-container').style.display = 'block';
    }
    
    function cancelConnect() {
      if (connectPollInterval) clearInterval(connectPollInterval);
      hideWaiting();
    }
    
    // Send address back to desktop app automatically
    async function sendAddressToApp(address) {
      try {
        await fetch('/wallet-connected', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        return true;
      } catch (e) {
        console.error('Failed to send address to app:', e);
        return false;
      }
    }
    
    function showSuccess(address) {
      connectedAddress = address;
      document.getElementById('connect-container').style.display = 'none';
      document.getElementById('success-container').style.display = 'block';
      document.getElementById('wallet-address').textContent = address;
      
      // Automatically send to app
      sendAddressToApp(address).then(sent => {
        if (sent) {
          document.querySelector('.copy-btn').style.display = 'none';
          document.querySelector('#success-container .status').innerHTML = '✓ Address sent to PhotoLynk!<br><small>You can close this window.</small>';
          // Auto-close after 2 seconds
          setTimeout(() => window.close(), 2000);
        }
      });
    }
    
    function copyAddress() { 
      navigator.clipboard.writeText(connectedAddress).then(() => { 
        const btn = document.querySelector('.copy-btn'); 
        btn.textContent = '✓ Copied!'; 
        setTimeout(() => btn.textContent = '📋 Copy Address', 2000); 
      }); 
    }
    
    // Connect using Phantom Universal Links (deeplinks) - works even when wallet is locked
    document.getElementById('connect-btn').addEventListener('click', async function() {
      const provider = window.phantom?.solana || window.solana;
      
      // First try the provider API if available and connected
      if (provider?.isPhantom && provider.isConnected && provider.publicKey) {
        showSuccess(provider.publicKey.toString());
        return;
      }
      
      // Try provider.connect() first (works if wallet is unlocked)
      if (provider?.isPhantom) {
        setLoading(true);
        showStatus('Connecting...', 'info');
        
        try {
          const resp = await provider.connect();
          showSuccess(resp.publicKey.toString());
          return;
        } catch (err) {
          console.log('Provider connect failed, trying deeplink:', err.message);
          setLoading(false);
        }
      }
      
      // Fallback: Use Phantom Universal Link (deeplink) - this ALWAYS opens Phantom
      const redirectUrl = encodeURIComponent(window.location.origin + '/wallet-callback');
      const appUrl = encodeURIComponent('https://stealthlynk.io');
      const cluster = 'mainnet-beta';
      
      // Phantom Universal Link format
      const phantomConnectUrl = 'https://phantom.app/ul/v1/connect?' + 
        'app_url=' + appUrl + 
        '&redirect_link=' + redirectUrl +
        '&cluster=' + cluster;
      
      console.log('Opening Phantom via Universal Link:', phantomConnectUrl);
      showWaiting();
      
      // Open Phantom - this will trigger the extension or open phantom.app
      window.open(phantomConnectUrl, '_blank');
      
      // Poll for connection (Phantom will redirect back or user will approve in extension)
      let attempts = 0;
      connectPollInterval = setInterval(async () => {
        attempts++;
        
        // Check if provider is now connected
        const p = window.phantom?.solana || window.solana;
        if (p?.isConnected && p?.publicKey) {
          clearInterval(connectPollInterval);
          showSuccess(p.publicKey.toString());
          return;
        }
        
        // Try eager connect
        if (p?.isPhantom) {
          try {
            const resp = await p.connect({ onlyIfTrusted: true });
            if (resp?.publicKey) {
              clearInterval(connectPollInterval);
              showSuccess(resp.publicKey.toString());
              return;
            }
          } catch (e) { /* not yet */ }
        }
        
        // Timeout after 2 minutes
        if (attempts > 120) {
          clearInterval(connectPollInterval);
          hideWaiting();
          showStatus('Connection timed out. Please try again.', 'error');
        }
      }, 1000);
    });
    
    // Wait for Phantom extension to inject, then keep retrying after unlock
    let phantomCheckAttempts = 0;
    const maxPhantomChecks = 20; // 10 seconds for initial detection
    let retryConnectInterval = null;
    
    function startRetryLoop() {
      if (retryConnectInterval) return;
      showStatus('🔓 Wallet locked - unlock Phantom, then we will connect automatically...', 'info');
      document.getElementById('unlock-steps') && (document.getElementById('unlock-steps').style.display = 'block');
      retryConnectInterval = setInterval(async () => {
        const p = window.phantom?.solana || window.solana;
        if (!p) return;
        // Try trusted first (instant if already approved this site)
        try {
          const resp = await p.connect({ onlyIfTrusted: true });
          if (resp?.publicKey) { clearInterval(retryConnectInterval); retryConnectInterval = null; showSuccess(resp.publicKey.toString()); return; }
        } catch (e) {}
        // Try full connect (will pop up Phantom if unlocked)
        try {
          const resp = await p.connect({ onlyIfTrusted: false });
          if (resp?.publicKey) { clearInterval(retryConnectInterval); retryConnectInterval = null; showSuccess(resp.publicKey.toString()); return; }
        } catch (e) {
          // User rejected or still locked - keep retrying silently
        }
      }, 1500);
      // Stop after 3 minutes
      setTimeout(() => { if (retryConnectInterval) { clearInterval(retryConnectInterval); retryConnectInterval = null; showStatus('Timed out. Click Connect to try again.', 'error'); } }, 180000);
    }
    
    function waitForPhantom() {
      phantomCheckAttempts++;
      const provider = window.phantom?.solana || window.solana;
      
      if (provider?.isPhantom) {
        showStatus('Phantom detected! Connecting...', 'info');
        provider.connect({ onlyIfTrusted: true }).then(resp => {
          if (resp?.publicKey) { showSuccess(resp.publicKey.toString()); }
          else { startRetryLoop(); }
        }).catch(() => {
          // Eager connect failed (not trusted yet or locked) - start retry loop
          startRetryLoop();
        });
      } else if (provider && !provider.isPhantom) {
        // Provider exists but not fully ready (locked state on some versions)
        startRetryLoop();
      } else if (phantomCheckAttempts < maxPhantomChecks) {
        if (phantomCheckAttempts > 4) showStatus('Looking for Phantom... Click the Phantom icon in your toolbar if needed.', 'info');
        setTimeout(waitForPhantom, 500);
      } else {
        showStatus('Phantom not detected. Install from phantom.app or enable the extension for localhost.', 'error');
        document.getElementById('connect-btn').innerHTML = '<span>📥</span> Install Phantom';
        document.getElementById('connect-btn').onclick = function() { window.open('https://phantom.app/', '_blank'); };
      }
    }
    
    // Start checking for Phantom after page load
    window.addEventListener('load', () => {
      setTimeout(waitForPhantom, 300);
    });
  </script>
</body>
</html>`);
});

// NFT Transfer state
let nftTransferStatus = { completed: false, success: false, signature: null, error: null };

// NFT Transfer status endpoint - polled by desktop app
app.get('/nft-transfer-status', (req, res) => {
    res.json(nftTransferStatus);
});

// NFT Transfer completed callback - receives result from browser
app.post('/nft-transfer-complete', (req, res) => {
    const { success, signature, error } = req.body;
    nftTransferStatus = { completed: true, success: !!success, signature: signature || null, error: error || null };
    // Reset after 30 seconds
    setTimeout(() => { nftTransferStatus = { completed: false, success: false, signature: null, error: null }; }, 30000);
    res.json({ success: true });
});

// NFT Transfer signing page - opens in browser with Phantom
app.get('/nft-transfer-sign', (req, res) => {
    const { tx, mint, to, versioned } = req.query;
    if (!tx || !mint || !to) {
        return res.status(400).send('Missing parameters');
    }
    const isVersioned = versioned === '1';
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign NFT Transfer - PhotoLynk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #fff; }
    .container { background: rgba(30, 30, 50, 0.95); border-radius: 24px; padding: 40px; max-width: 420px; width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid rgba(153, 69, 255, 0.3); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .info-box { background: rgba(0,0,0,0.3); border-radius: 12px; padding: 16px; margin-bottom: 24px; text-align: left; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .info-row:last-child { margin-bottom: 0; }
    .info-label { color: #888; font-size: 12px; }
    .info-value { color: #fff; font-size: 12px; font-family: monospace; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; margin-bottom: 12px; }
    .btn-phantom { background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; }
    .btn-phantom:hover { box-shadow: 0 8px 24px rgba(153, 69, 255, 0.4); transform: translateY(-2px); }
    .btn-phantom:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #888; }
    .status { margin-top: 20px; padding: 14px; border-radius: 10px; font-size: 14px; display: none; }
    .status.error { display: block; background: rgba(248, 113, 113, 0.1); color: #F87171; }
    .status.success { display: block; background: rgba(20, 241, 149, 0.1); color: #14F195; }
    .status.info { display: block; background: rgba(153, 69, 255, 0.1); color: #9945FF; }
    .spinner { width: 20px; height: 20px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🖼️</div>
    <h1>Sign NFT Transfer</h1>
    <p class="subtitle">Approve this transaction in Phantom to transfer your NFT</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">NFT Mint</span>
        <span class="info-value">${mint.slice(0, 8)}...${mint.slice(-8)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Recipient</span>
        <span class="info-value">${to.slice(0, 8)}...${to.slice(-8)}</span>
      </div>
    </div>
    
    <button class="btn btn-phantom" id="sign-btn"><span>✍️</span> Sign & Send Transaction</button>
    <button class="btn btn-secondary" onclick="cancelTransfer()">Cancel</button>
    <div class="status" id="status"></div>
  </div>
  
  <script>
    const txBase64 = '${tx}';
    const isVersioned = ${isVersioned};
    
    function showStatus(msg, type) { 
      const el = document.getElementById('status'); 
      el.textContent = msg; 
      el.className = 'status ' + type; 
      el.style.display = 'block'; 
    }
    
    function setLoading(loading) { 
      const btn = document.getElementById('sign-btn'); 
      btn.disabled = loading; 
      btn.innerHTML = loading ? '<div class="spinner"></div> Signing...' : '<span>✍️</span> Sign & Send Transaction'; 
    }
    
    async function notifyApp(success, signature, error) {
      try {
        await fetch('/nft-transfer-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success, signature, error })
        });
      } catch (e) {
        console.error('Failed to notify app:', e);
      }
    }
    
    function cancelTransfer() {
      notifyApp(false, null, 'User cancelled');
      window.close();
    }
    
    document.getElementById('sign-btn').addEventListener('click', async function() {
      const provider = window.phantom?.solana || window.solana;
      
      if (!provider?.isPhantom) {
        showStatus('Phantom wallet not detected. Please install it.', 'error');
        return;
      }
      
      setLoading(true);
      showStatus('Connecting to Phantom...', 'info');
      
      try {
        // Connect if not connected
        if (!provider.isConnected) {
          await provider.connect();
        }
        
        showStatus('Please approve the transaction in Phantom...', 'info');
        
        // Decode the transaction
        const txBuffer = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
        
        // Sign and send the transaction
        // For versioned transactions (cNFTs), Phantom handles them the same way
        const { signature } = await provider.signAndSendTransaction({
          serialize: () => txBuffer,
          // Phantom auto-detects versioned vs legacy transactions from the buffer
        });
        
        showStatus('Transaction sent! Signature: ' + signature.slice(0, 16) + '...', 'success');
        
        // Notify the desktop app
        await notifyApp(true, signature, null);
        
        // Auto-close after 3 seconds
        setTimeout(() => window.close(), 3000);
        
      } catch (err) {
        console.error('Transfer error:', err);
        const errorMsg = err.message || 'Transaction failed';
        showStatus(errorMsg, 'error');
        setLoading(false);
        
        // Notify app of failure
        await notifyApp(false, null, errorMsg);
      }
    });
    
    // Check for Phantom on load
    window.addEventListener('load', () => {
      const provider = window.phantom?.solana || window.solana;
      if (!provider?.isPhantom) {
        showStatus('Phantom wallet not detected. Please install it.', 'error');
        document.getElementById('sign-btn').disabled = true;
      }
    });
  </script>
</body>
</html>`);
});

const startUpdateChecker = () => {
    updater.startAutoCheck((result) => {
        if (result.available) {
            console.log(`\n✨ Update available: v${result.version}`);
            console.log(`Run 'npm run update' to install\n`);
        }
    });
};

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

const startHttp = () => {
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Secure Backup Server running on 0.0.0.0:${PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        startUpdateChecker();
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

    if (JWT_SECRET === 'super-secure-secret-key-change-this') {
        console.warn('⚠️  JWT_SECRET is using the default value. Set a strong JWT_SECRET for remote deployments.');
    }

    const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_PATH),
        cert: fs.readFileSync(TLS_CERT_PATH)
    };

    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log(`\n🔐 HTTPS enabled on 0.0.0.0:${HTTPS_PORT}`);
        console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
        console.log(`💾 Database: ${DB_PATH}\n`);
        startUpdateChecker();
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
        http.createServer(redirectApp).listen(PORT, '0.0.0.0', () => {
            console.log(`↪️  HTTP redirect enabled on 0.0.0.0:${PORT} -> HTTPS`);
        });
    }
};

if (ENABLE_HTTPS) startHttps();
else startHttp();
