const fs = require('fs');
const heicDecode = require('heic-decode');

// Desktop implementation (current)
async function computeDesktopHash(filePath) {
  const inputBuffer = fs.readFileSync(filePath);
  const decoded = await heicDecode({ buffer: inputBuffer });
  
  const srcData = Buffer.from(decoded.data);
  const srcWidth = decoded.width;
  const srcHeight = decoded.height;
  const srcChannels = 4; // RGBA
  
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

// Simulated iOS implementation (using same heic-decode to isolate algorithm differences)
async function computeIOSStyleHash(filePath) {
  const inputBuffer = fs.readFileSync(filePath);
  const decoded = await heicDecode({ buffer: inputBuffer });
  
  // Simulate iOS: CGContext with premultipliedLast RGBA
  const srcPixelData = decoded.data;
  const srcWidth = decoded.width;
  const srcHeight = decoded.height;
  const srcBytesPerPixel = 4;
  
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

async function test(filePath) {
  console.log('Testing file:', filePath);
  console.log('='.repeat(80));
  
  const desktopHash = await computeDesktopHash(filePath);
  const iosHash = await computeIOSStyleHash(filePath);
  
  console.log('\n' + '='.repeat(80));
  console.log('Desktop hash:', desktopHash);
  console.log('iOS hash:    ', iosHash);
  console.log('Match:       ', desktopHash === iosHash ? 'YES ✓' : 'NO ✗');
  
  if (desktopHash !== iosHash) {
    const distance = hammingDistance(desktopHash, iosHash);
    console.log('Hamming distance:', distance, 'bits');
    console.log('Within threshold (6 bits):', distance <= 6 ? 'YES ✓' : 'NO ✗');
  }
}

const filePath = process.argv[2] || '/Users/vishyn369/Downloads/PHOTOS/IMG_9225.HEIC';
test(filePath).catch(e => console.error('Error:', e.message));
