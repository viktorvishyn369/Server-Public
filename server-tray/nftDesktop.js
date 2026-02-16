// NFT Desktop Module for PhotoLynk Server Tray
// Handles NFT operations for desktop Electron app
// Full implementation matching solana-seeker/nftOperations.js
// Uses @solana/web3.js for blockchain operations

const { shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');

// Sharp for EXIF stripping (optional - best effort)
let sharp = null;
try {
  sharp = require('sharp');
  console.log('[NFT Desktop] sharp loaded for EXIF stripping');
} catch (e) {
  console.log('[NFT Desktop] sharp not available, EXIF stripping will be skipped');
}

/**
 * Strip EXIF metadata from an image for privacy
 * Creates a clean copy without date, location, device info
 * @param {string} filePath - Original file path
 * @returns {string|null} Path to stripped file, or null if stripping failed
 */
async function stripExifFromImage(filePath) {
  try {
    if (!sharp) {
      console.log('[NFT] sharp not available, skipping EXIF strip');
      return null;
    }
    
    if (!filePath || !fs.existsSync(filePath)) {
      console.log('[NFT] File not found for EXIF stripping:', filePath);
      return null;
    }
    
    // Create temp file path
    const ext = path.extname(filePath).toLowerCase();
    const tempPath = path.join(os.tmpdir(), `nft_stripped_${Date.now()}${ext}`);
    
    console.log('[NFT] Stripping EXIF from:', filePath);
    
    // Use sharp to re-encode without EXIF
    // sharp automatically strips EXIF when re-encoding
    const image = sharp(filePath);
    const metadata = await image.metadata();
    
    if (ext === '.png') {
      await image.png().toFile(tempPath);
    } else if (ext === '.webp') {
      await image.webp({ quality: 95 }).toFile(tempPath);
    } else {
      // Default to JPEG for all other formats
      await image.jpeg({ quality: 95 }).toFile(tempPath);
    }
    
    console.log('[NFT] EXIF stripped successfully:', tempPath);
    return tempPath;
  } catch (e) {
    console.warn('[NFT] EXIF stripping failed:', e?.message || e);
    return null;
  }
}

// ============================================================================
// SOLANA IMPORTS (same as mobile)
// ============================================================================

let Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL;
let TransactionMessage, VersionedTransaction, Keypair, TransactionInstruction;
let TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID;
let createInitializeMintInstruction, createAssociatedTokenAccountInstruction;
let createMintToInstruction, getAssociatedTokenAddress;
let solanaAvailable = false;
let splTokenAvailable = false;

try {
  const web3 = require('@solana/web3.js');
  Connection = web3.Connection;
  PublicKey = web3.PublicKey;
  Transaction = web3.Transaction;
  TransactionInstruction = web3.TransactionInstruction;
  SystemProgram = web3.SystemProgram;
  LAMPORTS_PER_SOL = web3.LAMPORTS_PER_SOL;
  TransactionMessage = web3.TransactionMessage;
  VersionedTransaction = web3.VersionedTransaction;
  Keypair = web3.Keypair;
  solanaAvailable = true;
  console.log('[NFT Desktop] @solana/web3.js loaded');
  
  try {
    const splToken = require('@solana/spl-token');
    TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;
    ASSOCIATED_TOKEN_PROGRAM_ID = splToken.ASSOCIATED_TOKEN_PROGRAM_ID;
    createInitializeMintInstruction = splToken.createInitializeMintInstruction;
    createAssociatedTokenAccountInstruction = splToken.createAssociatedTokenAccountInstruction;
    createMintToInstruction = splToken.createMintToInstruction;
    getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
    splTokenAvailable = true;
    console.log('[NFT Desktop] @solana/spl-token loaded');
  } catch (splErr) {
    console.log('[NFT Desktop] @solana/spl-token not available:', splErr.message);
  }
} catch (e) {
  console.log('[NFT Desktop] @solana/web3.js not available:', e.message);
  console.log('[NFT Desktop] Run: npm install @solana/web3.js @solana/spl-token');
}

// Solana connection instance
let connection = null;

function initializeSolana() {
  if (!solanaAvailable) return false;
  if (connection) return true;
  try {
    connection = new Connection(SOLANA_RPC_ENDPOINTS[0], 'confirmed');
    console.log('[NFT Desktop] Solana connection initialized');
    return true;
  } catch (e) {
    console.error('[NFT Desktop] Failed to initialize Solana:', e.message);
    return false;
  }
}

// ============================================================================
// CONFIGURATION (matches solana-seeker/nftOperations.js)
// ============================================================================

// Solana RPC endpoints with fallbacks (mainnet-beta for production)
const SOLANA_RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://rpc.ankr.com/solana',
];

// App commission wallet (receives NFT minting fees) - same as mobile
const NFT_COMMISSION_WALLET = 'HttTZkUG8xn5A1uJPjRDJqqufdwvHmNQroEGmST8iimU';

// StealthCloud API base URL
const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';

// PhotoLynk shared Merkle Tree for compressed NFTs (same as mobile)
const PHOTOLYNK_MERKLE_TREE = '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS';

// IPFS Gateways for image loading (ordered by reliability)
// ipfs.io follows redirects properly and is most reliable for metadata fetching
const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',           // Most reliable, follows redirects
  'https://gateway.pinata.cloud/ipfs/', // Pinata - where most NFT images are hosted
  'https://dweb.link/ipfs/',
  'https://w3s.link/ipfs/',
];

// cNFT-optimized gateways (ipfs.io is most reliable for metadata)
const CNFT_IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',           // Most reliable, follows redirects
  'https://gateway.pinata.cloud/ipfs/', // Pinata - where most NFT images are hosted
  'https://w3s.link/ipfs/',
  'https://nftstorage.link/ipfs/',
];

// Storage options (matches mobile)
const NFT_STORAGE_OPTIONS = {
  IPFS: 'ipfs',
  STEALTHCLOUD: 'cloud',
};

// Edition types (matches mobile nftOperations.js)
const NFT_EDITION = {
  OPEN: 'open',
  LIMITED: 'limited',
};

// License options (matches mobile)
const NFT_LICENSE_OPTIONS = [
  { id: 'arr', label: 'All Rights Reserved', short: 'ARR' },
  { id: 'cc-by', label: 'CC BY 4.0', short: 'CC-BY' },
  { id: 'cc-by-sa', label: 'CC BY-SA 4.0', short: 'CC-BY-SA' },
  { id: 'cc-by-nc', label: 'CC BY-NC 4.0', short: 'CC-BY-NC' },
  { id: 'cc0', label: 'Public Domain (CC0)', short: 'CC0' },
  { id: 'commercial', label: 'Commercial License', short: 'Commercial' },
];

// Commission basis points per edition
const EDITION_ROYALTY_BPS = {
  [NFT_EDITION.OPEN]: 250,
  [NFT_EDITION.LIMITED]: 350,
};

// ============================================================================
// PROMOTIONAL PRICING (matches solana-seeker/nftOperations.js exactly)
// ============================================================================

const PROMO_START_DATE = new Date('2026-01-27T00:00:00Z');
const PROMO_DURATION_DAYS = 30;
const PROMO_END_DATE = new Date(PROMO_START_DATE.getTime() + PROMO_DURATION_DAYS * 24 * 60 * 60 * 1000);

function isPromoActive() {
  const now = new Date();
  return now >= PROMO_START_DATE && now < PROMO_END_DATE;
}

function getPromoDaysRemaining() {
  const now = new Date();
  if (now >= PROMO_END_DATE) return 0;
  return Math.ceil((PROMO_END_DATE - now) / (24 * 60 * 60 * 1000));
}

// PROMOTIONAL FEES (first 30 days) - matches mobile exactly
const PROMO_FEES = {
  // Compressed NFT fees (promo) - super cheap!
  APP_COMMISSION_CNFT_IPFS_USD: 0.05,        // cNFT + IPFS
  APP_COMMISSION_CNFT_CLOUD_USD: 0.02,       // cNFT + StealthCloud
  // Standard NFT fees (promo)
  APP_COMMISSION_STANDARD_IPFS_USD: 0.50,    // Standard + IPFS
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.20,   // Standard + StealthCloud
};

// REGULAR FEES (after promotion ends) - matches mobile exactly
const REGULAR_FEES = {
  // Compressed NFT fees (regular)
  APP_COMMISSION_CNFT_IPFS_USD: 0.50,        // cNFT + IPFS
  APP_COMMISSION_CNFT_CLOUD_USD: 0.20,       // cNFT + StealthCloud
  // Standard NFT fees (regular)
  APP_COMMISSION_STANDARD_IPFS_USD: 1.00,    // Standard + IPFS
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.50,   // Standard + StealthCloud
};

function getCurrentFees() {
  return isPromoActive() ? PROMO_FEES : REGULAR_FEES;
}

// ============================================================================
// NFT IMAGE CACHE
// ============================================================================

let nftImageCache = new Map();      // CID -> local file path
let metadataToImageCache = new Map(); // metadata CID -> image CID (for fast lookup)
let cacheDir = null;

function initCache(appDataPath) {
  cacheDir = path.join(appDataPath, 'nft_cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  // Load cache index
  const indexPath = path.join(cacheDir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      nftImageCache = new Map(Object.entries(data));
      console.log('[NFT Cache] Loaded', nftImageCache.size, 'cached images');
    } catch (e) {
      console.log('[NFT Cache] Failed to load index:', e.message);
    }
  }
  
  // Load metadata-to-image mapping (allows skipping metadata fetch on restart)
  const metaIndexPath = path.join(cacheDir, 'meta_index.json');
  if (fs.existsSync(metaIndexPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(metaIndexPath, 'utf8'));
      metadataToImageCache = new Map(Object.entries(data));
      console.log('[NFT Cache] Loaded', metadataToImageCache.size, 'metadata mappings');
    } catch (e) {
      console.log('[NFT Cache] Failed to load meta index:', e.message);
    }
  }
}

function saveCacheIndex() {
  if (!cacheDir) return;
  const indexPath = path.join(cacheDir, 'index.json');
  try {
    const data = Object.fromEntries(nftImageCache);
    fs.writeFileSync(indexPath, JSON.stringify(data));
  } catch (e) {
    console.log('[NFT Cache] Failed to save index:', e.message);
  }
}

function saveMetaIndex() {
  if (!cacheDir) return;
  const metaIndexPath = path.join(cacheDir, 'meta_index.json');
  try {
    const data = Object.fromEntries(metadataToImageCache);
    fs.writeFileSync(metaIndexPath, JSON.stringify(data));
  } catch (e) {
    console.log('[NFT Cache] Failed to save meta index:', e.message);
  }
}

function clearCache() {
  if (!cacheDir) return;
  
  console.log('[NFT Cache] Clearing all cached images and mappings...');
  
  // Clear in-memory caches
  nftImageCache.clear();
  metadataToImageCache.clear();
  
  // Delete cache files
  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      fs.unlinkSync(filePath);
    }
    console.log('[NFT Cache] Deleted', files.length, 'cached files');
  } catch (e) {
    console.log('[NFT Cache] Failed to clear cache files:', e.message);
  }
}

function cacheMetadataMapping(metadataCid, imageCid) {
  if (metadataCid && imageCid) {
    metadataToImageCache.set(metadataCid, imageCid);
    saveMetaIndex();
  }
}

function getCachedImageCidFromMetadata(metadataCid) {
  return metadataToImageCache.get(metadataCid) || null;
}

function extractIPFSCid(url) {
  if (!url) return null;
  const match = url.match(/(?:^ipfs:\/\/|\/ipfs\/)([a-zA-Z0-9]+)/i);
  return match ? match[1] : null;
}

function getCachedImagePath(cid) {
  if (!cid || !cacheDir) return null;
  if (nftImageCache.has(cid)) {
    const cachedPath = nftImageCache.get(cid);
    if (fs.existsSync(cachedPath)) {
      return cachedPath;
    }
    nftImageCache.delete(cid);
  }
  return null;
}

async function cacheImage(url, cid) {
  if (!cid || !cacheDir) return null;
  
  const cachedPath = path.join(cacheDir, `${cid}.jpg`);
  if (fs.existsSync(cachedPath)) {
    nftImageCache.set(cid, cachedPath);
    saveCacheIndex();
    return cachedPath;
  }
  
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(cachedPath);
    
    protocol.get(url, { timeout: 30000 }, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          nftImageCache.set(cid, cachedPath);
          saveCacheIndex();
          resolve(cachedPath);
        });
      } else {
        file.close();
        fs.unlinkSync(cachedPath);
        resolve(null);
      }
    }).on('error', () => {
      file.close();
      if (fs.existsSync(cachedPath)) fs.unlinkSync(cachedPath);
      resolve(null);
    });
  });
}

// ============================================================================
// SOL PRICE
// ============================================================================

let cachedSolPrice = null;
let solPriceLastFetch = 0;
const SOL_PRICE_CACHE_MS = 15000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    try {
      https.get(url, {
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function getSolPrice() {
  const now = Date.now();
  if (cachedSolPrice && (now - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }

  const apis = [
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', extract: (d) => d?.solana?.usd },
    { url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', extract: (d) => parseFloat(d?.price) },
    { url: 'https://api.coincap.io/v2/assets/solana', extract: (d) => parseFloat(d?.data?.priceUsd) },
    { url: 'https://price.jup.ag/v4/price?ids=SOL', extract: (d) => d?.data?.SOL?.price },
  ];

  for (const api of apis) {
    try {
      const json = await fetchJson(api.url);
      const price = Number(api.extract(json));
      if (Number.isFinite(price) && price > 0) {
        cachedSolPrice = price;
        solPriceLastFetch = now;
        return cachedSolPrice;
      }
    } catch (e) {
      continue;
    }
  }

  const fallback = (cachedSolPrice && cachedSolPrice > 0) ? cachedSolPrice : 150;
  cachedSolPrice = fallback;
  solPriceLastFetch = now;
  return cachedSolPrice;
}

function usdToSol(usdAmount, solPrice) {
  return usdAmount / solPrice;
}

async function rpcRequest(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] });
  for (const endpoint of SOLANA_RPC_ENDPOINTS) {
    try {
      const url = new URL(endpoint);
      const protocol = url.protocol === 'https:' ? https : http;
      const result = await new Promise((resolve, reject) => {
        const req = protocol.request({
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + (url.search || ''),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json && json.error) return reject(new Error(json.error.message || 'RPC error'));
              resolve(json.result);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('RPC timeout')); });
        req.write(payload);
        req.end();
      });
      return result;
    } catch (e) {
      continue;
    }
  }
  throw new Error('All Solana RPC endpoints failed');
}

async function getRentExemptLamports(accountSize) {
  const res = await rpcRequest('getMinimumBalanceForRentExemption', [accountSize]);
  return typeof res === 'number' ? res : 0;
}

async function getRecentPriorityMicroLamports() {
  const res = await rpcRequest('getRecentPrioritizationFees', []);
  if (!Array.isArray(res) || res.length === 0) return 0;
  const vals = res
    .map((r) => Number(r?.prioritizationFee))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  return vals[Math.floor(vals.length / 2)];
}

async function estimateNftCostsRealtime({ nftType, storageOption, fileSizeBytes }) {
  const fees = getCurrentFees();
  const solPrice = await getSolPrice();
  const isCompressed = nftType === 'compressed';
  const useCloud = storageOption === 'cloud';

  const feeUsd = isCompressed
    ? (useCloud ? fees.APP_COMMISSION_CNFT_CLOUD_USD : fees.APP_COMMISSION_CNFT_IPFS_USD)
    : (useCloud ? fees.APP_COMMISSION_STANDARD_CLOUD_USD : fees.APP_COMMISSION_STANDARD_IPFS_USD);
  const feeSol = usdToSol(feeUsd, solPrice);

  let rentLamports = 0;
  let baseFeeLamports = 5000;
  let priorityFeeLamports = 0;

  if (!isCompressed) {
    // Match solana-seeker estimate (0.008 rent + 0.012 metaplex ~= 0.02 SOL)
    rentLamports = 20_000_000;
  }

  try {
    const microLamportsPerCu = await getRecentPriorityMicroLamports();
    const cuEstimate = isCompressed ? 80000 : 250000;
    priorityFeeLamports = Math.ceil((microLamportsPerCu * cuEstimate) / 1_000_000);
  } catch (e) {
    priorityFeeLamports = 0;
  }

  // Storage estimate (mobile-style): base + per-KB, for image + metadata
  // Matches solana-seeker/nftOperations.js NFT_FEES.ARWEAVE_UPLOAD_BASE / ARWEAVE_PER_KB
  const ARWEAVE_UPLOAD_BASE_USD = 0.01;
  const ARWEAVE_PER_KB_USD = 0.00001;
  const metadataBytes = 2000;
  const assumedImageBytes = 2 * 1024 * 1024;
  const imageBytes = (Number.isFinite(fileSizeBytes) && fileSizeBytes > 0)
    ? fileSizeBytes
    : (useCloud ? 0 : assumedImageBytes);
  const metadataUsd = (ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD);
  const imageUsd = (ARWEAVE_UPLOAD_BASE_USD + (imageBytes / 1024) * ARWEAVE_PER_KB_USD);
  const storageUsd = useCloud ? metadataUsd : (imageUsd + metadataUsd);
  const networkSol = (rentLamports + baseFeeLamports + priorityFeeLamports) / 1e9;
  const totalSol = feeSol + networkSol + usdToSol(storageUsd, solPrice);
  const totalUsd = totalSol * solPrice;

  return {
    solPrice,
    fee: { usd: feeUsd, sol: feeSol },
    network: {
      rentLamports,
      baseFeeLamports,
      priorityFeeLamports,
      sol: networkSol,
    },
    storage: { usd: storageUsd },
    total: { sol: totalSol, usd: totalUsd },
  };
}

// ============================================================================
// PINATA IPFS UPLOAD (same JWT as mobile app - from nftOperations.js)
// ============================================================================

const PINATA_JWT = '***REMOVED***';

/**
 * Upload file to Pinata IPFS (same as mobile)
 */
async function uploadToPinata(filePath, contentType = 'image/jpeg') {
  return new Promise((resolve) => {
    try {
      const fileData = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
      
      const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
      const footerStr = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(headerStr), fileData, Buffer.from(footerStr)]);
      
      const req = https.request({
        hostname: 'api.pinata.cloud',
        port: 443,
        path: '/pinning/pinFileToIPFS',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PINATA_JWT}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.IpfsHash) {
              console.log('[IPFS] Uploaded:', json.IpfsHash);
              resolve({ success: true, cid: json.IpfsHash, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${json.IpfsHash}` });
            } else {
              resolve({ success: false, error: json.error?.message || 'Upload failed' });
            }
          } catch (e) { resolve({ success: false, error: e.message }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(body);
      req.end();
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

/**
 * Upload JSON metadata to Pinata IPFS
 */
async function uploadMetadataToPinata(metadata) {
  return new Promise((resolve) => {
    try {
      const jsonStr = JSON.stringify(metadata, null, 2);
      const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
      const fileName = `metadata_${Date.now()}.json`;
      
      const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/json\r\n\r\n`;
      const footerStr = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(headerStr), Buffer.from(jsonStr), Buffer.from(footerStr)]);
      
      const req = https.request({
        hostname: 'api.pinata.cloud',
        port: 443,
        path: '/pinning/pinFileToIPFS',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PINATA_JWT}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.IpfsHash) {
              console.log('[IPFS] Metadata uploaded:', json.IpfsHash);
              resolve({ success: true, cid: json.IpfsHash, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${json.IpfsHash}` });
            } else { resolve({ success: false, error: 'Metadata upload failed' }); }
          } catch (e) { resolve({ success: false, error: e.message }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.write(body);
      req.end();
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

/**
 * Upload image to StealthCloud NFT storage
 */
async function uploadToStealthCloud(filePath, credentials) {
  return new Promise((resolve) => {
    console.log('[StealthCloud] Upload attempt - baseUrl:', credentials?.baseUrl, 'token:', credentials?.token ? 'present' : 'MISSING');
    if (!credentials?.baseUrl || !credentials?.token) {
      console.log('[StealthCloud] Not authenticated - falling back to IPFS');
      resolve({ success: false, error: 'Not authenticated' });
      return;
    }
    const authHeader = String(credentials.token || '').startsWith('Bearer ') ? String(credentials.token) : `Bearer ${String(credentials.token)}`;
    try {
      const fileData = fs.readFileSync(filePath);
      const fileName = `nft_${Date.now()}.jpg`;
      const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
      
      const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`;
      const footerStr = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(headerStr), fileData, Buffer.from(footerStr)]);
      
      const url = new URL(credentials.baseUrl);
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: '/api/nft/upload',
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'X-Device-UUID': credentials.deviceUuid || '',
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 60000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.success) {
              const imageUrl = `${credentials.baseUrl}${json.fallbackUrl}`;
              console.log('[StealthCloud] Uploaded:', imageUrl);
              resolve({ success: true, imageUrl, imageId: json.imageId });
            } else { resolve({ success: false, error: json.error || 'Upload failed' }); }
          } catch (e) { resolve({ success: false, error: e.message }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.write(body);
      req.end();
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

/**
 * Compute deterministic SHA256 hash of EXIF metadata (matches mobile)
 */
function computeExifHash(exifData) {
  if (!exifData) return null;
  try {
    const sorted = {};
    for (const key of Object.keys(exifData).sort()) {
      if (exifData[key] != null) sorted[key] = exifData[key];
    }
    const json = JSON.stringify(sorted);
    return crypto.createHash('sha256').update(json).digest('hex');
  } catch (e) {
    console.warn('[NFT] EXIF hash failed:', e?.message);
    return null;
  }
}

/**
 * Generate optimized preview for Open Edition using sharp
 */
async function generateOptimizedPreview(filePath) {
  if (!sharp) return { success: false, error: 'sharp not available' };
  try {
    const tempPath = path.join(os.tmpdir(), `nft_preview_${Date.now()}.jpg`);
    await sharp(filePath).resize(1200, null, { withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(tempPath);
    return { success: true, previewPath: tempPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Generate high-quality thumbnail for Limited Edition using sharp
 */
async function generateLimitedEditionThumb(filePath) {
  if (!sharp) return { success: false, error: 'sharp not available' };
  try {
    const tempPath = path.join(os.tmpdir(), `nft_limited_${Date.now()}.jpg`);
    await sharp(filePath).resize(1600, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(tempPath);
    return { success: true, thumbPath: tempPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Apply watermark (quality reduction + metadata flag, matches mobile)
 */
async function burnWatermark(filePath) {
  if (!sharp) return { success: false, error: 'sharp not available' };
  try {
    const tempPath = path.join(os.tmpdir(), `nft_wm_${Date.now()}.jpg`);
    await sharp(filePath).jpeg({ quality: 60 }).toFile(tempPath);
    return { success: true, watermarkedPath: tempPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Encrypt an image file using NaCl secretbox (matches mobile encryptNFTImage)
 * @param {string} filePath - Path to image
 * @param {Buffer|Uint8Array} masterKey - 32-byte master key
 */
async function encryptNFTImage(filePath, masterKey) {
  try {
    let nacl;
    try { nacl = require('tweetnacl'); } catch (_) {
      return { success: false, error: 'tweetnacl not available' };
    }
    const plaintext = fs.readFileSync(filePath);
    const nftKey = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(24);
    const encrypted = nacl.secretbox(plaintext, nonce, nftKey);
    const wrapNonce = nacl.randomBytes(24);
    const wrappedKey = nacl.secretbox(nftKey, wrapNonce, masterKey);
    const encPath = path.join(os.tmpdir(), `nft_enc_${Date.now()}.bin`);
    fs.writeFileSync(encPath, Buffer.from(encrypted));
    return {
      success: true,
      encryptedPath: encPath,
      wrappedKey: Buffer.from(wrappedKey).toString('base64'),
      wrapNonce: Buffer.from(wrapNonce).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      originalSize: plaintext.length,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Decrypt an encrypted NFT image (matches mobile decryptNFTImage)
 */
async function decryptNFTImage(encryptedPath, wrappedKeyB64, wrapNonceB64, nonceB64, masterKey) {
  try {
    let nacl;
    try { nacl = require('tweetnacl'); } catch (_) {
      return { success: false, error: 'tweetnacl not available' };
    }
    const wrappedKey = Buffer.from(wrappedKeyB64, 'base64');
    const wrapNonce = Buffer.from(wrapNonceB64, 'base64');
    const nftKey = nacl.secretbox.open(wrappedKey, wrapNonce, masterKey);
    if (!nftKey) return { success: false, error: 'Key unwrap failed' };
    const encData = fs.readFileSync(encryptedPath);
    const nonce = Buffer.from(nonceB64, 'base64');
    const plaintext = nacl.secretbox.open(new Uint8Array(encData), nonce, nftKey);
    if (!plaintext) return { success: false, error: 'Decryption failed' };
    const decPath = path.join(os.tmpdir(), `nft_dec_${Date.now()}.jpg`);
    fs.writeFileSync(decPath, Buffer.from(plaintext));
    return { success: true, decryptedPath: decPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Build NFT metadata with edition support (matches mobile buildNFTMetadata)
 */
function buildNFTMetadata({
  name, description, imageUrl, ownerAddress, contentHash, fileSize,
  edition = NFT_EDITION.OPEN, license = 'arr', watermarked = false, encrypted = false,
  exifHash = null, cameraSerialHash = null, originalFormat = null, originalResolution = null,
  creatorAddress = null,
}) {
  const isLimited = edition === NFT_EDITION.LIMITED;
  const editionLabel = isLimited ? 'Limited' : 'Open';
  const bps = EDITION_ROYALTY_BPS[edition] || 500;
  const licenseEntry = NFT_LICENSE_OPTIONS.find(l => l.id === license);
  const licenseLabel = licenseEntry ? licenseEntry.label : 'All Rights Reserved';
  const defaultDesc = isLimited
    ? 'Limited Edition — copyright certificate with proof of ownership'
    : 'Open Edition — photo NFT with on-chain integrity proof';

  const metadata = {
    name: name || 'PhotoLynk Photo NFT',
    symbol: 'PLNK',
    description: description || defaultDesc,
    image: imageUrl,
    external_url: 'https://stealthlynk.io',
    attributes: [
      { trait_type: 'Edition', value: editionLabel },
      ...(contentHash ? [{ trait_type: 'Content Hash', value: `SHA256:${contentHash}` }] : []),
      ...(exifHash ? [{ trait_type: 'EXIF Hash', value: `SHA256:${exifHash}` }] : []),
      ...(cameraSerialHash ? [{ trait_type: 'Camera Hash', value: `SHA256:${cameraSerialHash}` }] : []),
      ...(fileSize ? [{ trait_type: 'Original Size', value: `${fileSize} bytes` }] : []),
      ...(originalFormat ? [{ trait_type: 'Original Format', value: originalFormat }] : []),
      ...(originalResolution ? [{ trait_type: 'Resolution', value: originalResolution }] : []),
      { trait_type: 'License', value: licenseLabel },
      { trait_type: 'Watermarked', value: watermarked ? 'true' : 'false' },
      { trait_type: 'Encrypted', value: encrypted ? 'true' : 'false' },
      ...(isLimited ? [{ trait_type: 'Original Storage', value: 'Creator Device Only' }] : []),
      { trait_type: 'Proof Type', value: isLimited ? 'Copyright Certificate' : 'Photo Ownership' },
      { trait_type: 'Minted With', value: 'PhotoLynk' },
      { trait_type: 'Platform', value: 'PhotoLynk Desktop' },
    ],
    properties: {
      category: 'image',
      files: [{ uri: imageUrl, type: encrypted ? 'application/octet-stream' : 'image/jpeg' }],
      creators: [{ address: creatorAddress || ownerAddress, share: 100 }],
      ...(encrypted ? { encryption: { method: 'NaCl-secretbox', encrypted: true } } : {}),
      ...(isLimited ? {
        certificate: {
          version: 1,
          type: 'PhotoLynk Certificate of Authenticity',
          edition: 'Limited',
          originalHash: contentHash ? `SHA256:${contentHash}` : null,
          exifHash: exifHash ? `SHA256:${exifHash}` : null,
          cameraSerialHash: cameraSerialHash ? `SHA256:${cameraSerialHash}` : null,
          originalFormat: originalFormat || null,
          originalResolution: originalResolution || null,
          originalSizeBytes: fileSize || null,
          creatorWallet: creatorAddress || ownerAddress,
          license: licenseLabel,
          watermarked,
          originalStorageMode: 'creator_device_only',
        },
      } : {}),
    },
    seller_fee_basis_points: bps,
  };
  return metadata;
}

/**
 * Compute SHA256 hash of file for integrity proof
 */
function computeContentHash(filePath) {
  try {
    const fileData = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileData).digest('hex');
  } catch (e) {
    console.error('[NFT] Hash computation failed:', e.message);
    return null;
  }
}

/**
 * Mint NFT - uploads image/metadata and opens wallet for payment
 * @param {Object} params - { nftType, storageOption, filePath, name, description, walletAddress, credentials }
 * @param {Function} onProgress - Progress callback
 * @returns {Object} { success, txSignature, mintAddress, error }
 */
async function mintNFT(params, onProgress) {
  const {
    nftType, storageOption, filePath, name, description, walletAddress, credentials, stripExif,
    // Edition parameters (matches mobile)
    edition = NFT_EDITION.OPEN,
    license = 'arr',
    watermark = false,
    encrypt = false,
    masterKey = null,
  } = params;
  
  const isLimited = edition === NFT_EDITION.LIMITED;
  console.log('[NFT] Edition:', isLimited ? 'Limited' : 'Open', '| License:', license, '| Watermark:', watermark, '| Encrypt:', encrypt);
  
  if (encrypt && !masterKey) {
    return { success: false, error: 'Master key required for encryption' };
  }
  
  try {
    onProgress?.({ status: 'Preparing...' });
    
    // Validate file
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Image file not found' };
    }
    
    // Handle EXIF stripping if requested
    let uploadFilePath = filePath;
    let cleanupTempFiles = [];
    
    if (stripExif) {
      onProgress?.({ status: 'Removing private data...' });
      try {
        const strippedPath = await stripExifFromImage(filePath);
        if (strippedPath) {
          uploadFilePath = strippedPath;
          cleanupTempFiles.push(strippedPath);
          console.log('[NFT] Using EXIF-stripped image:', strippedPath);
        }
      } catch (stripErr) {
        console.warn('[NFT] EXIF stripping failed, using original:', stripErr?.message);
      }
    }
    
    const fileSize = fs.statSync(uploadFilePath).size;
    
    // Extract EXIF data from image, then compute hash
    let exifHash = null;
    try {
      if (sharp) {
        const imgMeta = await sharp(filePath).metadata();
        // Build EXIF-like object from sharp metadata (matches mobile extractExifForNFT fields)
        const exifData = {};
        if (imgMeta.width) exifData.ImageWidth = imgMeta.width;
        if (imgMeta.height) exifData.ImageHeight = imgMeta.height;
        if (imgMeta.format) exifData.Format = imgMeta.format;
        if (imgMeta.space) exifData.ColorSpace = imgMeta.space;
        if (imgMeta.density) exifData.DPI = imgMeta.density;
        if (imgMeta.hasAlpha !== undefined) exifData.HasAlpha = imgMeta.hasAlpha;
        if (imgMeta.orientation) exifData.Orientation = imgMeta.orientation;
        // Extract raw EXIF buffer if present
        if (imgMeta.exif) {
          try {
            const exifParser = require('exif-reader');
            const parsed = exifParser(imgMeta.exif);
            if (parsed?.image) Object.assign(exifData, parsed.image);
            if (parsed?.exif) Object.assign(exifData, parsed.exif);
            if (parsed?.gps) exifData.GPS = parsed.gps;
          } catch (_) {
            // exif-reader not available or parse failed — use sharp metadata only
          }
        }
        if (Object.keys(exifData).length > 0) {
          exifHash = computeExifHash(exifData);
        }
      }
    } catch (exifErr) {
      console.warn('[NFT] EXIF extraction failed:', exifErr?.message);
    }
    
    // Step 1: Compute content hash of ORIGINAL file for integrity proof
    onProgress?.({ status: 'Computing integrity proof...' });
    const contentHash = computeContentHash(filePath);
    
    // ========== EDITION-SPECIFIC IMAGE PROCESSING ==========
    let imageToUploadPath = uploadFilePath;
    let encryptionData = null;
    
    if (isLimited) {
      // LIMITED EDITION: Generate high-quality thumbnail — original stays on device
      onProgress?.({ status: 'Creating certificate image...' });
      const thumbResult = await generateLimitedEditionThumb(uploadFilePath);
      if (thumbResult.success) {
        imageToUploadPath = thumbResult.thumbPath;
        cleanupTempFiles.push(thumbResult.thumbPath);
      }
    } else {
      // OPEN EDITION: Generate optimized preview (1200px)
      onProgress?.({ status: 'Creating preview...' });
      const previewResult = await generateOptimizedPreview(uploadFilePath);
      if (previewResult.success) {
        imageToUploadPath = previewResult.previewPath;
        cleanupTempFiles.push(previewResult.previewPath);
      }
    }
    
    // Apply watermark if requested
    if (watermark) {
      onProgress?.({ status: 'Applying watermark...' });
      const wmResult = await burnWatermark(imageToUploadPath);
      if (wmResult.success) {
        cleanupTempFiles.push(wmResult.watermarkedPath);
        imageToUploadPath = wmResult.watermarkedPath;
      }
    }
    
    // Encrypt image if requested
    if (encrypt && masterKey) {
      onProgress?.({ status: 'Encrypting image...' });
      const encResult = await encryptNFTImage(imageToUploadPath, masterKey);
      if (encResult.success) {
        imageToUploadPath = encResult.encryptedPath;
        cleanupTempFiles.push(encResult.encryptedPath);
        encryptionData = {
          wrappedKey: encResult.wrappedKey,
          wrapNonce: encResult.wrapNonce,
          nonce: encResult.nonce,
          originalSize: encResult.originalSize,
        };
        console.log('[NFT] Image encrypted for upload');
      } else {
        console.warn('[NFT] Encryption failed, uploading unencrypted:', encResult.error);
      }
    }
    
    // Step 2: Upload image
    onProgress?.({ status: 'Uploading image...' });
    const uploadContentType = (encrypt && encryptionData) ? 'application/octet-stream' : 'image/jpeg';
    console.log('[NFT] Storage option:', storageOption, 'ContentType:', uploadContentType);
    let imageUpload;
    if (storageOption === 'cloud' && credentials && credentials.baseUrl && credentials.token) {
      console.log('[NFT] Using StealthCloud storage');
      imageUpload = await uploadToStealthCloud(imageToUploadPath, credentials);
      // If StealthCloud fails, fall back to IPFS
      if (!imageUpload.success) {
        console.log('[NFT] StealthCloud failed, falling back to IPFS:', imageUpload.error);
        imageUpload = await uploadToPinata(imageToUploadPath, uploadContentType);
      }
    } else {
      console.log('[NFT] Using IPFS storage (Pinata)');
      imageUpload = await uploadToPinata(imageToUploadPath, uploadContentType);
    }
    
    // Clean up temp files (best-effort)
    for (const tmp of cleanupTempFiles) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
    
    if (!imageUpload.success) {
      return { success: false, error: 'Image upload failed: ' + imageUpload.error };
    }
    
    const imageUrl = imageUpload.imageUrl || imageUpload.gatewayUrl;
    console.log('[NFT] Image uploaded:', imageUrl);
    
    // Step 3: Build and upload metadata with edition support
    onProgress?.({ status: 'Uploading metadata...' });
    const metadata = buildNFTMetadata({
      name: name || 'NFT Memories',
      description,
      imageUrl,
      ownerAddress: walletAddress,
      creatorAddress: walletAddress,
      contentHash,
      fileSize,
      edition,
      license,
      watermarked: watermark,
      encrypted: !!(encrypt && encryptionData),
      exifHash,
    });
    
    const metadataUpload = await uploadMetadataToPinata(metadata);
    if (!metadataUpload.success) {
      return { success: false, error: 'Metadata upload failed: ' + metadataUpload.error };
    }
    
    console.log('[NFT] Metadata uploaded:', metadataUpload.gatewayUrl);
    
    // Step 4: Calculate fee and open wallet for payment
    onProgress?.({ status: 'Opening wallet...' });
    const fees = getCurrentFees();
    let feeUsd;
    if (nftType === 'compressed') {
      feeUsd = storageOption === 'cloud' ? fees.APP_COMMISSION_CNFT_CLOUD_USD : fees.APP_COMMISSION_CNFT_IPFS_USD;
    } else {
      feeUsd = storageOption === 'cloud' ? fees.APP_COMMISSION_STANDARD_CLOUD_USD : fees.APP_COMMISSION_STANDARD_IPFS_USD;
    }
    
    const solPrice = await getSolPrice();
    const feeSol = usdToSol(feeUsd, solPrice);
    const feeLamports = Math.ceil(feeSol * 1e9);

    // Estimated total (mobile-style fallback): fee + on-chain + (optional) IPFS upload
    const STANDARD_ONCHAIN_USD = 2.60;
    const CNFT_ONCHAIN_USD = 0.001;
    const IPFS_STORAGE_USD = 0.03;
    const estimatedTotalUsd = nftType === 'compressed'
      ? (storageOption === 'cloud'
          ? (feeUsd + CNFT_ONCHAIN_USD)
          : (feeUsd + CNFT_ONCHAIN_USD + IPFS_STORAGE_USD))
      : (storageOption === 'cloud'
          ? (feeUsd + STANDARD_ONCHAIN_USD)
          : (feeUsd + STANDARD_ONCHAIN_USD + IPFS_STORAGE_USD));
    const estimatedTotalSol = usdToSol(estimatedTotalUsd, solPrice);
    
    console.log('[NFT] Fee:', feeUsd, 'USD =', feeSol.toFixed(6), 'SOL =', feeLamports, 'lamports');
    
    // Generate unique reference for this mint
    const reference = crypto.randomBytes(32).toString('base64url');
    
    // Open local payment page in browser (where Phantom extension is installed)
    // This page will handle wallet connection and SOL transfer
    const paymentParams = new URLSearchParams({
      recipient: NFT_COMMISSION_WALLET,
      amount: feeSol.toFixed(9),
      feeUsd: feeUsd.toFixed(2),
      reference: reference,
      name: name || 'NFT Memories',
      imageUrl: imageUrl,
      metadataUrl: metadataUpload.gatewayUrl,
      nftType: nftType,
      storageOption: storageOption,
      fileSizeBytes: String(fileSize),
      solPrice: String(solPrice),
      estimatedTotalUsd: estimatedTotalUsd.toFixed(2),
      estimatedTotalSol: estimatedTotalSol.toFixed(9),
      wallet: walletAddress,
      // Edition params (passed through to mint-success for post-mint save)
      edition: edition,
      license: license,
      watermark: watermark ? 'true' : 'false',
      encrypt: (encrypt && encryptionData) ? 'true' : 'false',
      contentHash: contentHash || '',
      exifHash: exifHash || '',
    }).toString();
    
    // Use local server to serve payment page (Phantom extension needs HTTP, not file://)
    const paymentUrl = `http://localhost:3000/nft-payment?${paymentParams}`;
    
    console.log('[NFT] Opening browser for payment:', paymentUrl);
    shell.openExternal(paymentUrl);
    
    // Return success with pending status - user completes payment in browser with Phantom extension
    return {
      success: true,
      status: 'pending_payment',
      imageUrl,
      metadataUrl: metadataUpload.gatewayUrl,
      nftType,
      feeUsd,
      feeSol,
      reference,
      message: 'Complete payment in browser with Phantom',
    };
  } catch (e) {
    console.error('[NFT] Mint failed:', e);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// FETCH USER NFTs (uses DAS API like mobile app)
// ============================================================================

/**
 * Fetch NFTs from blockchain using DAS API (same as mobile)
 * @param {string} walletAddress - Solana wallet address
 * @param {number} limit - Max NFTs to return (default 9 for 3x3 grid)
 * @returns {Object} { success, nfts, error }
 */
async function fetchUserNFTs(walletAddress, limit = 9) {
  if (!walletAddress) return { success: false, nfts: [], error: 'No wallet address' };
  
  console.log('[NFT] Fetching NFTs for wallet:', walletAddress);
  
  try {
    // Use DAS API to fetch all assets (same as mobile fetchCompressedNFTs)
    const nfts = await fetchNFTsFromDAS(walletAddress, limit);
    console.log('[NFT] Found', nfts.length, 'NFTs');
    return { success: true, nfts };
  } catch (e) {
    console.error('[NFT] Fetch failed:', e.message);
    return { success: false, nfts: [], error: e.message };
  }
}

/**
 * Fetch NFTs using Solana DAS (Digital Asset Standard) API
 * Same implementation as mobile app's fetchCompressedNFTs
 */
async function fetchNFTsFromDAS(walletAddress, limit = 9) {
  // For large limits, use pagination
  const pageSize = Math.min(limit, 1000); // Helius supports up to 1000 per page
  
  const postData = JSON.stringify({
    jsonrpc: '2.0',
    id: 'photolynk-desktop-nft-fetch',
    method: 'getAssetsByOwner',
    params: {
      ownerAddress: walletAddress,
      page: 1,
      limit: pageSize,
    },
  });

  const buildDasUrls = () => {
    const urls = [];
    // Solana public RPC (no key) - preferred when available
    urls.push({ name: 'solana', url: 'https://api.mainnet-beta.solana.com' });

    // Optional providers (only if keys are provided)
    if (process.env.HELIUS_API_KEY) {
      urls.push({ name: 'helius', url: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` });
    }
    if (process.env.SHYFT_API_KEY) {
      urls.push({ name: 'shyft', url: `https://rpc.shyft.to/?api_key=${process.env.SHYFT_API_KEY}` });
    }

    return urls;
  };

  const requestOnce = (endpoint) => new Promise((resolve) => {
    const u = new URL(endpoint.url);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          console.error(`[DAS] ${endpoint.name} HTTP ${res.statusCode}: ${String(data).slice(0, 200)}`);
          resolve({ ok: false, items: [] });
          return;
        }

        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          console.error(`[DAS] ${endpoint.name} non-JSON response: ${String(data).slice(0, 200)}`);
          resolve({ ok: false, items: [] });
          return;
        }

        if (json?.error) {
          console.error(`[DAS] ${endpoint.name} API error: ${JSON.stringify(json.error)}`);
          resolve({ ok: false, items: [] });
          return;
        }

        const items = json?.result?.items;
        if (!Array.isArray(items)) {
          console.error(`[DAS] ${endpoint.name} missing result.items`);
          resolve({ ok: false, items: [] });
          return;
        }

        resolve({ ok: true, items });
      });
    });

    req.on('error', (e) => {
      console.error(`[DAS] ${endpoint.name} request error: ${e.message}`);
      resolve({ ok: false, items: [] });
    });

    req.on('timeout', () => {
      req.destroy();
      console.error(`[DAS] ${endpoint.name} request timeout`);
      resolve({ ok: false, items: [] });
    });

    req.write(postData);
    req.end();
  });

  const endpoints = buildDasUrls();
  let items = [];
  for (const endpoint of endpoints) {
    const result = await requestOnce(endpoint);
    if (result.ok) {
      console.log(`[DAS] Using ${endpoint.name}, total assets:`, result.items.length);
      items = result.items;
      break;
    }
  }

  if (!items.length) {
    return [];
  }

  // Process all NFTs (both compressed and standard)
  const nfts = [];
  for (const item of items) {
    if (nfts.length >= limit) break;

    // Get image URL from content
    let imageUrl = item.content?.links?.image ||
                  item.content?.files?.[0]?.uri ||
                  '';
    const metadataUrl = item.content?.json_uri || '';
    const isCompressed = item.compression?.compressed === true;
    let cachedImagePath = null;
    const metadataCid = extractIPFSCid(metadataUrl);

    // CHECK CACHE FIRST - try to find cached image before any network calls
    // 1. Check cache using image URL CID if available
    let cid = extractIPFSCid(imageUrl);
    if (cid && cacheDir) {
      cachedImagePath = getCachedImagePath(cid);
      if (cachedImagePath) {
        console.log('[NFT Cache] Using cached image for', cid.slice(0, 8));
      }
    }

    // 2. If no image URL but have metadata, check metadata-to-image mapping first
    if (!cachedImagePath && !imageUrl && metadataCid && cacheDir) {
      const cachedImageCid = getCachedImageCidFromMetadata(metadataCid);
      if (cachedImageCid) {
        cachedImagePath = getCachedImagePath(cachedImageCid);
        if (cachedImagePath) {
          cid = cachedImageCid;
          console.log('[NFT Cache] Using cached image via metadata mapping for', cid.slice(0, 8));
        }
      }
    }

    // 3. If still no cached image, fetch from metadata (network call)
    if (!cachedImagePath && !imageUrl && metadataUrl) {
      imageUrl = await fetchImageFromMetadata(metadataUrl, isCompressed);
      cid = extractIPFSCid(imageUrl);
      
      // Cache the metadata-to-image mapping for next time
      if (metadataCid && cid) {
        cacheMetadataMapping(metadataCid, cid);
      }
      
      // Check if this image is already cached
      if (cid && cacheDir) {
        cachedImagePath = getCachedImagePath(cid);
        if (cachedImagePath) {
          console.log('[NFT Cache] Using cached image for', cid.slice(0, 8));
        }
      }
    }

    // Start background caching if not cached yet
    if (!cachedImagePath && cid && cacheDir && imageUrl) {
      cacheImage(imageUrl, cid).catch(() => {});
    }

    nfts.push({
      mintAddress: isCompressed ? `cnft_${item.id}` : item.id,
      assetId: item.id,
      name: item.content?.metadata?.name || 'NFT',
      description: item.content?.metadata?.description || '',
      image: cachedImagePath || imageUrl,  // Use cached path if available
      imageUrl: imageUrl,                   // Keep original URL for fallback
      cachedPath: cachedImagePath,          // Explicit cached path
      metadataUrl: metadataUrl,
      ownerAddress: walletAddress,
      isCompressed: isCompressed,
      merkleTree: item.compression?.tree || null,
      source: 'das',
    });
  }

  console.log('[DAS] Processed', nfts.length, 'NFTs');
  return nfts;
}

/**
 * Fetch URL with redirect following (Node.js http/https doesn't follow redirects)
 */
function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    if (maxRedirects <= 0) {
      resolve({ ok: false, data: '' });
      return;
    }
    
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects (301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        // Handle relative redirects
        if (redirectUrl.startsWith('/')) {
          const urlObj = new URL(url);
          redirectUrl = urlObj.origin + redirectUrl;
        }
        console.log('[NFT] Following redirect to:', redirectUrl.slice(0, 50));
        fetchWithRedirects(redirectUrl, maxRedirects - 1).then(resolve);
        return;
      }
      
      if (res.statusCode !== 200) {
        console.log('[NFT] Gateway returned:', res.statusCode);
        resolve({ ok: false, data: '' });
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: true, data }));
    });
    req.on('error', (e) => { console.log('[NFT] Gateway error:', e.message); resolve({ ok: false, data: '' }); });
    req.on('timeout', () => { req.destroy(); console.log('[NFT] Gateway timeout'); resolve({ ok: false, data: '' }); });
  });
}

/**
 * Fetch image URL from IPFS metadata JSON
 * Uses ipfs.io and pinata gateways with redirect following and 15s timeout
 */
async function fetchImageFromMetadata(metadataUrl, isCompressed = false) {
  if (!metadataUrl) return '';
  
  // Extract CID and try multiple gateways
  const cid = extractIPFSCid(metadataUrl);
  const gatewayList = isCompressed ? CNFT_IPFS_GATEWAYS : IPFS_GATEWAYS;
  const gateways = cid ? gatewayList.map(g => g + cid) : [metadataUrl];
  
  for (const gateway of gateways) {
    try {
      console.log('[NFT] Trying metadata gateway:', gateway.slice(0, 50));
      const result = await fetchWithRedirects(gateway);
      
      if (result.ok && result.data) {
        try {
          const json = JSON.parse(result.data);
          const img = json.image || '';
          if (img) {
            console.log('[NFT] Got image from metadata:', img.slice(0, 60));
            return img;
          }
        } catch (e) {
          // Not valid JSON
        }
      }
    } catch (e) {
      console.log('[NFT] Gateway failed:', e.message);
    }
  }
  
  return '';
}

// ============================================================================
// WALLET CONNECTION (Desktop - manual address input or browser connection)
// ============================================================================

let connectedWallet = null;
let walletWindow = null;

function openWalletConnect(callback) {
  // For desktop, we show a window where user can:
  // 1. Enter wallet address manually (simplest)
  // 2. Open browser to connect via Phantom extension on StealthCloud
  
  if (walletWindow && !walletWindow.isDestroyed()) {
    walletWindow.focus();
    return;
  }
  
  walletWindow = new BrowserWindow({
    width: 420,
    height: 520,
    title: 'Connect Wallet',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });
  
  const html = generateWalletConnectHTML();
  walletWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  
  walletWindow.on('closed', () => {
    walletWindow = null;
  });
}

function generateWalletConnectHTML() {
  const walletConnectPath = path.join(__dirname, 'wallet-connect.html').replace(/\\/g, '/');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Connect Wallet</title>
  <style>
    :root { --bg: #0a0a0a; --card: #1a1a1a; --accent: #9945FF; --accent2: #14F195; --text: #fff; --text-muted: #888; --border: rgba(255,255,255,0.1); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 30px 24px; }
    h1 { font-size: 22px; margin-bottom: 6px; text-align: center; }
    .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 24px; text-align: center; }
    .section { margin-bottom: 20px; }
    .section-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 10px; }
    .input-group { display: flex; gap: 8px; }
    .input { flex: 1; padding: 14px 16px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-size: 13px; font-family: monospace; }
    .input:focus { outline: none; border-color: var(--accent); }
    .input::placeholder { color: var(--text-muted); }
    .btn { padding: 14px 20px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, var(--accent) 0%, #7B3FE4 100%); color: #fff; }
    .btn-primary:hover { box-shadow: 0 4px 16px rgba(153,69,255,0.4); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: var(--card); border: 1px solid var(--border); color: var(--text); display: flex; align-items: center; gap: 10px; width: 100%; justify-content: center; }
    .btn-secondary:hover { border-color: var(--accent); background: rgba(153,69,255,0.1); }
    .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--text-muted); font-size: 12px; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .status { padding: 12px; background: rgba(20,241,149,0.1); border-radius: 8px; font-size: 12px; color: var(--accent2); text-align: center; display: none; }
    .status.error { background: rgba(239,68,68,0.1); color: #EF4444; }
    .info { margin-top: 16px; padding: 12px; background: rgba(153,69,255,0.1); border-radius: 10px; font-size: 11px; color: var(--text-muted); text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>Connect Wallet</h1>
  <p class="subtitle">Connect your Solana wallet for NFT minting</p>
  
  <div class="section">
    <div class="section-title">Enter Wallet Address</div>
    <div class="input-group">
      <input type="text" class="input" id="wallet-input" placeholder="Solana address (e.g., 7xK...abc)">
      <button class="btn btn-primary" onclick="connectManual()">Connect</button>
    </div>
  </div>
  
  <div id="status" class="status"></div>
  
  <div class="divider">or connect via Phantom</div>
  
  <div class="section">
    <button class="btn btn-secondary" onclick="openPhantomConnect()">
      <span style="font-size: 18px;">👻</span>
      Open Phantom in Browser
    </button>
  </div>
  
  <div class="info" style="margin-top: 12px;">
    <strong>Option 1:</strong> Paste your wallet address above<br>
    <strong>Option 2:</strong> Connect via Phantom, copy address, paste here
  </div>
  
  <script>
    const { ipcRenderer, shell } = require('electron');
    
    function connectManual() {
      const address = document.getElementById('wallet-input').value.trim();
      if (!address) {
        showStatus('Please enter a wallet address', true);
        return;
      }
      
      // Basic Solana address validation (base58, 32-44 chars)
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        showStatus('Invalid Solana address format', true);
        return;
      }
      
      showStatus('Wallet connected: ' + address.slice(0,4) + '...' + address.slice(-4), false);
      
      // Send to main process
      ipcRenderer.send('wallet-connected-from-browser', address);
      
      setTimeout(() => window.close(), 1500);
    }
    
    function openPhantomConnect() {
      // Open local server wallet connect page in browser where Phantom extension is installed
      shell.openExternal('http://localhost:3000/wallet-connect');
    }
    
    function showStatus(msg, isError) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status' + (isError ? ' error' : '');
      el.style.display = 'block';
    }
    
    // Allow Enter key to submit
    document.getElementById('wallet-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') connectManual();
    });
  </script>
</body>
</html>`;
}

// ============================================================================
// NFT MINTING WINDOW
// ============================================================================

let mintWindow = null;

function openNFTMintWindow(appDataPath, credentials) {
  if (mintWindow && !mintWindow.isDestroyed()) {
    mintWindow.focus();
    return;
  }
  
  mintWindow = new BrowserWindow({
    width: 480,
    height: 700,
    title: 'NFT Memories',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });
  
  const fees = getCurrentFees();
  const promo = isPromoActive();
  const promoDays = getPromoDaysRemaining();
  
  const html = generateNFTMintHTML(fees, promo, promoDays, credentials);
  mintWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  
  mintWindow.on('closed', () => {
    mintWindow = null;
  });
}

function generateNFTMintHTML(fees, promo, promoDays, credentials) {
  // Calculate TOTAL prices matching mobile exactly (not just fees)
  // Mobile formula: storage + on-chain + app commission
  // Compressed NFT: ~$0 on-chain + commission
  // Standard NFT: ~$2.60 on-chain (rent + metaplex) + commission
  
  // App commission fees
  const cnftCloudFee = fees.APP_COMMISSION_CNFT_CLOUD_USD;
  const cnftIpfsFee = fees.APP_COMMISSION_CNFT_IPFS_USD;
  const nftCloudFee = fees.APP_COMMISSION_STANDARD_CLOUD_USD;
  const nftIpfsFee = fees.APP_COMMISSION_STANDARD_IPFS_USD;

  // On-chain approximations (matches mobile fallback display)
  const STANDARD_ONCHAIN_USD = 2.60;  // ~0.02 SOL rent + metaplex fees
  const CNFT_ONCHAIN_USD = 0.001;     // Near-zero for compressed

  // Storage approximations (mobile-style): base + per-KB, metadata always uploaded
  const ARWEAVE_UPLOAD_BASE_USD = 0.01;
  const ARWEAVE_PER_KB_USD = 0.00001;
  const metadataBytes = 2000;
  const assumedImageBytes = 2 * 1024 * 1024;
  const metadataUsd = (ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD);
  const imageUsdAssumed = (ARWEAVE_UPLOAD_BASE_USD + (assumedImageBytes / 1024) * ARWEAVE_PER_KB_USD);
  const cloudStorageUsd = metadataUsd;
  const ipfsStorageUsd = imageUsdAssumed + metadataUsd;

  // Total prices (commission + on-chain + storage estimate)
  const cnftCloudTotal = cnftCloudFee + CNFT_ONCHAIN_USD + cloudStorageUsd;
  const cnftIpfsTotal = cnftIpfsFee + CNFT_ONCHAIN_USD + ipfsStorageUsd;
  const nftCloudTotal = nftCloudFee + STANDARD_ONCHAIN_USD + cloudStorageUsd;
  const nftIpfsTotal = nftIpfsFee + STANDARD_ONCHAIN_USD + ipfsStorageUsd;
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>NFT Memories</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --card: #1a1a1a;
      --accent: #9945FF;
      --accent2: #14F195;
      --text: #fff;
      --text-muted: #888;
      --border: rgba(255,255,255,0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; overflow: hidden; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .header h1 { font-size: 22px; display: flex; align-items: center; gap: 8px; }
    .header h1 span { font-size: 24px; }
    .close-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); cursor: pointer; font-size: 16px; }
    .close-btn:hover { background: rgba(255,255,255,0.05); }
    
    ${promo ? `.promo-banner { background: linear-gradient(135deg, #9945FF 0%, #14F195 100%); padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; text-align: center; }
    .promo-banner h3 { font-size: 14px; margin-bottom: 4px; }
    .promo-banner p { font-size: 12px; opacity: 0.9; }` : ''}
    
    .section { margin-bottom: 20px; }
    .section-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    
    .card { background: var(--card); border-radius: 14px; padding: 16px; }
    
    .option { display: flex; align-items: center; padding: 12px; border-radius: 10px; border: 1px solid var(--border); margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .option:hover { border-color: var(--accent); }
    .option.selected { border-color: var(--accent); background: rgba(153,69,255,0.1); }
    .option-radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border); margin-right: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .option.selected .option-radio { border-color: var(--accent); }
    .option.selected .option-radio::after { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
    .option-text { flex: 1; }
    .option-title { font-size: 14px; font-weight: 500; }
    .option-subtitle { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .option-price { font-size: 14px; font-weight: 600; color: var(--accent2); }
    
    .photo-select { border: 2px dashed var(--border); border-radius: 14px; padding: 32px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .photo-select:hover { border-color: var(--accent); background: rgba(153,69,255,0.05); }
    .photo-select-icon { font-size: 40px; margin-bottom: 8px; }
    .photo-select-text { font-size: 14px; color: var(--text-muted); }
    
    .photo-preview { display: none; position: relative; }
    .photo-preview img { width: 100%; border-radius: 12px; max-height: 200px; object-fit: cover; }
    .photo-preview-remove { position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,0.7); border: none; color: #fff; cursor: pointer; font-size: 14px; }
    
    .input-group { margin-bottom: 12px; }
    .input-group label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px; }
    .input-group input, .input-group textarea { width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: rgba(0,0,0,0.3); color: var(--text); font-size: 14px; }
    .input-group input:focus, .input-group textarea:focus { outline: none; border-color: var(--accent); }
    .input-group textarea { resize: none; height: 60px; }
    
    .mint-btn { width: 100%; padding: 16px; border: none; border-radius: 12px; background: linear-gradient(135deg, #9945FF 0%, #7B3FE4 100%); color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .mint-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(153,69,255,0.4); }
    .mint-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
    
    .wallet-status { display: flex; align-items: center; gap: 8px; padding: 12px; background: rgba(153,69,255,0.1); border-radius: 10px; margin-bottom: 12px; font-size: 12px; }
    .wallet-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); }
    .wallet-dot.disconnected { background: #f87171; }
    
    .cost-breakdown { margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 10px; font-size: 12px; }
    .cost-row { display: flex; justify-content: space-between; margin-bottom: 4px; color: var(--text-muted); }
    .cost-row.total { color: var(--text); font-weight: 600; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1><span>⬡</span> NFT Memories</h1>
    <button class="close-btn" onclick="window.close()">✕</button>
  </div>
  
  ${promo ? `<div class="promo-banner">
    <h3>🎉 Launch Special - ${promoDays} Days Left!</h3>
    <p>Up to 90% off NFT minting fees!</p>
  </div>` : ''}
  
  <div class="section">
    <div class="section-title">NFT TYPE</div>
    <div class="card">
      <div class="option selected" onclick="selectType('compressed', this)" data-type="compressed">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">Compressed NFT (cNFT)</div>
          <div class="option-subtitle">99.99% cheaper • Same ownership • Recommended</div>
        </div>
        <div class="option-price" id="compressed-price">$${cnftCloudTotal.toFixed(2)}</div>
      </div>
      <div class="option" onclick="selectType('standard', this)" data-type="standard">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">Standard NFT</div>
          <div class="option-subtitle">Traditional • Higher on-chain cost</div>
        </div>
        <div class="option-price" id="standard-price">$${nftCloudTotal.toFixed(2)}</div>
      </div>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">IMAGE STORAGE</div>
    <div class="card">
      <div class="option selected" onclick="selectStorage('cloud', this)" data-storage="cloud">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">StealthCloud</div>
          <div class="option-subtitle" id="cloud-subtitle">Free storage • $${cnftCloudFee.toFixed(2)} fee</div>
        </div>
        <div class="option-price" id="cloud-price">$${cnftCloudTotal.toFixed(2)}</div>
      </div>
      <div class="option" onclick="selectStorage('ipfs', this)" data-storage="ipfs">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">IPFS (Pinata)</div>
          <div class="option-subtitle" id="ipfs-subtitle">Decentralized • $${cnftIpfsFee.toFixed(2)} fee</div>
        </div>
        <div class="option-price" id="ipfs-price">$${cnftIpfsTotal.toFixed(2)}</div>
      </div>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">SELECT PHOTO</div>
    <div class="photo-select" onclick="selectPhoto()">
      <div class="photo-select-icon">📷</div>
      <div class="photo-select-text">Click to select a photo</div>
    </div>
    <div class="photo-preview" id="photo-preview">
      <img id="preview-img" src="">
      <button class="photo-preview-remove" onclick="removePhoto()">✕</button>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">NFT DETAILS</div>
    <div class="card">
      <div class="input-group">
        <label>Name</label>
        <input type="text" id="nft-name" placeholder="My Memory">
      </div>
      <div class="input-group">
        <label>Description (optional)</label>
        <textarea id="nft-description" placeholder="A special moment..."></textarea>
      </div>
      <div class="privacy-toggle" onclick="toggleStripExif()" style="display: flex; align-items: center; padding: 12px 0; cursor: pointer; border-top: 1px solid var(--border); margin-top: 12px;">
        <div style="flex: 1;">
          <div style="font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 14px;">🛡️</span> Remove Private Data
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Strip location, date, device info from image</div>
        </div>
        <div id="strip-toggle" style="width: 44px; height: 24px; border-radius: 12px; background: var(--border); position: relative; transition: all 0.2s;">
          <div id="strip-toggle-knob" style="width: 20px; height: 20px; border-radius: 10px; background: #fff; position: absolute; top: 2px; left: 2px; transition: all 0.2s;"></div>
        </div>
      </div>
    </div>
  </div>
  
  <div class="wallet-status">
    <div class="wallet-dot disconnected" id="wallet-dot"></div>
    <span id="wallet-text">No wallet connected</span>
    <button style="margin-left: auto; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; font-size: 11px;" onclick="connectWallet()">Connect</button>
  </div>
  
  <button class="mint-btn" id="mint-btn" disabled onclick="mintNFT()">
    <span>⬡</span> Mint NFT
  </button>
  
  <script>
    const { ipcRenderer } = require('electron');
    
    const FEES = {
      cnft_cloud: ${cnftCloudFee.toFixed(2)},
      cnft_ipfs: ${cnftIpfsFee.toFixed(2)},
      standard_cloud: ${nftCloudFee.toFixed(2)},
      standard_ipfs: ${nftIpfsFee.toFixed(2)},
    };

    const TOTALS = {
      cnft_cloud: ${cnftCloudTotal.toFixed(2)},
      cnft_ipfs: ${cnftIpfsTotal.toFixed(2)},
      standard_cloud: ${nftCloudTotal.toFixed(2)},
      standard_ipfs: ${nftIpfsTotal.toFixed(2)},
    };
    
    let selectedType = 'compressed';  // 'compressed' or 'standard'
    let selectedStorage = 'cloud';     // 'cloud' or 'ipfs'
    let selectedPhoto = null;
    let walletAddress = null;
    let isMinting = false;
    let stripExif = false;             // Privacy option to remove EXIF metadata
    
    function toggleStripExif() {
      stripExif = !stripExif;
      const toggle = document.getElementById('strip-toggle');
      const knob = document.getElementById('strip-toggle-knob');
      if (stripExif) {
        toggle.style.background = 'var(--accent)';
        knob.style.left = '22px';
      } else {
        toggle.style.background = 'var(--border)';
        knob.style.left = '2px';
      }
    }
    
    function selectType(type, el) {
      selectedType = type;
      el.parentElement.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      updatePrices();
      updateMintButton();
    }
    
    function selectStorage(storage, el) {
      selectedStorage = storage;
      el.parentElement.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      updatePrices();
      updateMintButton();
    }
    
    function updatePrices() {
      // Type card prices are TOTALS and depend on selected storage
      const compressedTotal = selectedStorage === 'cloud' ? TOTALS.cnft_cloud : TOTALS.cnft_ipfs;
      const standardTotal = selectedStorage === 'cloud' ? TOTALS.standard_cloud : TOTALS.standard_ipfs;
      document.getElementById('compressed-price').textContent = '$' + parseFloat(compressedTotal).toFixed(2);
      document.getElementById('standard-price').textContent = '$' + parseFloat(standardTotal).toFixed(2);

      // Storage card prices are TOTALS and depend on selected type
      const cloudTotal = selectedType === 'compressed' ? TOTALS.cnft_cloud : TOTALS.standard_cloud;
      const ipfsTotal = selectedType === 'compressed' ? TOTALS.cnft_ipfs : TOTALS.standard_ipfs;
      document.getElementById('cloud-price').textContent = '$' + parseFloat(cloudTotal).toFixed(2);
      document.getElementById('ipfs-price').textContent = '$' + parseFloat(ipfsTotal).toFixed(2);

      // Subtitles show FEE portion only (matches mobile “$X fee” messaging)
      const cloudFee = selectedType === 'compressed' ? FEES.cnft_cloud : FEES.standard_cloud;
      const ipfsFee = selectedType === 'compressed' ? FEES.cnft_ipfs : FEES.standard_ipfs;
      document.getElementById('cloud-subtitle').textContent = 'Free storage • $' + parseFloat(cloudFee).toFixed(2) + ' fee';
      document.getElementById('ipfs-subtitle').textContent = 'Decentralized • $' + parseFloat(ipfsFee).toFixed(2) + ' fee';
    }
    
    function getCurrentPrice() {
      if (selectedType === 'compressed') {
        return selectedStorage === 'cloud' ? TOTALS.cnft_cloud : TOTALS.cnft_ipfs;
      } else {
        return selectedStorage === 'cloud' ? TOTALS.standard_cloud : TOTALS.standard_ipfs;
      }
    }
    
    async function selectPhoto() {
      const paths = await ipcRenderer.invoke('select-photo-for-nft');
      if (paths && paths.length > 0) {
        selectedPhoto = paths[0];
        document.getElementById('preview-img').src = 'file://' + selectedPhoto;
        document.querySelector('.photo-select').style.display = 'none';
        document.getElementById('photo-preview').style.display = 'block';
        updateMintButton();
      }
    }
    
    function removePhoto() {
      selectedPhoto = null;
      document.querySelector('.photo-select').style.display = 'block';
      document.getElementById('photo-preview').style.display = 'none';
      updateMintButton();
    }
    
    let pollInterval = null;
    
    function connectWallet() {
      // Open browser directly for Phantom connection
      require('electron').shell.openExternal('http://localhost:3000/wallet-connect');
      
      // Update UI to show connecting state
      document.getElementById('wallet-text').textContent = 'Connecting...';
      
      // Start polling for wallet address
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch('http://localhost:3000/wallet-address');
          const data = await res.json();
          if (data.success && data.address) {
            clearInterval(pollInterval);
            pollInterval = null;
            walletAddress = data.address;
            document.getElementById('wallet-dot').classList.remove('disconnected');
            document.getElementById('wallet-text').textContent = data.address.slice(0, 4) + '...' + data.address.slice(-4);
            updateMintButton();
            // Bring this window to front
            if (data.bringToFront) {
              const { remote } = require('electron');
              const win = remote?.getCurrentWindow?.() || require('@electron/remote')?.getCurrentWindow?.();
              if (win) { win.show(); win.focus(); }
            }
          }
        } catch (e) { /* Server not ready yet */ }
      }, 500);
      
      // Stop polling after 2 minutes
      setTimeout(() => {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
          if (!walletAddress) {
            document.getElementById('wallet-text').textContent = 'Connection timed out';
          }
        }
      }, 120000);
    }
    
    ipcRenderer.on('wallet-connected', (e, address) => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      walletAddress = address;
      document.getElementById('wallet-dot').classList.remove('disconnected');
      document.getElementById('wallet-text').textContent = address.slice(0, 4) + '...' + address.slice(-4);
      updateMintButton();
    });
    
    function updateMintButton() {
      const btn = document.getElementById('mint-btn');
      btn.disabled = !selectedPhoto || !walletAddress || isMinting;
      
      if (selectedPhoto && walletAddress && !isMinting) {
        const price = getCurrentPrice();
        btn.innerHTML = '<span>⬡</span> Mint NFT ($' + parseFloat(price).toFixed(2) + ')';
      }
    }
    
    async function mintNFT() {
      if (isMinting) return;
      isMinting = true;
      
      const btn = document.getElementById('mint-btn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Minting...';
      
      const name = document.getElementById('nft-name').value || 'NFT Memories';
      const description = document.getElementById('nft-description').value || '';
      
      try {
        const result = await ipcRenderer.invoke('mint-nft', {
          nftType: selectedType,        // 'compressed' or 'standard'
          storageOption: selectedStorage, // 'cloud' or 'ipfs'
          filePath: selectedPhoto,
          name: name,
          description: description,
          walletAddress: walletAddress,
          stripExif: stripExif,         // Privacy option to remove EXIF metadata
        });
        
        if (result.success) {
          btn.innerHTML = '<span>✓</span> Minted!';
          btn.style.background = 'linear-gradient(135deg, #14F195 0%, #10B981 100%)';
          setTimeout(() => window.close(), 2000);
        } else {
          throw new Error(result.error || 'Minting failed');
        }
      } catch (e) {
        btn.innerHTML = '<span>✕</span> ' + (e.message || 'Failed');
        btn.style.background = 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)';
        setTimeout(() => {
          isMinting = false;
          btn.style.background = '';
          updateMintButton();
        }, 3000);
      }
    }
    
    // Listen for minting progress
    ipcRenderer.on('mint-progress', (e, data) => {
      const btn = document.getElementById('mint-btn');
      btn.innerHTML = '<span>⏳</span> ' + data.status;
    });
  </script>
</body>
</html>`;
}

// ============================================================================
// NFT ALBUM WINDOW
// ============================================================================

let albumWindow = null;

function openNFTAlbumWindow(appDataPath, walletAddress) {
  if (albumWindow && !albumWindow.isDestroyed()) {
    albumWindow.focus();
    return;
  }
  
  albumWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: 'NFT Album',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });
  
  const html = generateNFTAlbumHTML(walletAddress);
  albumWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  
  albumWindow.on('closed', () => {
    albumWindow = null;
  });
}

function generateNFTAlbumHTML(walletAddress) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>NFT Album</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --card: #1a1a1a;
      --accent: #9945FF;
      --text: #fff;
      --text-muted: #888;
      --border: rgba(255,255,255,0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .header h1 { font-size: 22px; display: flex; align-items: center; gap: 8px; }
    .header-actions { display: flex; gap: 8px; }
    .header-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); cursor: pointer; font-size: 14px; }
    .header-btn:hover { background: rgba(255,255,255,0.05); color: var(--accent); border-color: var(--accent); }
    
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .nft-item { aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--card); border: 1px solid var(--border); cursor: pointer; position: relative; transition: all 0.2s; }
    .nft-item:hover { border-color: var(--accent); transform: scale(1.02); }
    .nft-item img { width: 100%; height: 100%; object-fit: cover; }
    .nft-item-overlay { position: absolute; bottom: 0; left: 0; right: 0; padding: 8px; background: linear-gradient(transparent, rgba(0,0,0,0.9)); }
    .nft-item-name { font-size: 10px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    
    .loading { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px; color: var(--text-muted); gap: 12px; }
    .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; transform-origin: center center; box-sizing: border-box; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    
    .empty { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .empty-icon { font-size: 48px; margin-bottom: 16px; }
    .empty-text { font-size: 14px; margin-bottom: 8px; }
    .empty-hint { font-size: 12px; }
    
    .connect-prompt { text-align: center; padding: 40px 20px; }
    .connect-btn { padding: 14px 28px; border: none; border-radius: 10px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .connect-btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🖼️ NFT Album</h1>
    <div class="header-actions">
      <button class="header-btn" onclick="refreshAlbum()" title="Refresh">↻</button>
      <button class="header-btn" onclick="window.close()" title="Close">✕</button>
    </div>
  </div>
  
  <div id="content">
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <span>Loading NFTs...</span>
    </div>
  </div>
  
  <script>
    const { ipcRenderer } = require('electron');
    let walletAddress = '${walletAddress || ''}';
    let nfts = [];
    
    async function loadNFTs() {
      if (!walletAddress) {
        showConnectPrompt();
        return;
      }
      
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading NFTs...</span></div>';
      
      const result = await ipcRenderer.invoke('fetch-user-nfts', walletAddress, 9);
      
      if (result.success && result.nfts.length > 0) {
        nfts = result.nfts;
        renderGrid();
      } else if (result.nfts.length === 0) {
        showEmpty();
      } else {
        document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">Failed to load NFTs</div><div class="empty-hint">' + (result.error || 'Try again later') + '</div></div>';
      }
    }
    
    function renderGrid() {
      let html = '<div class="grid">';
      nfts.forEach((nft, i) => {
        const imgUrl = nft.image || nft.imageUrl || '';
        const name = nft.name || 'NFT #' + (i + 1);
        html += '<div class="nft-item" onclick="openNFT(' + i + ')">';
        html += '<img src="' + imgUrl + '" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%231a1a1a%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23888%22 font-size=%2230%22>⬡</text></svg>\\'">';
        html += '<div class="nft-item-overlay"><div class="nft-item-name">' + name + '</div></div>';
        html += '</div>';
      });
      html += '</div>';
      document.getElementById('content').innerHTML = html;
    }
    
    function showEmpty() {
      document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-icon">⬡</div><div class="empty-text">No NFTs yet</div><div class="empty-hint">Mint your first memory!</div></div>';
    }
    
    function showConnectPrompt() {
      document.getElementById('content').innerHTML = '<div class="connect-prompt"><div class="empty-icon" style="font-size: 48px; margin-bottom: 16px;">🔗</div><p style="color: var(--text-muted); margin-bottom: 20px;">Connect your wallet to view NFTs</p><button class="connect-btn" onclick="connectWallet()">Connect Wallet</button></div>';
    }
    
    function connectWallet() {
      ipcRenderer.send('open-wallet-connect');
    }
    
    function refreshAlbum() {
      loadNFTs();
    }
    
    function openNFT(index) {
      ipcRenderer.send('open-nft-detail', nfts[index]);
    }
    
    ipcRenderer.on('wallet-connected', (e, address) => {
      walletAddress = address;
      loadNFTs();
    });
    
    // Initial load
    loadNFTs();
  </script>
</body>
</html>`;
}

// ============================================================================
// NFT LOCAL STORAGE (matches mobile - FileSystem based)
// ============================================================================

let nftStorageFile = null;

function initNFTStorage(appDataPath) {
  nftStorageFile = path.join(appDataPath, 'photolynk_nfts.json');
  console.log('[NFT Storage] Initialized:', nftStorageFile);
}

async function getStoredNFTs() {
  if (!nftStorageFile) return [];
  try {
    if (!fs.existsSync(nftStorageFile)) return [];
    const data = fs.readFileSync(nftStorageFile, 'utf8');
    return JSON.parse(data) || [];
  } catch (e) {
    console.error('[NFT Storage] Read failed:', e.message);
    return [];
  }
}

async function saveNFTToStorage(nftData, serverUrl = null, authHeaders = null) {
  try {
    const existing = await getStoredNFTs();
    existing.push(nftData);
    fs.writeFileSync(nftStorageFile, JSON.stringify(existing, null, 2));
    console.log('[NFT Storage] Saved:', nftData.mintAddress);
    
    // Sync to server if available
    if (serverUrl && authHeaders) {
      try {
        const axios = require('axios');
        await axios.post(`${serverUrl}/api/nft/sync`, { action: 'add', nft: nftData }, {
          headers: authHeaders, timeout: 10000
        });
        console.log('[NFT Storage] Synced to server');
      } catch (syncErr) {
        console.log('[NFT Storage] Server sync failed:', syncErr.message);
      }
    }
  } catch (e) {
    console.error('[NFT Storage] Save failed:', e.message);
  }
}

async function removeNFTFromStorage(mintAddress, serverUrl = null, authHeaders = null) {
  try {
    const existing = await getStoredNFTs();
    const filtered = existing.filter(nft => nft.mintAddress !== mintAddress);
    fs.writeFileSync(nftStorageFile, JSON.stringify(filtered, null, 2));
    console.log('[NFT Storage] Removed:', mintAddress);
    
    if (serverUrl && authHeaders) {
      try {
        const axios = require('axios');
        await axios.post(`${serverUrl}/api/nft/sync`, { action: 'remove', mintAddress }, {
          headers: authHeaders, timeout: 10000
        });
      } catch (syncErr) {
        console.log('[NFT Storage] Server sync removal failed:', syncErr.message);
      }
    }
  } catch (e) {
    console.error('[NFT Storage] Remove failed:', e.message);
  }
}

async function getNFTByMintAddress(mintAddress) {
  const nfts = await getStoredNFTs();
  return nfts.find(nft => nft.mintAddress === mintAddress);
}

async function syncNFTsFromServer(serverUrl, authHeaders) {
  try {
    const axios = require('axios');
    const response = await axios.get(`${serverUrl}/api/nft/list`, { headers: authHeaders, timeout: 15000 });
    const serverNFTs = response.data?.nfts || [];
    
    if (serverNFTs.length === 0) return { success: true, nfts: await getStoredNFTs(), merged: 0 };
    
    const localNFTs = await getStoredNFTs();
    const localMints = new Set(localNFTs.map(n => n.mintAddress));
    let merged = 0;
    
    for (const serverNFT of serverNFTs) {
      if (!localMints.has(serverNFT.mintAddress)) {
        localNFTs.push(serverNFT);
        merged++;
      }
    }
    
    if (merged > 0) {
      fs.writeFileSync(nftStorageFile, JSON.stringify(localNFTs, null, 2));
      console.log('[NFT Storage] Merged', merged, 'NFTs from server');
    }
    
    return { success: true, nfts: localNFTs, merged };
  } catch (e) {
    console.error('[NFT Storage] Server sync failed:', e.message);
    return { success: false, error: e.message, nfts: await getStoredNFTs(), merged: 0 };
  }
}

// ============================================================================
// DOMAIN RESOLUTION (.sol, .skr - same as mobile)
// ============================================================================

async function resolveSolDomain(domain) {
  const trimmed = domain.trim().toLowerCase();
  let cleanDomain = trimmed;
  let tld = 'skr';
  
  if (trimmed.endsWith('.skr')) {
    cleanDomain = trimmed.replace(/\.skr$/, '');
    tld = 'skr';
  } else if (trimmed.endsWith('.sol')) {
    cleanDomain = trimmed.replace(/\.sol$/, '');
    tld = 'sol';
  }
  
  const fullDomain = `${cleanDomain}.${tld}`;
  console.log('[NFT] Resolving', fullDomain);
  
  return new Promise((resolve) => {
    // Try AllDomains API for .skr
    if (tld === 'skr') {
      https.get(`https://api.alldomains.id/domain/${fullDomain}`, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json?.owner) {
              resolve({ success: true, address: json.owner });
              return;
            }
          } catch (e) {}
          resolve({ success: false, error: `Could not resolve ${fullDomain}` });
        });
      }).on('error', () => resolve({ success: false, error: `Could not resolve ${fullDomain}` }));
      return;
    }
    
    // Try Bonfida API for .sol
    https.get(`https://sns-sdk-proxy.bonfida.workers.dev/resolve/${cleanDomain}`, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json?.result) {
            resolve({ success: true, address: json.result });
            return;
          }
        } catch (e) {}
        resolve({ success: false, error: `Could not resolve ${fullDomain}` });
      });
    }).on('error', () => resolve({ success: false, error: `Could not resolve ${fullDomain}` }));
  });
}

function isSolDomain(input) {
  if (!input) return false;
  const trimmed = input.trim().toLowerCase();
  return trimmed.endsWith('.skr') || trimmed.endsWith('.sol');
}

async function resolveRecipient(input) {
  if (!input?.trim()) return { success: false, error: 'No recipient specified' };
  const trimmed = input.trim();
  
  if (isSolDomain(trimmed)) {
    const result = await resolveSolDomain(trimmed);
    return { ...result, isDomain: true, domainName: trimmed };
  }
  
  // Try to parse as Solana address
  if (solanaAvailable) {
    try {
      const pubkey = new PublicKey(trimmed);
      return { success: true, address: pubkey.toBase58(), isDomain: false };
    } catch (e) {
      return { success: false, error: 'Invalid Solana address or domain' };
    }
  }
  
  // Basic validation without web3.js
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    return { success: true, address: trimmed, isDomain: false };
  }
  return { success: false, error: 'Invalid Solana address' };
}

// ============================================================================
// BLOCKCHAIN VERIFICATION (same as mobile)
// ============================================================================

function getExplorerUrl(txSignature, type = 'tx') {
  return `https://explorer.solana.com/${type}/${txSignature}?cluster=mainnet-beta`;
}

function getSolscanUrl(mintAddress) {
  return `https://solscan.io/token/${mintAddress}`;
}

async function verifyNFTOnChain(mintAddress, txSignature = null) {
  if (!initializeSolana()) {
    return { verified: false, error: 'Solana not available' };
  }
  
  try {
    // Handle compressed NFTs
    if (mintAddress?.startsWith('cnft_')) {
      if (mintAddress.startsWith('cnft_tx_')) {
        const txSig = mintAddress.replace('cnft_tx_', '');
        try {
          const txInfo = await connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0 });
          if (txInfo && !txInfo.meta?.err) {
            return { verified: true, exists: true, compressed: true, txBased: true };
          }
        } catch (e) {}
        return { verified: false, error: 'Transaction not found' };
      }
      
      // Use DAS API for real asset ID
      const assetId = mintAddress.replace('cnft_', '');
      return new Promise((resolve) => {
        const postData = JSON.stringify({
          jsonrpc: '2.0', id: 'verify-cnft', method: 'getAsset', params: { id: assetId }
        });
        const req = https.request({
          hostname: 'api.mainnet-beta.solana.com', port: 443, path: '/', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.result?.id) {
                resolve({ verified: true, exists: true, owner: json.result.ownership?.owner, compressed: true });
              } else {
                resolve({ verified: false, error: 'Asset not found' });
              }
            } catch (e) { resolve({ verified: false, error: e.message }); }
          });
        });
        req.on('error', (e) => resolve({ verified: false, error: e.message }));
        req.write(postData);
        req.end();
      });
    }
    
    // Standard NFT verification
    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPubkey);
    return { verified: !!accountInfo, exists: !!accountInfo, owner: accountInfo?.owner?.toBase58() };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

// ============================================================================
// NFT TRANSFER (same as mobile - opens wallet for signing)
// ============================================================================

async function transferNFT(mintAddress, recipientInput) {
  // Resolve recipient
  const resolved = await resolveRecipient(recipientInput);
  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }
  
  const isCompressed = mintAddress?.startsWith('cnft_');
  
  // For desktop, we open a browser-based transfer flow
  // The actual signing happens in the wallet
  const transferUrl = `https://stealthlynk.io/nft-transfer?mint=${encodeURIComponent(mintAddress)}&to=${resolved.address}&compressed=${isCompressed}`;
  
  console.log('[NFT Transfer] Opening transfer page:', transferUrl);
  shell.openExternal(transferUrl);
  
  return {
    success: true,
    status: 'pending',
    recipientAddress: resolved.address,
    isDomain: resolved.isDomain,
    domainName: resolved.domainName,
    message: 'Complete transfer in your wallet',
  };
}

// Build transfer transaction - returns serialized transaction for Phantom to sign
async function buildTransferTransaction(mint, from, to, isCompressed) {
  try {
    const { Connection, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } = require('@solana/web3.js');
    const connection = new Connection(SOLANA_RPC_ENDPOINTS[0], 'confirmed');
    const fromPubkey = new PublicKey(from);
    const toPubkey = new PublicKey(to);
    
    if (isCompressed) {
      // Build compressed NFT (cNFT) transfer using Bubblegum program
      console.log('[Build cNFT Transfer] Building compressed NFT transfer...');
      
      const assetId = mint; // Already cleaned of cnft_ prefix
      const DAS_RPC_URL = SOLANA_RPC_ENDPOINTS[0];
      
      // Fetch asset data from DAS API
      const assetResponse = await fetch(DAS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'get-asset',
          method: 'getAsset',
          params: { id: assetId },
        }),
      });
      const assetData = await assetResponse.json();
      
      if (assetData.error || !assetData.result) {
        console.error('[Build cNFT Transfer] Failed to fetch asset:', assetData.error);
        return { success: false, error: 'Failed to fetch cNFT data. Asset may not exist.' };
      }
      
      const asset = assetData.result;
      console.log('[Build cNFT Transfer] Asset owner:', asset.ownership?.owner);
      
      // Verify ownership
      if (asset.ownership?.owner !== from) {
        return { success: false, error: 'You do not own this NFT' };
      }
      
      // Fetch asset proof from DAS API
      const proofResponse = await fetch(DAS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'get-asset-proof',
          method: 'getAssetProof',
          params: { id: assetId },
        }),
      });
      const proofData = await proofResponse.json();
      
      if (proofData.error || !proofData.result) {
        console.error('[Build cNFT Transfer] Failed to fetch proof:', proofData.error);
        return { success: false, error: 'Failed to fetch cNFT proof.' };
      }
      
      const proof = proofData.result;
      console.log('[Build cNFT Transfer] Proof fetched, tree:', proof.tree_id);
      
      // Bubblegum program IDs
      const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
      const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
      const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
      
      const merkleTree = new PublicKey(proof.tree_id);
      
      // Decode hash helper - DAS returns base58 strings
      const decodeHash = (hash) => {
        if (!hash) return Buffer.alloc(32);
        try {
          return new PublicKey(hash).toBuffer();
        } catch {
          return Buffer.from(hash);
        }
      };
      
      const root = decodeHash(proof.root);
      const dataHash = decodeHash(asset.compression.data_hash);
      const creatorHash = decodeHash(asset.compression.creator_hash);
      const leafIndex = asset.compression.leaf_id;
      const nonce = BigInt(leafIndex);
      
      // Derive tree config PDA
      const [treeConfig] = PublicKey.findProgramAddressSync(
        [merkleTree.toBuffer()],
        BUBBLEGUM_PROGRAM_ID
      );
      
      // Build proof path (remaining accounts)
      const proofPath = proof.proof.map(p => ({
        pubkey: new PublicKey(p),
        isSigner: false,
        isWritable: false,
      }));
      
      // Build transfer instruction data
      const discriminator = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
      const nonceBuffer = Buffer.alloc(8);
      nonceBuffer.writeBigUInt64LE(nonce, 0);
      const indexBuffer = Buffer.alloc(4);
      indexBuffer.writeUInt32LE(leafIndex, 0);
      
      const instructionData = Buffer.concat([
        discriminator, root, dataHash, creatorHash, nonceBuffer, indexBuffer,
      ]);
      
      const transferAccounts = [
        { pubkey: treeConfig, isSigner: false, isWritable: false },
        { pubkey: fromPubkey, isSigner: true, isWritable: false },
        { pubkey: fromPubkey, isSigner: false, isWritable: false },
        { pubkey: toPubkey, isSigner: false, isWritable: false },
        { pubkey: merkleTree, isSigner: false, isWritable: true },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...proofPath,
      ];
      
      const transferInstruction = new TransactionInstruction({
        programId: BUBBLEGUM_PROGRAM_ID,
        keys: transferAccounts,
        data: instructionData,
      });
      
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      
      // Build versioned transaction for cNFT
      const messageV0 = new TransactionMessage({
        payerKey: fromPubkey,
        recentBlockhash: blockhash,
        instructions: [transferInstruction],
      }).compileToV0Message();
      
      const transaction = new VersionedTransaction(messageV0);
      
      // Serialize versioned transaction
      const serialized = Buffer.from(transaction.serialize()).toString('base64');
      
      console.log('[Build cNFT Transfer] Transaction built successfully');
      return { success: true, transaction: serialized, isVersioned: true };
    }
    
    // Build standard NFT transfer transaction
    const { createTransferInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
    
    const mintPubkey = new PublicKey(mint);
    
    // Get associated token addresses
    const fromAta = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
    const toAta = await getAssociatedTokenAddress(mintPubkey, toPubkey);
    
    const transaction = new Transaction();
    
    // Check if recipient has ATA, if not create it
    const toAtaInfo = await connection.getAccountInfo(toAta);
    if (!toAtaInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromPubkey, // payer
          toAta,      // ata
          toPubkey,   // owner
          mintPubkey  // mint
        )
      );
    }
    
    // Add transfer instruction (amount=1 for NFT)
    transaction.add(
      createTransferInstruction(
        fromAta,    // source
        toAta,      // destination
        fromPubkey, // owner
        1           // amount (1 for NFT)
      )
    );
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPubkey;
    
    // Serialize transaction (without signatures - Phantom will sign)
    const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
    
    console.log('[Build Transfer TX] Transaction built successfully');
    return { success: true, transaction: serialized };
  } catch (e) {
    console.error('[Build Transfer TX] Error:', e);
    return { success: false, error: e.message };
  }
}

// Estimate transfer fee from Solana network
// Standard NFT: rent for ATA (if needed) + network fee
// Compressed NFT: just network fee
async function estimateTransferFee(isCompressed, recipientAddress, fromAddress) {
  try {
    if (!solanaAvailable) {
      // Fallback to hardcoded estimates
      return {
        success: true,
        feeLamports: isCompressed ? 8000 : 2040000,
        feeSol: isCompressed ? 0.00008 : 0.00204,
        breakdown: {
          rentLamports: isCompressed ? 0 : 2039280,
          networkFeeLamports: isCompressed ? 8000 : 5000,
        }
      };
    }
    
    // Token account size is 165 bytes for SPL tokens
    const TOKEN_ACCOUNT_SIZE = 165;
    
    // Get rent exemption for token account (only needed for standard NFTs if recipient doesn't have ATA)
    let rentLamports = 0;
    if (!isCompressed) {
      rentLamports = await getRentExemptLamports(TOKEN_ACCOUNT_SIZE);
    }
    
    // Get recent priority fee
    const priorityMicroLamports = await getRecentPriorityMicroLamports();
    
    // Base network fee is 5000 lamports (0.000005 SOL)
    // Priority fee is in micro-lamports per compute unit, typical tx uses ~200k CU
    const baseFee = 5000;
    const priorityFee = Math.ceil((priorityMicroLamports * 200000) / 1000000);
    const networkFeeLamports = baseFee + priorityFee;
    
    const totalLamports = rentLamports + networkFeeLamports;
    const feeSol = totalLamports / 1e9;
    
    return {
      success: true,
      feeLamports: totalLamports,
      feeSol: feeSol,
      breakdown: {
        rentLamports: rentLamports,
        networkFeeLamports: networkFeeLamports,
        priorityFeeLamports: priorityFee,
      }
    };
  } catch (e) {
    console.error('[Estimate Transfer Fee] Error:', e);
    // Fallback to hardcoded estimates
    return {
      success: true,
      feeLamports: isCompressed ? 8000 : 2040000,
      feeSol: isCompressed ? 0.00008 : 0.00204,
      breakdown: {
        rentLamports: isCompressed ? 0 : 2039280,
        networkFeeLamports: isCompressed ? 8000 : 5000,
      }
    };
  }
}

// ============================================================================
// CERTIFICATES OF AUTHENTICITY (CoA) — matches mobile nftOperations.js
// ============================================================================

/**
 * Generate a Certificate of Authenticity JSON for a Limited Edition NFT
 */
function generateCertificate(nftData) {
  if (!nftData) return null;
  const cert = {
    id: `cert_${nftData.mintAddress || Date.now()}`,
    version: 1,
    type: 'PhotoLynk Certificate of Authenticity',
    edition: nftData.edition || 'limited',
    mintAddress: nftData.mintAddress,
    txSignature: nftData.txSignature,
    creatorWallet: nftData.ownerAddress,
    name: nftData.name,
    description: nftData.description,
    contentHash: null,
    exifHash: null,
    license: nftData.license || 'arr',
    watermarked: !!nftData.watermarked,
    encrypted: !!nftData.encrypted,
    storageType: nftData.storageType,
    imageUrl: nftData.arweaveUrl || nftData.imageUrl,
    metadataUrl: nftData.metadataUrl,
    createdAt: nftData.createdAt || new Date().toISOString(),
    issuedAt: new Date().toISOString(),
  };
  // Try direct fields first (desktop post-mint), then metadata attributes (mobile)
  if (nftData.contentHash) cert.contentHash = nftData.contentHash;
  if (nftData.exifHash) cert.exifHash = nftData.exifHash;
  if (nftData.metadata?.attributes) {
    for (const attr of nftData.metadata.attributes) {
      if (attr.trait_type === 'Content Hash' && !cert.contentHash) cert.contentHash = attr.value;
      if (attr.trait_type === 'EXIF Hash' && !cert.exifHash) cert.exifHash = attr.value;
    }
  }
  return cert;
}

/**
 * Save a certificate to local JSON file (desktop equivalent of SecureStore)
 */
const CERTS_FILE = 'nft_certificates.json';
function getCertsFilePath() {
  // Use same directory as nftStorageFile (set by initNFTStorage)
  if (nftStorageFile) {
    return path.join(path.dirname(nftStorageFile), CERTS_FILE);
  }
  // Fallback: use current directory
  return CERTS_FILE;
}

async function saveCertificateLocal(cert) {
  try {
    const filePath = getCertsFilePath();
    let certs = [];
    if (fs.existsSync(filePath)) {
      try { certs = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    }
    const idx = certs.findIndex(c => c.id === cert.id);
    if (idx >= 0) {
      certs[idx] = cert;
    } else {
      certs.unshift(cert);
    }
    fs.writeFileSync(filePath, JSON.stringify(certs, null, 2));
    console.log('[NFT] Certificate saved locally:', cert.id);
    return { success: true };
  } catch (e) {
    console.error('[NFT] Save certificate failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Build a shareable text representation of a certificate
 */
function formatCertificateForExport(cert) {
  if (!cert) return '';

  const LICENSE_MAP = {
    'arr': 'All Rights Reserved',
    'cc-by': 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
    'cc-by-sa': 'Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)',
    'cc-by-nc': 'Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)',
    'cc0': 'Creative Commons Zero 1.0 Universal (CC0 — Public Domain)',
    'commercial': 'Commercial License — Contact Rights Holder',
  };
  const licenseLabel = LICENSE_MAP[cert.license] || cert.license || 'All Rights Reserved';

  const formatDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
        ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    } catch (_) { return iso; }
  };

  const issued = formatDate(cert.issuedAt || cert.createdAt);
  const certId = cert.id || '—';
  const mint = cert.mintAddress || '—';
  const tx = cert.txSignature || '—';
  const creator = cert.creatorWallet || '—';
  const contentHash = cert.contentHash || '— not recorded —';
  const exifHash = cert.exifHash || '— not recorded —';
  const storage = cert.storageType === 'cloud' ? 'StealthCloud (Encrypted Private Storage)' : 'IPFS (Decentralized Public Storage)';

  const lines = [
    '┌─────────────────────────────────────────────────────┐',
    '│                                                     │',
    '│          CERTIFICATE OF AUTHENTICITY                │',
    '│          Digital Asset — Limited Edition             │',
    '│                                                     │',
    '│          Issued by PhotoLynk                        │',
    '│          https://stealthlynk.io                     │',
    '│                                                     │',
    '└─────────────────────────────────────────────────────┘',
    '',
    `Certificate ID:   ${certId}`,
    `Date of Issue:    ${issued}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 1 — WORK IDENTIFICATION',
    '',
    `  Title:          ${cert.name || 'Untitled'}`,
    `  Edition:        ${cert.edition === 'limited' ? 'Limited Edition (1 of 1)' : 'Open Edition'}`,
    `  License:        ${licenseLabel}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 2 — BLOCKCHAIN PROVENANCE',
    '',
    `  Network:        Solana (Mainnet Beta)`,
    `  Mint Address:   ${mint}`,
    `  Transaction:    ${tx}`,
    `  Creator Wallet: ${creator}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 3 — INTEGRITY VERIFICATION',
    '',
    `  Content Hash:   ${contentHash}`,
    `  EXIF Hash:      ${exifHash}`,
    '',
    '  The above cryptographic hashes were computed at the',
    '  time of minting and can be used to verify that the',
    '  original work has not been altered or tampered with.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 4 — ASSET PROTECTION',
    '',
    `  Watermarked:    ${cert.watermarked ? 'Yes — visible watermark applied' : 'No'}`,
    `  Encrypted:      ${cert.encrypted ? 'Yes — AES-256 encrypted at rest' : 'No'}`,
    `  Storage:        ${storage}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'VERIFICATION',
    '',
    `  Solscan:   https://solscan.io/token/${cert.mintAddress || ''}`,
    `  Explorer:  https://explorer.solana.com/address/${cert.mintAddress || ''}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'This certificate was generated automatically at the time',
    'of minting by the PhotoLynk application. The blockchain',
    'record serves as immutable proof of creation, ownership,',
    'and provenance. This document may be presented as evidence',
    'of intellectual property rights.',
    '',
    '© PhotoLynk — stealthlynk.io',
  ];
  return lines.join('\n');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  initializeSolana,
  initNFTStorage,
  
  // Cache
  initCache,
  clearCache,
  getCachedImagePath,
  cacheImage,
  extractIPFSCid,
  
  // Pricing (matches mobile exactly)
  getCurrentFees,
  isPromoActive,
  getPromoDaysRemaining,
  
  // SOL price
  getSolPrice,
  usdToSol,
  estimateNftCostsRealtime,
  
  // Upload functions (same as mobile)
  uploadToPinata,
  uploadMetadataToPinata,
  uploadToStealthCloud,
  
  // NFT metadata and minting
  buildNFTMetadata,
  computeContentHash,
  mintNFT,
  
  // NFT fetching (uses DAS API like mobile)
  fetchUserNFTs,
  fetchImageFromMetadata,
  
  // NFT local storage (same as mobile)
  getStoredNFTs,
  saveNFTToStorage,
  removeNFTFromStorage,
  getNFTByMintAddress,
  syncNFTsFromServer,
  
  // Domain resolution (same as mobile)
  resolveSolDomain,
  isSolDomain,
  resolveRecipient,
  
  // Blockchain verification (same as mobile)
  getExplorerUrl,
  getSolscanUrl,
  verifyNFTOnChain,
  
  // NFT transfer
  transferNFT,
  buildTransferTransaction,
  estimateTransferFee,
  
  // Windows
  openWalletConnect,
  openNFTMintWindow,
  openNFTAlbumWindow,
  
  // Edition system (matches mobile)
  computeExifHash,
  generateOptimizedPreview,
  generateLimitedEditionThumb,
  burnWatermark,
  encryptNFTImage,
  decryptNFTImage,
  
  // Certificates (matches mobile)
  generateCertificate,
  saveCertificateLocal,
  formatCertificateForExport,
  
  // Constants (same as mobile)
  NFT_COMMISSION_WALLET,
  PHOTOLYNK_MERKLE_TREE,
  IPFS_GATEWAYS,
  NFT_STORAGE_OPTIONS,
  NFT_EDITION,
  NFT_LICENSE_OPTIONS,
  EDITION_ROYALTY_BPS,
  SOLANA_RPC_ENDPOINTS,
  PINATA_JWT,
  
  // Status flags
  solanaAvailable,
  splTokenAvailable,
};
