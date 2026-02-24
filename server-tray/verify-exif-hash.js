#!/usr/bin/env node
/**
 * PhotoLynk EXIF Hash Verification Script
 * 
 * Reproduces the exact normalized EXIF hash used in PhotoLynk certificates.
 * The hash is SHA-256 of a deterministic JSON of parsed EXIF fields with:
 *   - Non-GPS decimals rounded to 4 decimal places (r4)
 *   - GPS values truncated to 4 decimal places (t4)
 *   - Keys sorted alphabetically
 *
 * Usage:
 *   npm install exifreader   (one-time)
 *   node verify-exif-hash.js <image_file>
 *
 * The output hash should match the EXIF Hash in your certificate.
 */
const crypto = require('crypto');
const file = process.argv[2];
if (!file) { console.error('Usage: node verify-exif-hash.js <image_file>'); process.exit(1); }

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
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  console.log(hash);
  console.log('\nFields used (' + Object.keys(sorted).length + '):');
  for (const [k, v] of Object.entries(sorted)) console.log('  ' + k + ': ' + JSON.stringify(v));
})();
