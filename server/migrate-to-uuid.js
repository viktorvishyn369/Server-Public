#!/usr/bin/env node

/**
 * Migration Script: User ID folders → Device UUID folders
 * 
 * This script migrates files from old user_id-based folders (1, 2, 3, etc.)
 * to new device_uuid-based folders.
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DEFAULT_LINUX_MEDIA_DIR = '/data/media';
const DEFAULT_LINUX_DB_DIR = '/data/db';

const isExistingDir = (p) => {
    try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch (e) {
        return false;
    }
};

const DB_PATH =
    process.env.DB_PATH || (isExistingDir(DEFAULT_LINUX_DB_DIR) ? path.join(DEFAULT_LINUX_DB_DIR, 'backup.db') : path.join(__dirname, 'backup.db'));
const UPLOAD_DIR =
    process.env.UPLOAD_DIR || (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) ? DEFAULT_LINUX_MEDIA_DIR : path.join(__dirname, 'uploads'));

console.log('🔄 Starting migration from user_id folders to device_uuid folders...\n');

// Open database
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Database error:', err.message);
        process.exit(1);
    }
    console.log('✅ Connected to database\n');
});

// Get all devices with their user_id and device_uuid
db.all(`SELECT user_id, device_uuid FROM devices`, [], (err, devices) => {
    if (err) {
        console.error('❌ Error fetching devices:', err.message);
        db.close();
        process.exit(1);
    }

    if (devices.length === 0) {
        console.log('ℹ️  No devices found in database. Nothing to migrate.');
        db.close();
        process.exit(0);
    }

    console.log(`📋 Found ${devices.length} device(s) to migrate:\n`);

    let migratedCount = 0;
    let errorCount = 0;

    devices.forEach((device, index) => {
        const oldFolder = path.join(UPLOAD_DIR, String(device.user_id));
        const newFolder = path.join(UPLOAD_DIR, device.device_uuid);

        console.log(`[${index + 1}/${devices.length}] Processing:`);
        console.log(`  User ID: ${device.user_id}`);
        console.log(`  Device UUID: ${device.device_uuid}`);
        console.log(`  Old folder: ${oldFolder}`);
        console.log(`  New folder: ${newFolder}`);

        // Check if old folder exists
        if (!fs.existsSync(oldFolder)) {
            console.log(`  ⚠️  Old folder doesn't exist, skipping...\n`);
            return;
        }

        // Check if new folder already exists
        if (fs.existsSync(newFolder)) {
            console.log(`  ⚠️  New folder already exists, skipping...\n`);
            return;
        }

        try {
            // Rename/move the folder
            fs.renameSync(oldFolder, newFolder);
            console.log(`  ✅ Migrated successfully!\n`);
            migratedCount++;
        } catch (error) {
            console.error(`  ❌ Error migrating: ${error.message}\n`);
            errorCount++;
        }
    });

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('📊 Migration Summary:');
    console.log(`  Total devices: ${devices.length}`);
    console.log(`  Successfully migrated: ${migratedCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Skipped: ${devices.length - migratedCount - errorCount}`);
    console.log('═══════════════════════════════════════\n');

    if (migratedCount > 0) {
        console.log('✅ Migration completed successfully!');
        console.log('ℹ️  Old folders have been renamed to UUID-based folders.');
        console.log('ℹ️  You can now restart the server.\n');
    } else {
        console.log('ℹ️  No folders were migrated.\n');
    }

    db.close();
});
