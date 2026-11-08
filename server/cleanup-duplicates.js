const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DEFAULT_LINUX_DB_DIR = '/data/db';
const DB_PATH =
  process.env.DB_PATH || (fs.existsSync(DEFAULT_LINUX_DB_DIR) ? path.join(DEFAULT_LINUX_DB_DIR, 'backup.db') : path.join(__dirname, 'backup.db'));
const db = new sqlite3.Database(DB_PATH);

console.log('🔍 Checking for duplicate filenames in database...\n');

// Find duplicates
db.all(`
  SELECT filename, user_id, COUNT(*) as count 
  FROM files 
  GROUP BY user_id, filename 
  HAVING count > 1
`, [], (err, duplicates) => {
  if (err) {
    console.error('Error finding duplicates:', err);
    db.close();
    return;
  }

  if (duplicates.length === 0) {
    console.log('✅ No duplicate filenames found!');
    db.close();
    return;
  }

  console.log(`⚠️  Found ${duplicates.length} duplicate filenames:\n`);
  
  duplicates.forEach(dup => {
    console.log(`  - "${dup.filename}" (user_id: ${dup.user_id}): ${dup.count} entries`);
  });

  console.log('\n🧹 Cleaning up duplicates...\n');

  // For each duplicate, keep only the most recent entry
  let cleaned = 0;
  let remaining = duplicates.length;

  duplicates.forEach(dup => {
    // Get all entries for this filename
    db.all(`
      SELECT id, filename, file_hash, created_at 
      FROM files 
      WHERE user_id = ? AND filename = ?
      ORDER BY created_at DESC
    `, [dup.user_id, dup.filename], (err, entries) => {
      if (err) {
        console.error(`Error getting entries for ${dup.filename}:`, err);
        remaining--;
        if (remaining === 0) finishCleanup();
        return;
      }

      // Keep the first (most recent), delete the rest
      const toKeep = entries[0];
      const toDelete = entries.slice(1);

      console.log(`  📄 ${dup.filename}:`);
      console.log(`     ✓ Keeping: ID ${toKeep.id} (hash: ${toKeep.file_hash.substring(0, 8)}...)`);

      toDelete.forEach(entry => {
        db.run(`DELETE FROM files WHERE id = ?`, [entry.id], (err) => {
          if (err) {
            console.error(`     ✗ Error deleting ID ${entry.id}:`, err);
          } else {
            console.log(`     ✗ Deleted: ID ${entry.id} (hash: ${entry.file_hash.substring(0, 8)}...)`);
            cleaned++;
          }
        });
      });

      remaining--;
      if (remaining === 0) {
        setTimeout(() => finishCleanup(), 500); // Wait for deletes to complete
      }
    });
  });

  function finishCleanup() {
    console.log(`\n✅ Cleanup complete! Removed ${cleaned} duplicate entries.`);
    
    // Verify cleanup
    db.all(`
      SELECT filename, user_id, COUNT(*) as count 
      FROM files 
      GROUP BY user_id, filename 
      HAVING count > 1
    `, [], (err, remaining) => {
      if (remaining && remaining.length > 0) {
        console.log(`⚠️  Warning: ${remaining.length} duplicates still remain`);
      } else {
        console.log('✅ No duplicates remaining!');
      }
      db.close();
    });
  }
});
