#!/usr/bin/env node
/**
 * PhotoLynk EXIF Hash Verification Script
 * 
 * Verifies BOTH EXIF hashes in PhotoLynk certificates:
 *   Hash1 (EXIF Raw Hash): SHA-256 of raw EXIF binary with IFD1 thumbnail stripped
 *   Hash2 (EXIF Hash): SHA-256 of normalized JSON of parsed EXIF fields
 *   Hash3 (EXIF Binding Hash): SHA-256(Hash1 + "|" + Hash2)
 *
 * Normalization rules for Hash2:
 *   - Non-GPS decimals rounded to 4 decimal places (r4)
 *   - GPS values truncated to 4 decimal places (t4)
 *   - Keys sorted alphabetically
 *
 * Usage:
 *   npm install exifreader   (one-time)
 *   node verify-exif-hash.js <image_file>
 *
 * The output hashes should match the certificate values.
 */
const crypto = require('crypto');
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('Usage: node verify-exif-hash.js <image_file>'); process.exit(1); }

// ── Raw EXIF extraction + thumbnail stripping (matches nftDesktop.js) ──
function extractRawExifBytes(filePath) {
  const headerBuf = Buffer.alloc(64);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, headerBuf, 0, 64, 0);
  if (headerBuf[0] === 0xFF && headerBuf[1] === 0xD8) {
    const stat = fs.fstatSync(fd); const scanLen = Math.min(stat.size, 256 * 1024);
    const scanBuf = Buffer.alloc(scanLen); fs.readSync(fd, scanBuf, 0, scanLen, 0); fs.closeSync(fd);
    let pos = 2;
    while (pos + 4 < scanLen) {
      if (scanBuf[pos] !== 0xFF) break;
      const marker = scanBuf[pos + 1]; const segLen = (scanBuf[pos + 2] << 8) | scanBuf[pos + 3];
      if (marker === 0xE1 && segLen > 8 && scanBuf[pos+4]===0x45 && scanBuf[pos+5]===0x78 &&
          scanBuf[pos+6]===0x69 && scanBuf[pos+7]===0x66 && scanBuf[pos+8]===0x00 && scanBuf[pos+9]===0x00) {
        return scanBuf.slice(pos + 4, pos + 2 + segLen);
      }
      if (marker === 0xDA) break; pos += 2 + segLen;
    }
    return null;
  }
  if (headerBuf[0]===0x89 && headerBuf[1]===0x50 && headerBuf[2]===0x4E && headerBuf[3]===0x47) {
    const stat = fs.fstatSync(fd); const scanLen = Math.min(stat.size, 512*1024);
    const scanBuf = Buffer.alloc(scanLen); fs.readSync(fd, scanBuf, 0, scanLen, 0); fs.closeSync(fd);
    let pos = 8;
    while (pos+12 < scanLen) {
      const chunkLen = (scanBuf[pos]<<24|scanBuf[pos+1]<<16|scanBuf[pos+2]<<8|scanBuf[pos+3])>>>0;
      const ct = scanBuf.slice(pos+4, pos+8).toString('ascii');
      if (ct === 'eXIf' && chunkLen > 0) return scanBuf.slice(pos+8, pos+8+chunkLen);
      if (ct === 'IEND') break; pos += 12 + chunkLen;
    }
    return null;
  }
  if (headerBuf.slice(0,4).toString('ascii')==='RIFF' && headerBuf.slice(8,12).toString('ascii')==='WEBP') {
    const stat = fs.fstatSync(fd); const scanLen = Math.min(stat.size, 512*1024);
    const scanBuf = Buffer.alloc(scanLen); fs.readSync(fd, scanBuf, 0, scanLen, 0); fs.closeSync(fd);
    let pos = 12;
    while (pos+8 < scanLen) {
      const id = scanBuf.slice(pos, pos+4).toString('ascii');
      const sz = (scanBuf[pos+4]|(scanBuf[pos+5]<<8)|(scanBuf[pos+6]<<16)|((scanBuf[pos+7]<<24)>>>0));
      if (id === 'EXIF' && sz > 0) return scanBuf.slice(pos+8, pos+8+sz);
      pos += 8 + sz + (sz % 2);
    }
    return null;
  }
  fs.closeSync(fd);
  try { const sharp = require('sharp'); const meta = sharp(filePath).metadata(); if (meta.exif) return meta.exif; } catch(_) {}
  return null;
}

function stripThumbnailFromTiff(raw) {
  if (!raw || raw.length < 16) return raw;
  const buf = Buffer.from(raw);
  let t = 0;
  if (buf[0]===0x45&&buf[1]===0x78&&buf[2]===0x69&&buf[3]===0x66&&buf[4]===0x00&&buf[5]===0x00) t = 6;
  if (t + 8 > buf.length) return buf;
  const le = (buf[t]===0x49&&buf[t+1]===0x49), be = (buf[t]===0x4D&&buf[t+1]===0x4D);
  if (!le && !be) return buf;
  const u16 = (off) => le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
  const u32 = (off) => le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
  const w32 = (off, v) => { if (le) buf.writeUInt32LE(v, off); else buf.writeUInt32BE(v, off); };
  const ifd0Abs = t + u32(t + 4); if (ifd0Abs+2 > buf.length) return buf;
  const ifd0Count = u16(ifd0Abs); const ifd0End = ifd0Abs + 2 + ifd0Count * 12;
  if (ifd0End+4 > buf.length) return buf;
  const ifd1Rel = u32(ifd0End); if (ifd1Rel === 0) return buf;
  const ifd1Abs = t + ifd1Rel; if (ifd1Abs+2 > buf.length) return buf;
  const ifd1Count = u16(ifd1Abs);
  if (ifd1Abs + 2 + ifd1Count*12 + 4 > buf.length) return buf;
  w32(ifd0End, 0);
  let thOff=0, thLen=0, thOffTag=0, thLenTag=0;
  for (let i=0; i<ifd1Count; i++) {
    const e = ifd1Abs+2+i*12; const tag = u16(e);
    if (tag===0x0201) { thOff=u32(e+8); thOffTag=e+8; }
    else if (tag===0x0202) { thLen=u32(e+8); thLenTag=e+8; }
  }
  if (thOff>0 && thLen>0) { const s=t+thOff, e2=Math.min(s+thLen,buf.length); if(s<buf.length) buf.fill(0,s,e2); }
  if (thOffTag) w32(thOffTag, 0); if (thLenTag) w32(thLenTag, 0);
  buf.fill(0, ifd1Abs, Math.min(ifd1Abs+2+ifd1Count*12+4, buf.length));
  return buf;
}

(async () => {
  let ExifReader;
  try { ExifReader = require('exifreader'); } catch (_) {
    console.error('Missing dependency. Run: npm install exifreader'); process.exit(1);
  }
  const tags = await ExifReader.load(file);
  if (!tags) { console.error('No EXIF data found'); process.exit(1); }

  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const t4 = (v) => Math.trunc(v * 1e4) / 1e4;

  const getNum = (key) => {
    const t = tags[key]; if (!t) return null;
    const v = t.value; if (v == null) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? v : r4(v);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      if (v[1] === 0) return 0; const r = v[0] / v[1]; return Number.isInteger(r) ? r : r4(r);
    }
    if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'number') return Number.isInteger(v[0]) ? v[0] : r4(v[0]);
    if (key === 'Flash' && v && typeof v === 'object' && !Array.isArray(v) && v.Fired != null) {
      let bits = 0;
      if (String(v.Fired?.value || v.Fired) === 'True') bits |= 0x01;
      const ret = parseInt(String(v.Return?.value ?? v.Return ?? 0)); if (!isNaN(ret)) bits |= ((ret & 0x03) << 1);
      const mode = parseInt(String(v.Mode?.value ?? v.Mode ?? 0)); if (!isNaN(mode)) bits |= ((mode & 0x03) << 3);
      if (String(v.Function?.value || v.Function) === 'True') bits |= 0x20;
      if (String(v.RedEyeMode?.value || v.RedEyeMode) === 'True') bits |= 0x40;
      return bits;
    }
    const d = t.description;
    if (d != null) { const n = parseFloat(String(d)); if (!isNaN(n)) return Number.isInteger(n) ? n : r4(n); }
    return null;
  };

  const getStr = (key) => {
    const t = tags[key]; if (!t) return null;
    const clean = (s) => s ? String(s).replace(/\0/g, '').trim() : null;
    if (t.description && typeof t.description === 'string') return clean(t.description) || null;
    const v = t.value;
    if (typeof v === 'string') return clean(v) || null;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return clean(v[0]) || null;
    return null;
  };

  const getGps = (key) => {
    const t = tags[key]; if (!t) return null;
    if (t.description != null) { const n = parseFloat(String(t.description)); if (!isNaN(n)) return n; }
    const v = t.value;
    if (Array.isArray(v) && v.length === 3 && Array.isArray(v[0])) {
      const d = v[0][1] !== 0 ? v[0][0] / v[0][1] : 0;
      const m = v[1][1] !== 0 ? v[1][0] / v[1][1] : 0;
      const s = v[2][1] !== 0 ? v[2][0] / v[2][1] : 0;
      return d + m / 60 + s / 3600;
    }
    if (typeof v === 'number') return v;
    return null;
  };

  const n = {};
  const make = getStr('Make'); if (make) n.Make = make;
  const model = getStr('Model'); if (model) n.Model = model;
  const orient = getNum('Orientation'); if (orient != null) n.Orientation = orient;
  const dto = getStr('DateTimeOriginal') || getStr('DateTimeDigitized'); if (dto) n.DateTimeOriginal = dto.slice(0, 19);
  const et = getNum('ExposureTime'); if (et != null) n.ExposureTime = et;
  const fn = getNum('FNumber'); if (fn != null) n.FNumber = fn;
  const iso = getNum('ISOSpeedRatings') ?? getNum('ISO'); if (iso != null) n.ISO = iso;
  const fl = getNum('FocalLength'); if (fl != null) n.FocalLength = fl;
  const fl35 = getNum('FocalLengthIn35mmFilm') ?? getNum('FocalLengthIn35mmFormat'); if (fl35 != null) n.FocalLengthIn35mm = fl35;
  const em = getNum('ExposureMode'); if (em != null) n.ExposureMode = em;
  const wb = getNum('WhiteBalance'); if (wb != null) n.WhiteBalance = wb;
  const mm = getNum('MeteringMode'); if (mm != null) n.MeteringMode = mm;
  const flash = getNum('Flash'); if (flash != null) n.Flash = flash;
  const cs = getNum('ColorSpace'); if (cs != null) n.ColorSpace = cs;
  const pxW = getNum('PixelXDimension') ?? getNum('ExifImageWidth'); if (pxW != null) n.PixelXDimension = pxW;
  const pxH = getNum('PixelYDimension') ?? getNum('ExifImageHeight'); if (pxH != null) n.PixelYDimension = pxH;
  const sct = getNum('SceneCaptureType'); if (sct != null) n.SceneCaptureType = sct;
  const lm = getStr('LensMake'); if (lm) n.LensMake = lm;
  const lmod = getStr('LensModel'); if (lmod) n.LensModel = lmod;
  const bsn = getStr('BodySerialNumber'); if (bsn) n.BodySerialNumber = bsn;
  const lat = getGps('GPSLatitude');
  if (lat != null) { const latRef = getStr('GPSLatitudeRef'); n.GPSLatitude = t4(latRef && latRef.startsWith('S') ? -Math.abs(lat) : lat); }
  const lon = getGps('GPSLongitude');
  if (lon != null) { const lonRef = getStr('GPSLongitudeRef'); n.GPSLongitude = t4(lonRef && lonRef.startsWith('W') ? -Math.abs(lon) : lon); }
  const alt = getGps('GPSAltitude'); if (alt != null) n.GPSAltitude = t4(alt);

  if (Object.keys(n).length === 0) { console.error('No meaningful EXIF fields found'); process.exit(1); }

  const GPS_KEYS = new Set(['GPSLatitude', 'GPSLongitude', 'GPSAltitude']);
  const sorted = {};
  for (const key of Object.keys(n).sort()) {
    let v = n[key];
    if (typeof v === 'number' && !Number.isInteger(v)) v = GPS_KEYS.has(key) ? t4(v) : r4(v);
    sorted[key] = v;
  }
  const json = JSON.stringify(sorted);
  const normalizedHash = crypto.createHash('sha256').update(json).digest('hex');

  // Hash1: Raw EXIF binary with IFD1 thumbnail stripped
  let rawHash = null;
  try {
    const rawBytes = extractRawExifBytes(file);
    if (rawBytes && rawBytes.length > 0) {
      const stable = stripThumbnailFromTiff(rawBytes);
      rawHash = crypto.createHash('sha256').update(stable).digest('hex');
    }
  } catch (e) { /* non-critical */ }

  // Hash3: Binding proof
  const bindInput = `${rawHash || 'none'}|${normalizedHash || 'none'}`;
  const bindingHash = crypto.createHash('sha256').update(bindInput).digest('hex');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  EXIF Raw Hash (Hash1):     ' + (rawHash || '— not available (HEIC/RAW) —'));
  console.log('  EXIF Hash (Hash2):         ' + normalizedHash);
  console.log('  EXIF Binding Hash (Hash3): ' + bindingHash);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nNormalized fields (' + Object.keys(sorted).length + '):');
  for (const [k, v] of Object.entries(sorted)) console.log('  ' + k + ': ' + JSON.stringify(v));
})();
