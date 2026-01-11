const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Decode image (supports HEIC, JPG, PNG, etc via sharp)
async function decodeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  // Use sharp for all formats (handles HEIC, JPG, PNG, etc)
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  
  return {
    data: data,
    width: info.width,
    height: info.height,
    channels: info.channels
  };
}

// Desktop implementation (current)
async function computeDesktopHash(filePath) {
  const decoded = await decodeImage(filePath);
  
  const srcData = Buffer.from(decoded.data);
  const srcWidth = decoded.width;
  const srcHeight = decoded.height;
  const srcChannels = decoded.channels || 3; // RGB or RGBA
  
  const hashWidth = 9;
  const hashHeight = 8;
  const scaledPixels = new Uint8Array(hashWidth * hashHeight * 3);
  
  const xRatio = (srcWidth - 1) / (hashWidth - 1);
  const yRatio = (srcHeight - 1) / (hashHeight - 1);
  
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth; x++) {
      const srcX = x * xRatio;
      const srcY = y * yRatio;
      
      const x1 = Math.floor(srcX);
      const y1 = Math.floor(srcY);
      const x2 = Math.min(x1 + 1, srcWidth - 1);
      const y2 = Math.min(y1 + 1, srcHeight - 1);
      
      const xWeight = srcX - x1;
      const yWeight = srcY - y1;
      
      for (let c = 0; c < 3; c++) {
        const p11 = srcData[(y1 * srcWidth + x1) * srcChannels + c];
        const p21 = srcData[(y1 * srcWidth + x2) * srcChannels + c];
        const p12 = srcData[(y2 * srcWidth + x1) * srcChannels + c];
        const p22 = srcData[(y2 * srcWidth + x2) * srcChannels + c];
        
        // Match iOS two-step bilinear interpolation
        const top = p11 * (1.0 - xWeight) + p21 * xWeight;
        const bottom = p12 * (1.0 - xWeight) + p22 * xWeight;
        const value = top * (1.0 - yWeight) + bottom * yWeight;
        
        scaledPixels[(y * hashWidth + x) * 3 + c] = Math.round(value);
      }
    }
  }
  
  const grayValues = new Uint8Array(hashWidth * hashHeight);
  for (let i = 0; i < hashWidth * hashHeight; i++) {
    const r = scaledPixels[i * 3];
    const g = scaledPixels[i * 3 + 1];
    const b = scaledPixels[i * 3 + 2];
    grayValues[i] = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
  }
  
  console.log('Desktop grayscale 9x8 grid:');
  for (let y = 0; y < hashHeight; y++) {
    let row = '';
    for (let x = 0; x < hashWidth; x++) {
      row += grayValues[y * hashWidth + x].toString().padStart(4, ' ');
    }
    console.log(row);
  }
  
  const hashBytes = new Uint8Array(8);
  let bitIndex = 0;
  
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth - 1; x++) {
      if (grayValues[y * hashWidth + x] < grayValues[y * hashWidth + x + 1]) {
        const byteIndex = Math.floor(bitIndex / 8);
        const bitPos = 7 - (bitIndex % 8);
        hashBytes[byteIndex] |= (1 << bitPos);
      }
      bitIndex++;
    }
  }
  
  let hexHash = '';
  for (let i = 0; i < hashBytes.length; i++) {
    hexHash += hashBytes[i].toString(16).padStart(2, '0');
  }
  
  return hexHash;
}

// Simulated iOS implementation (using sharp to decode, same algorithm as iOS native)
async function computeIOSStyleHash(filePath) {
  const decoded = await decodeImage(filePath);
  
  // Simulate iOS: CGContext with premultipliedLast RGBA
  const srcPixelData = decoded.data;
  const srcWidth = decoded.width;
  const srcHeight = decoded.height;
  const srcBytesPerPixel = decoded.channels || 3; // RGB or RGBA
  
  const hashWidth = 9;
  const hashHeight = 8;
  const scaledPixelData = new Uint8Array(hashWidth * hashHeight * srcBytesPerPixel);
  
  const xRatio = (srcWidth - 1) / (hashWidth - 1);
  const yRatio = (srcHeight - 1) / (hashHeight - 1);
  
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth; x++) {
      const srcX = x * xRatio;
      const srcY = y * yRatio;
      
      const x1 = Math.floor(srcX);
      const y1 = Math.floor(srcY);
      const x2 = Math.min(x1 + 1, srcWidth - 1);
      const y2 = Math.min(y1 + 1, srcHeight - 1);
      
      const xWeight = srcX - x1;
      const yWeight = srcY - y1;
      
      for (let c = 0; c < 3; c++) {
        const p11 = srcPixelData[(y1 * srcWidth + x1) * srcBytesPerPixel + c];
        const p21 = srcPixelData[(y1 * srcWidth + x2) * srcBytesPerPixel + c];
        const p12 = srcPixelData[(y2 * srcWidth + x1) * srcBytesPerPixel + c];
        const p22 = srcPixelData[(y2 * srcWidth + x2) * srcBytesPerPixel + c];
        
        // iOS style: two-step interpolation
        const top = p11 * (1.0 - xWeight) + p21 * xWeight;
        const bottom = p12 * (1.0 - xWeight) + p22 * xWeight;
        const value = top * (1.0 - yWeight) + bottom * yWeight;
        
        // iOS rounding: UInt8(value + 0.5)
        scaledPixelData[(y * hashWidth + x) * srcBytesPerPixel + c] = Math.floor(value + 0.5);
      }
      scaledPixelData[(y * hashWidth + x) * srcBytesPerPixel + 3] = 255;
    }
  }
  
  const pixelData = scaledPixelData;
  const grayValues = new Array(hashHeight).fill(0).map(() => new Array(hashWidth).fill(0));
  
  const bytesPerPixel = 4;
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth; x++) {
      const offset = (y * hashWidth + x) * bytesPerPixel;
      const r = pixelData[offset];
      const g = pixelData[offset + 1];
      const b = pixelData[offset + 2];
      const gray = Math.floor((r * 299 + g * 587 + b * 114) / 1000);
      grayValues[y][x] = gray;
    }
  }
  
  console.log('\niOS-style grayscale 9x8 grid:');
  for (let y = 0; y < hashHeight; y++) {
    let row = '';
    for (let x = 0; x < hashWidth; x++) {
      row += grayValues[y][x].toString().padStart(4, ' ');
    }
    console.log(row);
  }
  
  const hashBytes = new Uint8Array(8);
  let bitIndex = 0;
  
  for (let y = 0; y < hashHeight; y++) {
    for (let x = 0; x < hashWidth - 1; x++) {
      if (grayValues[y][x] < grayValues[y][x + 1]) {
        const byteIndex = Math.floor(bitIndex / 8);
        const bitPos = 7 - (bitIndex % 8);
        hashBytes[byteIndex] |= (1 << bitPos);
      }
      bitIndex++;
    }
  }
  
  let hexString = '';
  for (let i = 0; i < hashBytes.length; i++) {
    hexString += hashBytes[i].toString(16).padStart(2, '0');
  }
  
  return hexString;
}

function hammingDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return -1;
  
  let dist = 0;
  for (let i = 0; i < hash1.length; i += 2) {
    const valA = parseInt(hash1.substr(i, 2), 16);
    const valB = parseInt(hash2.substr(i, 2), 16);
    let x = valA ^ valB;
    while (x) {
      dist += x & 1;
      x >>>= 1;
    }
  }
  return dist;
}

// Exact copy of manifest structure used on mobile (values generated here for standalone testing)
function buildMobileManifestLikeClient(filePath, { perceptualHash, fileHash }) {
  const stat = fs.statSync(filePath);
  const originalSize = stat?.size || null;
  const creationTime = stat?.birthtime ? stat.birthtime.toISOString() : (stat?.mtime ? stat.mtime.toISOString() : null);

  const manifest = {
    v: 1,
    assetId: filePath,
    filename: path.basename(filePath),
    mediaType: 'photo',
    originalSize,
    creationTime,
    fileHash: fileHash || null,
    perceptualHash: perceptualHash || null,
  };

  return manifest;
}

async function compareTwoFiles(fileA, fileB) {
  console.log('Comparing files (iOS-style duplicate logic)');
  console.log('File A:', fileA);
  console.log('File B:', fileB);
  console.log('='.repeat(80));

  // Compute iOS-style hashes (what device uses for perceptual dedupe)
  const iosHashA = await computeIOSStyleHash(fileA);
  const iosHashB = await computeIOSStyleHash(fileB);

  // Also compute desktop hash for visibility / debugging
  const desktopHashA = await computeDesktopHash(fileA);
  const desktopHashB = await computeDesktopHash(fileB);

  const exactHashA = crypto.createHash('sha256').update(fs.readFileSync(fileA)).digest('hex');
  const exactHashB = crypto.createHash('sha256').update(fs.readFileSync(fileB)).digest('hex');

  const distanceIOS = hammingDistance(iosHashA, iosHashB);
  const matchIOS = distanceIOS === 0;

  console.log('\n--- iOS-style perceptual hash ---');
  console.log('A:', iosHashA);
  console.log('B:', iosHashB);
  console.log('Hamming distance:', distanceIOS, 'bits');
  console.log('Exact match:', matchIOS ? 'YES ✓' : 'NO ✗');
  console.log('Within threshold (6 bits):', distanceIOS <= 6 ? 'YES ✓' : 'NO ✗');

  console.log('\n--- Desktop (legacy) hash ---');
  console.log('A:', desktopHashA);
  console.log('B:', desktopHashB);
  console.log('Exact match:', desktopHashA === desktopHashB ? 'YES ✓' : 'NO ✗');
  console.log('Hamming distance:', hammingDistance(desktopHashA, desktopHashB), 'bits');

  console.log('\nNote: iOS duplicate detection uses the iOS-style hash above. Desktop hash is shown for comparison only.');

  // Build manifest payloads exactly like mobile client structure (values generated here)
  const manifestA = buildMobileManifestLikeClient(fileA, { perceptualHash: iosHashA, fileHash: exactHashA });
  const manifestB = buildMobileManifestLikeClient(fileB, { perceptualHash: iosHashB, fileHash: exactHashB });

  console.log('\n--- Mobile manifest payload (simulated) for A ---');
  console.log(JSON.stringify(manifestA, null, 2));

  console.log('\n--- Mobile manifest payload (simulated) for B ---');
  console.log(JSON.stringify(manifestB, null, 2));
}

const fileA = process.argv[2] || '/Users/vishyn369/Downloads/8491.heic';
const fileB = process.argv[3] || '/Users/vishyn369/Downloads/7907.heic';

compareTwoFiles(fileA, fileB).catch(e => console.error('Error:', e.message));
