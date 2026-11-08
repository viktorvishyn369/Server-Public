#!/usr/bin/env node
/**
 * ONE-TIME MIGRATION SCRIPT
 * Renames existing user storage folders from legacy keys (numeric id, storage_uuid, user_uuid)
 * to the user's current device_uuid (UUIDv5 from email:password).
 *
 * Usage:
 *   node migrate-folders-to-device-uuid.js                  # DRY RUN (shows what would happen)
 *   node migrate-folders-to-device-uuid.js --execute         # ACTUALLY RENAME FOLDERS
 *
 * IMPORTANT:
 *   - Stop the PhotoLynk service BEFORE running with --execute
 *   - Back up your DB and folders first
 *   - Run dry-run first to review the plan
 *
 * Paths (auto-detected from environment or defaults for stealthlynk.io main server):
 *   DB_PATH       = /mnt/nvme-buffer/db/backup.db
 *   CLOUD_DIR     = /mnt/nvme-buffer/cloud
 *   CHUNKS_DIR    = /data/chunks
 *   NFT_DIR       = /mnt/nvme-buffer/cloud/nft
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ─── Configuration ───────────────────────────────────────────────────────────
const DRY_RUN = !process.argv.includes('--execute');

// Auto-detect paths (same logic as install script)
const NVME_MOUNT = '/mnt/nvme-buffer';
const RAID_MOUNT = '/data';

const nvmeAvailable = (() => {
    try { return fs.existsSync(NVME_MOUNT) && fs.statSync(NVME_MOUNT).isDirectory(); } catch { return false; }
})();
const raidAvailable = (() => {
    try { return fs.existsSync(RAID_MOUNT) && fs.statSync(RAID_MOUNT).isDirectory(); } catch { return false; }
})();

let DB_PATH, CLOUD_DIR, CHUNKS_DIR;

if (nvmeAvailable) {
    DB_PATH    = process.env.DB_PATH    || path.join(NVME_MOUNT, 'db', 'backup.db');
    CLOUD_DIR  = process.env.CLOUD_DIR  || path.join(NVME_MOUNT, 'cloud');
    CHUNKS_DIR = process.env.CHUNKS_DIR || path.join(RAID_MOUNT, 'chunks');
} else if (raidAvailable) {
    DB_PATH    = process.env.DB_PATH    || path.join(RAID_MOUNT, 'db', 'backup.db');
    CLOUD_DIR  = process.env.CLOUD_DIR  || path.join(RAID_MOUNT, 'cloud');
    CHUNKS_DIR = process.env.CHUNKS_DIR || path.join(RAID_MOUNT, 'chunks');
} else {
    // Fallback: relative to this script
    const serverDir = __dirname;
    DB_PATH    = process.env.DB_PATH    || path.join(serverDir, 'backup.db');
    CLOUD_DIR  = process.env.CLOUD_DIR  || path.join(serverDir, 'cloud');
    CHUNKS_DIR = process.env.CHUNKS_DIR || path.join(serverDir, 'chunks');
}

const NFT_DIR = path.join(CLOUD_DIR, 'nft');
const CLOUD_USERS = path.join(CLOUD_DIR, 'users');
const CHUNKS_USERS = path.join(CHUNKS_DIR, 'users');

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sanitize = (v) => {
    const raw = String(v || '');
    return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || '';
};

const dirExists = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
};

const dirSize = (p) => {
    let total = 0;
    try {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) {
                total += dirSize(full);
            } else {
                try { total += fs.statSync(full).size; } catch {}
            }
        }
    } catch {}
    return total;
};

const formatBytes = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// ─── DB helpers ──────────────────────────────────────────────────────────────
const dbAll = (db, sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

// ─── Safe rename with merge ─────────────────────────────────────────────────
const safeRename = (oldDir, newDir, label, dryRun) => {
    if (!dirExists(oldDir)) return false;
    if (oldDir === newDir) return false;

    const size = dirSize(oldDir);

    if (dirExists(newDir)) {
        // Merge: move contents from old into new
        if (dryRun) {
            console.log(`  [MERGE] ${label}: ${oldDir} -> ${newDir} (${formatBytes(size)})`);
            return true;
        }
        console.log(`  [MERGE] ${label}: ${oldDir} -> ${newDir} (${formatBytes(size)})`);
        const entries = fs.readdirSync(oldDir, { withFileTypes: true });
        for (const entry of entries) {
            const src = path.join(oldDir, entry.name);
            const dst = path.join(newDir, entry.name);
            if (entry.isDirectory()) {
                if (!dirExists(dst)) {
                    fs.renameSync(src, dst);
                } else {
                    // Recurse one level for subdirs like chunks/, manifests/, raw/
                    const subEntries = fs.readdirSync(src);
                    for (const sf of subEntries) {
                        const subSrc = path.join(src, sf);
                        const subDst = path.join(dst, sf);
                        if (!fs.existsSync(subDst)) {
                            fs.renameSync(subSrc, subDst);
                        }
                    }
                }
            } else {
                if (!fs.existsSync(dst)) {
                    fs.renameSync(src, dst);
                }
            }
        }
        // Remove old dir if empty
        try {
            const remaining = fs.readdirSync(oldDir);
            if (remaining.length === 0) fs.rmdirSync(oldDir);
        } catch {}
        return true;
    }

    // Simple rename
    if (dryRun) {
        console.log(`  [RENAME] ${label}: ${oldDir} -> ${newDir} (${formatBytes(size)})`);
        return true;
    }
    console.log(`  [RENAME] ${label}: ${oldDir} -> ${newDir} (${formatBytes(size)})`);
    fs.renameSync(oldDir, newDir);
    return true;
};

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(70));
    console.log(DRY_RUN
        ? '  DRY RUN — no changes will be made (pass --execute to apply)'
        : '  ⚠  EXECUTING — folders WILL be renamed');
    console.log('='.repeat(70));
    console.log(`  DB_PATH      : ${DB_PATH}`);
    console.log(`  CLOUD_USERS  : ${CLOUD_USERS}`);
    console.log(`  CHUNKS_USERS : ${CHUNKS_USERS}`);
    console.log(`  NFT_DIR      : ${NFT_DIR}`);
    console.log('='.repeat(70));

    if (!fs.existsSync(DB_PATH)) {
        console.error(`ERROR: Database not found at ${DB_PATH}`);
        process.exit(1);
    }

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

    // 1. Load all users
    const users = await dbAll(db, `SELECT id, email, user_uuid, storage_uuid FROM users ORDER BY id`);
    console.log(`\nFound ${users.length} users in database.\n`);

    // 2. Load all devices
    const devices = await dbAll(db, `SELECT user_id, device_uuid FROM devices ORDER BY user_id, id DESC`);
    const devicesByUser = {};
    for (const d of devices) {
        if (!devicesByUser[d.user_id]) devicesByUser[d.user_id] = [];
        devicesByUser[d.user_id].push(d.device_uuid);
    }

    let totalActions = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
        const userDevices = devicesByUser[user.id] || [];
        // Deduplicate device_uuids
        const uniqueDeviceUuids = [...new Set(userDevices.map(d => sanitize(d)).filter(Boolean))];
        const targetDeviceUuid = uniqueDeviceUuids[0]; // most recent

        if (!targetDeviceUuid) {
            console.log(`[User ${user.id}] ${user.email} — NO device_uuid in devices table, SKIPPING`);
            console.log(`  (user_uuid=${user.user_uuid || 'null'}, storage_uuid=${user.storage_uuid || 'null'})`);
            skipped++;
            continue;
        }

        // If user has multiple DIFFERENT device_uuids, we can't know which matches
        // the current password (DB only has bcrypt hash). Skip and let the server
        // auto-migrate at next login when the app sends the correct device_uuid.
        if (uniqueDeviceUuids.length > 1) {
            console.log(`[User ${user.id}] ${user.email} — MULTIPLE device_uuids (${uniqueDeviceUuids.length}), SKIPPING (will auto-migrate at next login)`);
            console.log(`  device_uuids: ${uniqueDeviceUuids.join(', ')}`);
            skipped++;
            continue;
        }

        // Collect all legacy keys that are NOT the target
        const legacyKeys = new Set();
        // Numeric id
        legacyKeys.add(String(user.id));
        // user_uuid
        if (user.user_uuid) legacyKeys.add(sanitize(user.user_uuid));
        // storage_uuid (HMAC-based)
        if (user.storage_uuid) legacyKeys.add(sanitize(user.storage_uuid));
        // All older device_uuids
        for (const du of userDevices) {
            const s = sanitize(du);
            if (s) legacyKeys.add(s);
        }
        // Remove the target itself
        legacyKeys.delete(targetDeviceUuid);
        // Remove empty
        legacyKeys.delete('');

        // Check if target folder already exists
        const targetCloudExists = dirExists(path.join(CLOUD_USERS, targetDeviceUuid));
        const targetChunksExists = dirExists(path.join(CHUNKS_USERS, targetDeviceUuid));
        const targetNftExists = dirExists(path.join(NFT_DIR, targetDeviceUuid));

        // Find which legacy keys have actual folders
        let hasWork = false;
        const legacyWithFolders = [];
        for (const key of legacyKeys) {
            const hasCloud = dirExists(path.join(CLOUD_USERS, key));
            const hasChunks = dirExists(path.join(CHUNKS_USERS, key));
            const hasNft = dirExists(path.join(NFT_DIR, key));
            if (hasCloud || hasChunks || hasNft) {
                legacyWithFolders.push({ key, hasCloud, hasChunks, hasNft });
                hasWork = true;
            }
        }

        if (!hasWork) {
            // Already migrated or new user with no legacy folders
            if (targetCloudExists || targetChunksExists) {
                // Already using target key — all good
            } else {
                console.log(`[User ${user.id}] ${user.email} — no folders found (new user or already clean)`);
            }
            continue;
        }

        console.log(`\n[User ${user.id}] ${user.email}`);
        console.log(`  Target device_uuid: ${targetDeviceUuid}`);
        console.log(`  Legacy keys with folders: ${legacyWithFolders.map(l => l.key).join(', ')}`);

        for (const legacy of legacyWithFolders) {
            try {
                if (legacy.hasCloud) {
                    const did = safeRename(
                        path.join(CLOUD_USERS, legacy.key),
                        path.join(CLOUD_USERS, targetDeviceUuid),
                        'cloud',
                        DRY_RUN
                    );
                    if (did) totalActions++;
                }
                if (legacy.hasChunks) {
                    const did = safeRename(
                        path.join(CHUNKS_USERS, legacy.key),
                        path.join(CHUNKS_USERS, targetDeviceUuid),
                        'chunks',
                        DRY_RUN
                    );
                    if (did) totalActions++;
                }
                if (legacy.hasNft) {
                    const did = safeRename(
                        path.join(NFT_DIR, legacy.key),
                        path.join(NFT_DIR, targetDeviceUuid),
                        'nft',
                        DRY_RUN
                    );
                    if (did) totalActions++;
                }
            } catch (e) {
                console.error(`  ERROR migrating ${legacy.key}: ${e.message}`);
                errors++;
            }
        }
    }

    db.close();

    console.log('\n' + '='.repeat(70));
    console.log(`  Summary:`);
    console.log(`    Users processed : ${users.length}`);
    console.log(`    Skipped (no device_uuid) : ${skipped}`);
    console.log(`    Folder operations : ${totalActions}`);
    console.log(`    Errors : ${errors}`);
    console.log(`    Mode : ${DRY_RUN ? 'DRY RUN (no changes made)' : 'EXECUTED'}`);
    console.log('='.repeat(70));

    if (DRY_RUN && totalActions > 0) {
        console.log('\n  To apply these changes, run:');
        console.log('    node migrate-folders-to-device-uuid.js --execute\n');
    }
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
