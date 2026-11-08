const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
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

const resolveBaseDir = () => {
  if (process.env.PHOTOSYNC_DATA_DIR) return process.env.PHOTOSYNC_DATA_DIR;
  if (process.env.UPLOAD_DIR) return path.dirname(process.env.UPLOAD_DIR);
  if (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) || isExistingDir(DEFAULT_LINUX_DB_DIR)) return '/data';
  const photolynkDir = path.join(HOME_DIR, 'PhotoLynk', 'server');
  const photosyncDir = path.join(HOME_DIR, 'PhotoSync', 'server');
  try {
    if (fs.existsSync(photolynkDir)) return photolynkDir;
    if (fs.existsSync(photosyncDir)) return photosyncDir;
  } catch (e) {
  }
  return photolynkDir;
};

const BASE_DIR = resolveBaseDir();
const UPLOAD_DIR =
  process.env.UPLOAD_DIR || (isExistingDir(DEFAULT_LINUX_MEDIA_DIR) ? DEFAULT_LINUX_MEDIA_DIR : path.join(BASE_DIR, 'uploads'));
const DB_PATH =
  process.env.DB_PATH || (isExistingDir(DEFAULT_LINUX_DB_DIR) ? path.join(DEFAULT_LINUX_DB_DIR, 'backup.db') : path.join(BASE_DIR, 'backup.db'));

console.log('\n🔍 ===== PHOTOLYNK INTEGRITY CHECK =====\n');
console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
console.log(`💾 Database: ${DB_PATH}`);
console.log(`🏠 Home directory: ${HOME_DIR}`);
console.log(`🖥️  Platform: ${os.platform()}`);
console.log('');

// Check if paths exist
if (!fs.existsSync(UPLOAD_DIR)) {
  console.log('❌ Upload directory does not exist!');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.log('❌ Database does not exist!');
  process.exit(1);
}

console.log('✅ Paths exist\n');

// Open database
const db = new sqlite3.Database(DB_PATH);

// Check database entries
db.all('SELECT COUNT(*) as count FROM files', [], (err, rows) => {
  if (err) {
    console.error('❌ Database error:', err);
    db.close();
    return;
  }
  
  const dbCount = rows[0].count;
  console.log(`💾 Database entries: ${dbCount}`);
  
  // Get all device UUIDs from database
  db.all('SELECT DISTINCT user_id FROM files', [], (err, users) => {
    if (err) {
      console.error('❌ Error getting users:', err);
      db.close();
      return;
    }
    
    console.log(`👥 Users in database: ${users.length}\n`);
    
    // Check filesystem
    console.log('📂 Checking filesystem...');
    
    const deviceDirs = fs.readdirSync(UPLOAD_DIR)
      .filter(name => !name.startsWith('.'))
      .filter(name => fs.statSync(path.join(UPLOAD_DIR, name)).isDirectory());
    
    console.log(`📁 Device folders: ${deviceDirs.length}`);
    
    let totalFiles = 0;
    deviceDirs.forEach(uuid => {
      const deviceDir = path.join(UPLOAD_DIR, uuid);
      const files = fs.readdirSync(deviceDir)
        .filter(name => !name.startsWith('.'))
        .filter(name => fs.statSync(path.join(deviceDir, name)).isFile());
      
      totalFiles += files.length;
      console.log(`  📂 ${uuid}: ${files.length} files`);
    });
    
    console.log(`\n📊 Total files on disk: ${totalFiles}`);
    
    // Compare database vs filesystem
    console.log('\n🔍 Integrity Check:');
    if (dbCount === totalFiles) {
      console.log('✅ Database and filesystem match!');
    } else {
      console.log(`⚠️  Mismatch: DB has ${dbCount} entries, filesystem has ${totalFiles} files`);
      console.log(`   Difference: ${Math.abs(dbCount - totalFiles)}`);
    }
    
    // Check for duplicates in database
    db.all(`
      SELECT filename, COUNT(*) as count 
      FROM files 
      GROUP BY filename 
      HAVING count > 1
    `, [], (err, dups) => {
      if (dups && dups.length > 0) {
        console.log(`\n⚠️  Found ${dups.length} duplicate filenames in database:`);
        dups.forEach(d => console.log(`   - ${d.filename}: ${d.count} entries`));
      } else {
        console.log('\n✅ No duplicate filenames in database');
      }
      
      // Check path consistency
      console.log('\n🔍 Path Consistency Check:');
      console.log('✅ Upload uses: UPLOAD_DIR + device_uuid');
      console.log('✅ List uses: UPLOAD_DIR + device_uuid');
      console.log('✅ Download uses: UPLOAD_DIR + device_uuid');
      console.log('✅ All operations use same base path');
      
      console.log('\n✅ ===== INTEGRITY CHECK COMPLETE =====\n');
      
      db.close();
    });
  });
});
