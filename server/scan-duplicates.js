const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);

const getArgValue = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
};

const hasFlag = (name) => args.includes(name);

const printUsageAndExit = (code = 1) => {
  console.log(`\nUsage:\n  node scan-duplicates.js --uuid <device_uuid> [--uploads <uploads_dir>]\n  node scan-duplicates.js --path <absolute_or_relative_folder_path>\n\nOptions:\n  --uuid <device_uuid>     Device UUID folder inside uploads (e.g. cf658c8a-...)\n  --uploads <dir>          Uploads base dir (default: ./uploads)\n  --path <dir>             Scan a direct folder path (overrides --uuid/--uploads)\n  --max <n>                Max files to scan (default: no limit)\n  --delete                 Actually delete duplicates (DANGEROUS). Default is report-only.\n\nBehavior:\n  - Computes SHA-256 for each file and groups duplicates by hash.\n  - Keeps the first file in each group, reports the rest as duplicates.\n`);
  process.exit(code);
};

const maxStr = getArgValue('--max');
const maxFiles = maxStr ? Number(maxStr) : null;
if (maxStr && (!Number.isFinite(maxFiles) || maxFiles <= 0)) {
  console.error('Invalid --max value');
  printUsageAndExit(1);
}

const explicitPath = getArgValue('--path');
const uuid = getArgValue('--uuid');
const uploadsDirArg = getArgValue('--uploads');
const deleteMode = hasFlag('--delete');

if (!explicitPath && !uuid) {
  printUsageAndExit(1);
}

const uploadsBase = uploadsDirArg
  ? path.resolve(uploadsDirArg)
  : path.resolve(__dirname, 'uploads');

const targetDir = explicitPath
  ? path.resolve(explicitPath)
  : path.join(uploadsBase, uuid);

if (!fs.existsSync(targetDir)) {
  console.error(`Folder not found: ${targetDir}`);
  process.exit(1);
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const listFilesRecursively = (dir) => {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile()) {
        out.push(p);
      }
    }
  }
  return out;
};

const sha256File = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
};

const main = async () => {
  console.log(`\n🔎 Scanning folder: ${targetDir}`);
  console.log(`Mode: ${deleteMode ? 'DELETE (dangerous)' : 'REPORT ONLY'}`);

  const files = listFilesRecursively(targetDir);
  const scanList = maxFiles ? files.slice(0, maxFiles) : files;

  if (scanList.length === 0) {
    console.log('No files found.');
    return;
  }

  console.log(`Found ${scanList.length} file(s) to scan...`);

  const groups = new Map(); // hash -> [paths]
  let scanned = 0;
  let failed = 0;

  for (const filePath of scanList) {
    if (!isFile(filePath)) continue;
    try {
      const hash = await sha256File(filePath);
      const arr = groups.get(hash) || [];
      arr.push(filePath);
      groups.set(hash, arr);
      scanned++;
      if (scanned % 25 === 0) {
        console.log(`...hashed ${scanned}/${scanList.length}`);
      }
    } catch (e) {
      failed++;
    }
  }

  const dupGroups = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);

  console.log(`\n✅ Hashed ${scanned} file(s)${failed ? `, failed ${failed}` : ''}.`);
  if (dupGroups.length === 0) {
    console.log('✅ No exact duplicates found by SHA-256.');
    return;
  }

  let dupFiles = 0;
  for (const [, arr] of dupGroups) dupFiles += (arr.length - 1);

  console.log(`⚠️  Found ${dupFiles} duplicate file(s) across ${dupGroups.length} hash group(s).\n`);

  for (const [hash, arr] of dupGroups) {
    const keep = arr[0];
    const dups = arr.slice(1);
    console.log(`Hash: ${hash}`);
    console.log(`  Keep: ${path.relative(targetDir, keep)}`);
    for (const p of dups) {
      console.log(`  Dup : ${path.relative(targetDir, p)}`);
    }
    console.log('');

    if (deleteMode) {
      for (const p of dups) {
        try {
          fs.unlinkSync(p);
          console.log(`  🗑️ Deleted: ${path.relative(targetDir, p)}`);
        } catch (e) {
          console.log(`  ✗ Failed delete: ${path.relative(targetDir, p)} (${e.message})`);
        }
      }
      console.log('');
    }
  }

  if (!deleteMode) {
    console.log('Tip: re-run with --delete to remove duplicates (NOT recommended unless you have backups).');
  }
};

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
