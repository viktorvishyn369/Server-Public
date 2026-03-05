// NFT Desktop Module for PhotoLynk Server Tray
// Handles NFT operations for desktop Electron app
// Full implementation matching solana-seeker/nftOperations.js
// Uses @solana/web3.js for blockchain operations

const { shell, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');

// Get userData path safely
const userDataPath = app.getPath('userData');

// App version for C2PA claim_generator — read from package.json so it stays in sync
let APP_VERSION = '2.0.0';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (_) {}

// Format-agnostic MIME type detection from file extension
// Supports all professional camera formats for byte-exact archival upload
const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.dng': 'image/x-adobe-dng', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef', '.arw': 'image/x-sony-arw', '.raf': 'image/x-fuji-raf',
  '.orf': 'image/x-olympus-orf', '.rw2': 'image/x-panasonic-rw2',
  '.pef': 'image/x-pentax-pef', '.srw': 'image/x-samsung-srw',
};
function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

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
    
    // Create temp file path — use OUTPUT format extension so detectMimeType works correctly
    const ext = path.extname(filePath).toLowerCase();
    const outExt = ext === '.png' ? '.png' : ext === '.webp' ? '.webp' : '.jpg';
    const tempPath = path.join(os.tmpdir(), `nft_stripped_${Date.now()}${outExt}`);
    
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

// Metaplex Token Metadata Program ID (for fetching standard NFT metadata)
let TOKEN_METADATA_PROGRAM_ID = null;
if (solanaAvailable) {
  try { TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'); } catch (_) {}
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

// Fee wallet exemption: the commission wallet itself should not pay fees to itself
// Matches mobile nftOperations.js isFeeWalletExempt
const isFeeWalletExempt = (ownerAddress) => {
  const addr = typeof ownerAddress === 'string' ? ownerAddress : '';
  return addr === NFT_COMMISSION_WALLET;
};

// StealthCloud API base URL
const STEALTHCLOUD_BASE_URL = 'https://stealthlynk.io';

// PhotoLynk shared Merkle Tree for compressed NFTs (same as mobile)
const PHOTOLYNK_MERKLE_TREE = '7qSKB5q1JMmsGx2cHzAJPxvjzXCbAfpWNDTKDM3tSunS';

/**
 * Check if an NFT was created within the PhotoLynk ecosystem.
 * Only ecosystem NFTs should get certificates/proofs generated.
 * Matches solana-seeker/nftOperations.js and mobile-v2/nftCertificates.js
 */
function isPhotoLynkEcosystem(nft) {
  if (!nft) return false;
  if (nft.merkleTree === PHOTOLYNK_MERKLE_TREE) return true;
  if (nft.creatorWallet === NFT_COMMISSION_WALLET) return true;
  const attrs = nft.metadata?.attributes || nft.attributes || [];
  const hasContentHash = attrs.some(a => a.trait_type === 'Content Hash');
  const hasExifHash = attrs.some(a => a.trait_type === 'EXIF Hash');
  if (hasContentHash && hasExifHash) return true;
  const metaCert = nft.metadata?.properties?.certificate;
  if (metaCert && metaCert.type && metaCert.type.includes('PhotoLynk')) return true;
  if (nft.name && nft.name.includes('PhotoLynk')) return true;
  return false;
}

// IPFS Gateways for image loading (Pinata removed — now returns 403)
const IPFS_GATEWAYS = [
  'https://w3s.link/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://ipfs.io/ipfs/',
];

// cNFT-optimized gateways (same set)
const CNFT_IPFS_GATEWAYS = [
  'https://w3s.link/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://ipfs.io/ipfs/',
];

// Storage options (matches mobile)
const NFT_STORAGE_OPTIONS = {
  IPFS: 'ipfs',
  STEALTHCLOUD: 'cloud',
  ARWEAVE: 'arweave',
  ONCHAIN: 'onchain',
};

const ONCHAIN_MAX_IMAGE_BYTES = 200 * 1024; // 200KB max for embedded image (stored in IPFS metadata, not on-chain rent)

// Edition types (matches mobile nftOperations.js)
const NFT_EDITION = {
  OPEN: 'open',
  LIMITED: 'limited',
};

// License options — internationally recognized licenses (matches mobile)
// All Creative Commons licenses are version 4.0 International, recognized by courts worldwide
const NFT_LICENSE_OPTIONS = [
  { id: 'arr', label: 'All Rights Reserved', short: 'ARR', url: null, desc: 'Full copyright protection. No reuse without explicit permission from the rights holder.' },
  { id: 'cc-by', label: 'CC BY 4.0', short: 'CC BY', url: 'https://creativecommons.org/licenses/by/4.0/', desc: 'Others may distribute, remix, adapt, and build upon the work, even commercially, as long as credit is given.' },
  { id: 'cc-by-sa', label: 'CC BY-SA 4.0', short: 'CC BY-SA', url: 'https://creativecommons.org/licenses/by-sa/4.0/', desc: 'Others may remix, adapt, and build upon the work, even commercially, but must credit and license derivatives under identical terms.' },
  { id: 'cc-by-nc', label: 'CC BY-NC 4.0', short: 'CC BY-NC', url: 'https://creativecommons.org/licenses/by-nc/4.0/', desc: 'Others may remix, adapt, and build upon the work for non-commercial purposes only, with credit to the creator.' },
  { id: 'cc-by-nc-sa', label: 'CC BY-NC-SA 4.0', short: 'CC BY-NC-SA', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', desc: 'Others may remix, adapt, and build upon the work for non-commercial purposes only, with credit, and must license derivatives under identical terms.' },
  { id: 'cc-by-nd', label: 'CC BY-ND 4.0', short: 'CC BY-ND', url: 'https://creativecommons.org/licenses/by-nd/4.0/', desc: 'Others may copy and distribute the work in unadapted form only, even commercially, with credit to the creator.' },
  { id: 'cc-by-nc-nd', label: 'CC BY-NC-ND 4.0', short: 'CC BY-NC-ND', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/', desc: 'Others may copy and distribute the work in unadapted form only, for non-commercial purposes only, with credit to the creator.' },
  { id: 'cc0', label: 'CC0 1.0 (Public Domain)', short: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', desc: 'The creator waives all copyright and related rights. The work is dedicated to the public domain worldwide.' },
  { id: 'commercial', label: 'Commercial License', short: 'Commercial', url: null, desc: 'Custom commercial licensing terms. Contact the rights holder for specific usage permissions and fees.' },
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
  APP_COMMISSION_CNFT_IPFS_USD: 0.72,        // cNFT + IPFS
  APP_COMMISSION_CNFT_CLOUD_USD: 0.20,       // cNFT + StealthCloud
  // Standard NFT fees (regular)
  APP_COMMISSION_STANDARD_IPFS_USD: 1.00,    // Standard + IPFS
  APP_COMMISSION_STANDARD_CLOUD_USD: 0.50,   // Standard + StealthCloud
};

function getCurrentFees() {
  return isPromoActive() ? PROMO_FEES : REGULAR_FEES;
}

/**
 * Compute size-based commission fee (matches solana-seeker).
 * Base: $0.72 for files up to 3 MB.
 * Each additional 1 MB above 3 MB adds +10% to the base.
 * Formula: fee = 0.72 × (1 + max(0, ceil(sizeMB − 3)) × 0.10)
 */
const BASE_COMMISSION_USD = 0.72;
const SIZE_THRESHOLD_MB = 3;
const SIZE_SURCHARGE_PER_MB = 0.10;

function computeSizeBasedFee(fileSizeBytes) {
  const sizeMb = (fileSizeBytes || 0) / (1024 * 1024);
  const extraMb = Math.max(0, Math.ceil(sizeMb - SIZE_THRESHOLD_MB));
  const multiplier = 1 + extraMb * SIZE_SURCHARGE_PER_MB;
  return Math.round(BASE_COMMISSION_USD * multiplier * 100) / 100;
}
const computeLimitedEditionFee = computeSizeBasedFee;

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

// Extract a cache key from any image URL (IPFS CID or StealthCloud image ID)
function extractCacheKey(url) {
  if (!url) return null;
  // Try IPFS CID first
  const cid = extractIPFSCid(url);
  if (cid) return cid;
  // StealthCloud: /api/nft/image/:userId/:filename or nft.stealthlynk.io/:userId/:filename
  const scMatch = url.match(/(?:\/api\/nft\/image\/|nft\.stealthlynk\.io\/)([^/]+)\/([^/?#]+)/);
  if (scMatch) return `sc_${scMatch[1]}_${scMatch[2].replace(/\.[^.]+$/, '')}`;
  return null;
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

async function cacheImage(url, cid, headers = {}) {
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
    const opts = { timeout: 30000, headers: headers || {} };
    
    protocol.get(url, opts, (response) => {
      // Follow redirects (301/302/307/308)
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close();
        if (fs.existsSync(cachedPath)) fs.unlinkSync(cachedPath);
        cacheImage(response.headers.location, cid, headers).then(resolve);
        return;
      }
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
        if (fs.existsSync(cachedPath)) fs.unlinkSync(cachedPath);
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
        timeout: 4000,
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

let _solPriceInflight = null;
async function getSolPrice() {
  const now = Date.now();
  if (cachedSolPrice && (now - solPriceLastFetch) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice;
  }
  // Dedup: if a fetch is already in flight, piggyback on it
  if (_solPriceInflight) return _solPriceInflight;
  _solPriceInflight = _fetchSolPrice();
  try { return await _solPriceInflight; } finally { _solPriceInflight = null; }
}
async function _fetchSolPrice() {
  const now = Date.now();

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
          timeout: 4000,
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

let _cachedPriorityFee = 0;
let _priorityFeeTs = 0;
const _PRIORITY_FEE_CACHE_MS = 15000;
async function getRecentPriorityMicroLamports() {
  const now = Date.now();
  if (_priorityFeeTs && (now - _priorityFeeTs) < _PRIORITY_FEE_CACHE_MS) return _cachedPriorityFee;
  try {
    const res = await rpcRequest('getRecentPrioritizationFees', []);
    if (!Array.isArray(res) || res.length === 0) return _cachedPriorityFee;
    const vals = res
      .map((r) => Number(r?.prioritizationFee))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    if (vals.length === 0) return _cachedPriorityFee;
    _cachedPriorityFee = vals[Math.floor(vals.length / 2)];
    _priorityFeeTs = now;
    return _cachedPriorityFee;
  } catch (e) {
    return _cachedPriorityFee;
  }
}

async function prewarmPriorityFee() {
  try { await getRecentPriorityMicroLamports(); } catch (_) {}
}

function estimateNftCostsRealtime({ nftType, storageOption, fileSizeBytes, edition }) {
  const fees = getCurrentFees();
  // 100% synchronous — uses cached values only, never triggers network I/O
  const solPrice = (cachedSolPrice && cachedSolPrice > 0) ? cachedSolPrice : 150;
  const isCompressed = nftType === 'compressed';
  const useCloud = storageOption === 'cloud';
  const isLimited = edition === 'limited';

  const feeUsd = computeSizeBasedFee(fileSizeBytes);
  const feeSol = usdToSol(feeUsd, solPrice);

  let rentLamports = 0;
  let baseFeeLamports = 5000;
  let priorityFeeLamports = 0;

  if (!isCompressed) {
    // Match solana-seeker estimate (0.008 rent + 0.012 metaplex ~= 0.02 SOL)
    rentLamports = 20_000_000;
  }

  const microLamportsPerCu = _cachedPriorityFee;
  const cuEstimate = isCompressed ? 80000 : 250000;
  priorityFeeLamports = Math.ceil((microLamportsPerCu * cuEstimate) / 1_000_000);

  // Storage estimate (mobile-style): base + per-KB, for image + metadata
  // Matches solana-seeker/nftOperations.js NFT_FEES.ARWEAVE_UPLOAD_BASE / ARWEAVE_PER_KB
  const ARWEAVE_UPLOAD_BASE_USD = 0.01;
  const ARWEAVE_PER_KB_USD = 0.00001;
  const metadataBytes = 2000;
  const assumedImageBytes = 2 * 1024 * 1024;
  const useOnChain = storageOption === 'onchain';
  const externalStorage = !useCloud && !useOnChain; // IPFS and Arweave have external upload costs; on-chain has none
  const imageBytes = (Number.isFinite(fileSizeBytes) && fileSizeBytes > 0)
    ? fileSizeBytes
    : (externalStorage ? assumedImageBytes : 0);
  const metadataUsd = (ARWEAVE_UPLOAD_BASE_USD + (metadataBytes / 1024) * ARWEAVE_PER_KB_USD);
  const imageUsd = (ARWEAVE_UPLOAD_BASE_USD + (imageBytes / 1024) * ARWEAVE_PER_KB_USD);
  const storageUsd = externalStorage ? (imageUsd + metadataUsd) : metadataUsd;
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
// PINATA IPFS & AKORD ARWEAVE UPLOAD
// ============================================================================

// Akord API Key for Arweave permanent storage (get at https://akord.com)
const AKORD_API_KEY = process.env.AKORD_API_KEY || '';

const PINATA_JWT = process.env.PINATA_JWT || '';

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
              resolve({
                success: true,
                cid: json.IpfsHash,
                arweaveUrl: `https://ipfs.io/ipfs/${json.IpfsHash}`,  // public gateway — works in all NFT explorers
                gatewayUrl: `https://ipfs.io/ipfs/${json.IpfsHash}`,
                pinataUrl: `https://gateway.pinata.cloud/ipfs/${json.IpfsHash}`,
              });
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
async function uploadMetadataToPinata(metadata, nftKeyB64 = null) {
  return new Promise((resolve) => {
    try {
      const jsonStr = JSON.stringify(metadata, null, 2);
      let fileContent, contentType, fileName, metadataNonce = null;
      
      if (nftKeyB64) {
        // Encrypt metadata JSON with per-NFT key before uploading
        let nacl;
        try { nacl = require('tweetnacl'); } catch (_) {
          resolve({ success: false, error: 'tweetnacl not available for metadata encryption' });
          return;
        }
        const nftKey = Buffer.from(nftKeyB64, 'base64');
        const nonce = nacl.randomBytes(24);
        const plaintext = Buffer.from(jsonStr, 'utf8');
        const encrypted = nacl.secretbox(new Uint8Array(plaintext), nonce, new Uint8Array(nftKey));
        fileContent = Buffer.from(encrypted);
        metadataNonce = Buffer.from(nonce).toString('base64');
        contentType = 'application/octet-stream';
        fileName = `metadata_${Date.now()}.bin`;
        console.log('[NFT] Metadata encrypted before upload:', plaintext.length, '→', encrypted.length, 'bytes');
      } else {
        fileContent = Buffer.from(jsonStr);
        contentType = 'application/json';
        fileName = `metadata_${Date.now()}.json`;
      }
      
      const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
      const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`;
      const footerStr = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(headerStr), fileContent, Buffer.from(footerStr)]);
      
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
              const result = {
                success: true,
                cid: json.IpfsHash,
                arweaveUrl: `https://ipfs.io/ipfs/${json.IpfsHash}`,  // public gateway for metadataUrl
                gatewayUrl: `https://ipfs.io/ipfs/${json.IpfsHash}`,
                pinataUrl: `https://gateway.pinata.cloud/ipfs/${json.IpfsHash}`,
              };
              if (metadataNonce) result.metadataNonce = metadataNonce;
              resolve(result);
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
 * Upload file to Arweave via Akord API (permanent decentralized storage)
 */
async function uploadToAkordArweave(filePath, contentType = 'image/jpeg') {
  return new Promise((resolve) => {
    if (!AKORD_API_KEY) {
      resolve({ success: false, error: 'Akord API key not configured. Get one at https://akord.com' });
      return;
    }
    try {
      const fileData = fs.readFileSync(filePath);
      console.log(`[Arweave] Uploading ${fileData.length} bytes via Akord...`);

      const req = https.request({
        hostname: 'api.akord.com',
        port: 443,
        path: '/files',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Api-Key': AKORD_API_KEY,
          'Content-Type': contentType,
          'Content-Length': fileData.length,
        },
        timeout: 120000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.tx && json.tx.id) {
              const txId = json.tx.id;
              const arweaveUrl = `https://akrd.net/${txId}`;
              console.log('[Arweave] Uploaded, tx:', txId);
              resolve({
                success: true,
                arweaveUrl,
                permanentUrl: `https://arweave.net/${txId}`,
                transactionId: txId,
                size: fileData.length,
                storageType: 'arweave',
              });
            } else {
              resolve({ success: false, error: json.error || 'No transaction ID returned' });
            }
          } catch (e) { resolve({ success: false, error: e.message }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(fileData);
      req.end();
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

/**
 * Upload JSON metadata to Arweave via Akord API
 */
async function uploadMetadataToAkordArweave(metadata, nftKeyB64 = null) {
  return new Promise((resolve) => {
    if (!AKORD_API_KEY) {
      resolve({ success: false, error: 'Akord API key not configured' });
      return;
    }
    try {
      const jsonStr = JSON.stringify(metadata, null, 2);
      let uploadBuf, contentType, metadataNonce = null;
      
      if (nftKeyB64) {
        // Encrypt metadata JSON with per-NFT key before uploading
        let nacl;
        try { nacl = require('tweetnacl'); } catch (_) {
          resolve({ success: false, error: 'tweetnacl not available for metadata encryption' });
          return;
        }
        const nftKey = Buffer.from(nftKeyB64, 'base64');
        const nonce = nacl.randomBytes(24);
        const plaintext = Buffer.from(jsonStr, 'utf8');
        const encrypted = nacl.secretbox(new Uint8Array(plaintext), nonce, new Uint8Array(nftKey));
        uploadBuf = Buffer.from(encrypted);
        metadataNonce = Buffer.from(nonce).toString('base64');
        contentType = 'application/octet-stream';
        console.log('[Arweave] Metadata encrypted before upload:', plaintext.length, '→', encrypted.length, 'bytes');
      } else {
        uploadBuf = Buffer.from(jsonStr, 'utf8');
        contentType = 'application/json';
      }
      console.log(`[Arweave] Uploading metadata (${uploadBuf.length} bytes) via Akord...`);

      const req = https.request({
        hostname: 'api.akord.com',
        port: 443,
        path: '/files',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Api-Key': AKORD_API_KEY,
          'Content-Type': contentType,
          'Content-Length': uploadBuf.length,
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.tx && json.tx.id) {
              const txId = json.tx.id;
              console.log('[Arweave] Metadata uploaded, tx:', txId);
              const result = {
                success: true,
                arweaveUrl: `https://akrd.net/${txId}`,
                permanentUrl: `https://arweave.net/${txId}`,
                transactionId: txId,
              };
              if (metadataNonce) result.metadataNonce = metadataNonce;
              resolve(result);
            } else {
              resolve({ success: false, error: 'No transaction ID returned' });
            }
          } catch (e) { resolve({ success: false, error: e.message }); }
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.write(uploadBuf);
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
      const isEncrypted = filePath.endsWith('.bin');
      const fileName = isEncrypted ? `nft_${Date.now()}.bin` : `nft_${Date.now()}.jpg`;
      const fileContentType = isEncrypted ? 'application/octet-stream' : 'image/jpeg';
      const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
      
      const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: ${fileContentType}\r\n\r\n`;
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
 * Compute deterministic cross-platform SHA256 hash of EXIF metadata.
 * 
 * IMPORTANT: iOS and Android re-encode JPEG files differently — raw EXIF binary,
 * thumbnails, IFD structure, and even pixel data differ for the same photo.
 * Hashing raw EXIF binary will NEVER match cross-platform.
 * 
 * Instead, we parse EXIF into structured fields, keep only stable camera-related
 * fields (stripping thumbnails, MakerNote, Software, UUIDs, padding), sort
 * deterministically, and hash the normalized JSON. This produces identical hashes
 * on desktop (sharp + exif-reader) and mobile (raw TIFF parsing).
 * 
 * Returns null if no meaningful EXIF fields are found (e.g. EXIF-stripped files).
 * 
 * @param {Buffer} exifBuffer - Raw EXIF buffer from sharp.metadata().exif
 * @returns {string|null} SHA256 hex hash or null
 */

// ============================================================================
// RAW EXIF BINARY HASH (Hash1 — exact camera EXIF bytes, no parsing)
// ============================================================================

/**
 * Extract raw EXIF binary bytes from any image file and return as Buffer.
 * No parsing, no library interpretation — exact bytes as the camera wrote them.
 * Supports: JPEG (APP1), HEIC/HEIF (sharp raw buffer), TIFF/DNG/CR2/NEF/ARW (ExifReader raw),
 *           PNG (eXIf chunk), WebP (EXIF chunk).
 *
 * For JPEG: extracts the entire APP1 Exif segment (Exif\0\0 + TIFF IFDs).
 * For HEIC/RAW/TIFF: uses sharp.metadata().exif which returns the raw EXIF buffer.
 * For PNG/WebP: binary chunk scan for eXIf/EXIF.
 *
 * @param {string} filePath - Path to the image file
 * @returns {Promise<Buffer|null>} Raw EXIF binary bytes or null
 */
async function extractRawExifBytes(filePath) {
  if (!filePath) return null;
  try {
    const headerBuf = Buffer.alloc(64);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, headerBuf, 0, 64, 0);

    // === JPEG: Find APP1 marker (FF E1) containing "Exif\0\0" ===
    if (headerBuf[0] === 0xFF && headerBuf[1] === 0xD8) {
      const stat = fs.fstatSync(fd);
      const scanLen = Math.min(stat.size, 256 * 1024);
      const scanBuf = Buffer.alloc(scanLen);
      fs.readSync(fd, scanBuf, 0, scanLen, 0);
      fs.closeSync(fd);

      let pos = 2; // skip SOI
      while (pos + 4 < scanLen) {
        if (scanBuf[pos] !== 0xFF) break;
        const marker = scanBuf[pos + 1];
        const segLen = (scanBuf[pos + 2] << 8) | scanBuf[pos + 3];
        if (marker === 0xE1 && segLen > 8) {
          if (scanBuf[pos + 4] === 0x45 && scanBuf[pos + 5] === 0x78 &&
              scanBuf[pos + 6] === 0x69 && scanBuf[pos + 7] === 0x66 &&
              scanBuf[pos + 8] === 0x00 && scanBuf[pos + 9] === 0x00) {
            // Return entire APP1 Exif segment: "Exif\0\0" + TIFF header + all IFDs
            return scanBuf.slice(pos + 4, pos + 2 + segLen);
          }
        }
        if (marker === 0xDA) break; // SOS — stop scanning
        pos += 2 + segLen;
      }
      return null;
    }

    // === PNG: Find eXIf chunk ===
    if (headerBuf[0] === 0x89 && headerBuf[1] === 0x50 &&
        headerBuf[2] === 0x4E && headerBuf[3] === 0x47) {
      const stat = fs.fstatSync(fd);
      const scanLen = Math.min(stat.size, 512 * 1024);
      const scanBuf = Buffer.alloc(scanLen);
      fs.readSync(fd, scanBuf, 0, scanLen, 0);
      fs.closeSync(fd);

      let pos = 8; // skip PNG signature
      while (pos + 12 < scanLen) {
        const chunkLen = (scanBuf[pos] << 24 | scanBuf[pos + 1] << 16 | scanBuf[pos + 2] << 8 | scanBuf[pos + 3]) >>> 0;
        const chunkType = scanBuf.slice(pos + 4, pos + 8).toString('ascii');
        if (chunkType === 'eXIf' && chunkLen > 0) {
          return scanBuf.slice(pos + 8, pos + 8 + chunkLen);
        }
        if (chunkType === 'IEND') break;
        pos += 12 + chunkLen; // 4 len + 4 type + data + 4 CRC
      }
      return null;
    }

    // === WebP: Find EXIF chunk in RIFF container ===
    if (headerBuf.slice(0, 4).toString('ascii') === 'RIFF' &&
        headerBuf.slice(8, 12).toString('ascii') === 'WEBP') {
      const stat = fs.fstatSync(fd);
      const scanLen = Math.min(stat.size, 512 * 1024);
      const scanBuf = Buffer.alloc(scanLen);
      fs.readSync(fd, scanBuf, 0, scanLen, 0);
      fs.closeSync(fd);

      let pos = 12; // skip RIFF header
      while (pos + 8 < scanLen) {
        const chunkId = scanBuf.slice(pos, pos + 4).toString('ascii');
        const chunkSize = (scanBuf[pos + 4] | (scanBuf[pos + 5] << 8) | (scanBuf[pos + 6] << 16) | ((scanBuf[pos + 7] << 24) >>> 0));
        if (chunkId === 'EXIF' && chunkSize > 0) {
          return scanBuf.slice(pos + 8, pos + 8 + chunkSize);
        }
        pos += 8 + chunkSize + (chunkSize % 2); // RIFF chunks are word-aligned
      }
      return null;
    }

    fs.closeSync(fd);

    // === HEIC/HEIF, TIFF/DNG, RAW (CR2/CR3/NEF/ARW/ORF/RW2/PEF/SRW/RAF) ===
    // Use sharp to extract the raw EXIF buffer. Sharp returns the exact TIFF IFD
    // bytes embedded in the file — no re-encoding, no interpretation.
    // This handles ISOBMFF (HEIC), TIFF-based (DNG/CR2/NEF/ARW), etc.
    try {
      const sharpMod = require('sharp');
      const meta = await sharpMod(filePath).metadata();
      if (meta.exif && meta.exif.length > 0) {
        return meta.exif;
      }
    } catch (_) {}

    return null;
  } catch (e) {
    console.warn('[NFT] extractRawExifBytes failed:', e?.message);
    return null;
  }
}

/**
 * Strip IFD1 thumbnail data from raw TIFF/EXIF bytes for cross-platform stability.
 * iOS regenerates the embedded JPEG thumbnail with different compression artifacts
 * each time getAssetInfoAsync exports the photo, causing the raw EXIF binary to differ
 * even though all actual camera fields (IFD0, ExifIFD, GPSIFD) are identical.
 *
 * This function zeroes out:
 *   - The IFD1 thumbnail JPEG blob (JpegIFOffset/JpegIFByteCount region)
 *   - The IFD1 offset/count tag values themselves
 *   - The IFD1-next-IFD pointer (set to 0)
 *
 * The result is deterministic across iOS/Android/Desktop for the same photo.
 * Operates on a COPY — does not mutate the input.
 *
 * @param {Buffer} raw - Raw EXIF bytes (starts with "Exif\0\0" for JPEG APP1,
 *                       or raw TIFF header for PNG eXIf / WebP EXIF / sharp buffer)
 * @returns {Buffer} Copy with thumbnail data zeroed out
 */
function stripThumbnailFromTiff(raw) {
  if (!raw || raw.length < 16) return raw;

  const buf = Buffer.from(raw); // work on a copy

  // Determine TIFF start offset: "Exif\0\0" prefix means TIFF starts at byte 6
  let tiffOff = 0;
  if (buf[0] === 0x45 && buf[1] === 0x78 && buf[2] === 0x69 && buf[3] === 0x66 &&
      buf[4] === 0x00 && buf[5] === 0x00) {
    tiffOff = 6;
  }

  if (tiffOff + 8 > buf.length) return buf;

  // Byte order
  const le = (buf[tiffOff] === 0x49 && buf[tiffOff + 1] === 0x49); // 'II' = little-endian
  const be = (buf[tiffOff] === 0x4D && buf[tiffOff + 1] === 0x4D); // 'MM' = big-endian
  if (!le && !be) return buf;

  const u16 = (off) => le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
  const u32 = (off) => le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
  const w32 = (off, v) => { if (le) buf.writeUInt32LE(v, off); else buf.writeUInt32BE(v, off); };

  // IFD0 offset (relative to TIFF start)
  const ifd0Rel = u32(tiffOff + 4);
  const ifd0Abs = tiffOff + ifd0Rel;
  if (ifd0Abs + 2 > buf.length) return buf;

  const ifd0Count = u16(ifd0Abs);
  const ifd0End = ifd0Abs + 2 + ifd0Count * 12;
  if (ifd0End + 4 > buf.length) return buf;

  // Next-IFD pointer after IFD0 → this is IFD1
  const ifd1Rel = u32(ifd0End);
  if (ifd1Rel === 0) return buf; // no IFD1 — no thumbnail

  const ifd1Abs = tiffOff + ifd1Rel;
  if (ifd1Abs + 2 > buf.length) return buf;

  const ifd1Count = u16(ifd1Abs);
  if (ifd1Abs + 2 + ifd1Count * 12 + 4 > buf.length) return buf;

  // Zero out the IFD1 pointer from IFD0
  w32(ifd0End, 0);

  // Scan IFD1 entries for thumbnail offset/length tags
  let thumbOffset = 0, thumbLength = 0;
  let thumbOffsetTagAbs = 0, thumbLengthTagAbs = 0;

  for (let i = 0; i < ifd1Count; i++) {
    const entryAbs = ifd1Abs + 2 + i * 12;
    const tag = u16(entryAbs);
    if (tag === 0x0201) { // JpegIFOffset (thumbnail data offset, relative to TIFF start)
      thumbOffset = u32(entryAbs + 8);
      thumbOffsetTagAbs = entryAbs + 8;
    } else if (tag === 0x0202) { // JpegIFByteCount
      thumbLength = u32(entryAbs + 8);
      thumbLengthTagAbs = entryAbs + 8;
    }
  }

  // Zero out the thumbnail JPEG blob
  if (thumbOffset > 0 && thumbLength > 0) {
    const absStart = tiffOff + thumbOffset;
    const absEnd = Math.min(absStart + thumbLength, buf.length);
    if (absStart < buf.length) {
      buf.fill(0, absStart, absEnd);
    }
  }

  // Zero out the tag values themselves (offset + length)
  if (thumbOffsetTagAbs) w32(thumbOffsetTagAbs, 0);
  if (thumbLengthTagAbs) w32(thumbLengthTagAbs, 0);

  // Zero out the entire IFD1 entry block (all tags + next-IFD pointer)
  const ifd1BlockEnd = Math.min(ifd1Abs + 2 + ifd1Count * 12 + 4, buf.length);
  buf.fill(0, ifd1Abs, ifd1BlockEnd);

  return buf;
}

/**
 * Compute Hash1: SHA-256 of raw EXIF binary bytes from the original file.
 * Strips IFD1 thumbnail before hashing for cross-platform stability.
 * Identical on any platform because the file is byte-exact across the ecosystem
 * and the thumbnail (which iOS re-renders) is zeroed out deterministically.
 * @param {string} filePath - Path to the image file
 * @returns {Promise<string|null>} SHA-256 hex hash or null
 */
async function computeExifRawHash(filePath) {
  const rawBytes = await extractRawExifBytes(filePath);
  if (!rawBytes || rawBytes.length === 0) return null;
  const stable = stripThumbnailFromTiff(rawBytes);
  const hash = crypto.createHash('sha256').update(stable).digest('hex');
  console.log(`[NFT] EXIF Raw Hash (${stable.length} bytes, thumb-stripped): ${hash.substring(0, 16)}...`);
  return hash;
}

/**
 * Compute Hash3: Binding proof — SHA-256(Hash1 + "|" + Hash2).
 * Cryptographically binds the exact raw hash and the normalized dedup hash.
 * @param {string} rawHash - Hash1 (exact raw EXIF binary)
 * @param {string} normalizedHash - Hash2 (normalized/rounded for dedup)
 * @returns {string|null} SHA-256 hex binding hash or null
 */
function computeExifBindingHash(rawHash, normalizedHash) {
  if (!rawHash && !normalizedHash) return null;
  const input = `${rawHash || 'none'}|${normalizedHash || 'none'}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Compute EXIF hash from a file path using ExifReader.
 * Works for ALL formats: HEIC, RAW (CR2/NEF/ARW/DNG/etc), JPEG, TIFF, PNG, WebP.
 * Extracts raw numeric values (not description strings) to match exif-reader output
 * for cross-platform hash consistency with mobile computeExifHash.
 * @param {string} filePath - Path to the image file
 * @returns {Promise<string|null>} SHA256 hex hash or null
 */
async function computeExifHashFromFile(filePath) {
  if (!filePath) return null;
  try {
    const ExifReader = require('exifreader');
    const tags = await ExifReader.load(filePath);
    if (!tags) return null;

    // Helper: extract raw numeric from ExifReader tag
    // ExifReader returns: integers as value=N, rationals as value=[num,den],
    // strings as value=["str"], DMS GPS as value=[[d,1],[m,1],[s,100]]
    // Round ALL decimal results to 4dp for cross-platform stability.
    // Different EXIF libraries (ExifReader, exif-reader, iOS CGImageSource, exiftool)
    // return slightly different float representations of the same TIFF rational.
    // e.g. FNumber 178/100=1.78 vs 1244236/699009=1.7799999713... both round to 1.78.
    // Max float drift from rational re-encoding is ~1e-7; round4 boundary gap is 5e-5 (500x margin).
    // GPS uses trunc (not round) to avoid grid boundary crossing (49.99999→50 crosses a degree).
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const t4 = (v) => Math.trunc(v * 1e4) / 1e4;
    const getNum = (key) => {
      const t = tags[key];
      if (!t) return null;
      const v = t.value;
      if (v == null) return null;
      // Integer/float — round decimals to 4dp
      if (typeof v === 'number') return Number.isInteger(v) ? v : r4(v);
      // Rational [numerator, denominator] — round to 4dp for stability
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
        if (v[1] === 0) return 0;
        const r = v[0] / v[1];
        return Number.isInteger(r) ? r : r4(r);
      }
      // Single-element array with number
      if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'number') {
        return Number.isInteger(v[0]) ? v[0] : r4(v[0]);
      }
      // Flash: exiftool may expand integer into {Fired,Function,Mode,RedEyeMode,Return} object
      // Reconstruct EXIF Flash bitmask: bit0=Fired, bit1-2=Return, bit3-4=Mode, bit5=Function, bit6=RedEye
      if (key === 'Flash' && v && typeof v === 'object' && !Array.isArray(v) && v.Fired != null) {
        let bits = 0;
        if (String(v.Fired?.value || v.Fired) === 'True') bits |= 0x01;
        const ret = parseInt(String(v.Return?.value ?? v.Return ?? 0)); if (!isNaN(ret)) bits |= ((ret & 0x03) << 1);
        const mode = parseInt(String(v.Mode?.value ?? v.Mode ?? 0)); if (!isNaN(mode)) bits |= ((mode & 0x03) << 3);
        if (String(v.Function?.value || v.Function) === 'True') bits |= 0x20;
        if (String(v.RedEyeMode?.value || v.RedEyeMode) === 'True') bits |= 0x40;
        return bits;
      }
      // Try description as number
      const d = t.description;
      if (d != null) { const n = parseFloat(String(d)); if (!isNaN(n)) return Number.isInteger(n) ? n : r4(n); }
      return null;
    };
    const getStr = (key) => {
      const t = tags[key];
      if (!t) return null;
      // Strip null bytes (Android cameras pad with \0) and trim
      const clean = (s) => s ? String(s).replace(/\0/g, '').trim() : null;
      if (t.description && typeof t.description === 'string') {
        return clean(t.description) || null;
      }
      const v = t.value;
      if (typeof v === 'string') return clean(v) || null;
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return clean(v[0]) || null;
      return null;
    };
    const getGpsDecimal = (key) => {
      const t = tags[key];
      if (!t) return null;
      // ExifReader GPS: description is already decimal degrees
      if (t.description != null) {
        const n = parseFloat(String(t.description));
        if (!isNaN(n)) return n;
      }
      // Fallback: DMS array [[d,1],[m,1],[s,100]]
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

    const normalized = {};

    // IFD0
    const make = getStr('Make');
    if (make) normalized.Make = make;
    const model = getStr('Model');
    if (model) normalized.Model = model;
    const orient = getNum('Orientation');
    if (orient != null) normalized.Orientation = orient;

    // ExifIFD
    const dto = getStr('DateTimeOriginal') || getStr('DateTimeDigitized');
    if (dto) normalized.DateTimeOriginal = dto.slice(0, 19);
    const et = getNum('ExposureTime');
    if (et != null) normalized.ExposureTime = et;
    const fn = getNum('FNumber');
    if (fn != null) normalized.FNumber = fn;
    const iso = getNum('ISOSpeedRatings') ?? getNum('ISO');
    if (iso != null) normalized.ISO = iso;
    const fl = getNum('FocalLength');
    if (fl != null) normalized.FocalLength = fl;
    const fl35 = getNum('FocalLengthIn35mmFilm') ?? getNum('FocalLengthIn35mmFormat');
    if (fl35 != null) normalized.FocalLengthIn35mm = fl35;
    const em = getNum('ExposureMode');
    if (em != null) normalized.ExposureMode = em;
    const wb = getNum('WhiteBalance');
    if (wb != null) normalized.WhiteBalance = wb;
    const mm = getNum('MeteringMode');
    if (mm != null) normalized.MeteringMode = mm;
    const flash = getNum('Flash');
    if (flash != null) normalized.Flash = flash;
    const cs = getNum('ColorSpace');
    if (cs != null) normalized.ColorSpace = cs;
    const pxW = getNum('PixelXDimension') ?? getNum('ExifImageWidth');
    if (pxW != null) normalized.PixelXDimension = pxW;
    const pxH = getNum('PixelYDimension') ?? getNum('ExifImageHeight');
    if (pxH != null) normalized.PixelYDimension = pxH;
    const sct = getNum('SceneCaptureType');
    if (sct != null) normalized.SceneCaptureType = sct;
    const lm = getStr('LensMake');
    if (lm) normalized.LensMake = lm;
    const lmod = getStr('LensModel');
    if (lmod) normalized.LensModel = lmod;
    const bsn = getStr('BodySerialNumber');
    if (bsn) normalized.BodySerialNumber = bsn;

    // GPS — ExifReader returns UNSIGNED decimal (no N/S/E/W sign applied).
    // Must check GPSLatitudeRef/GPSLongitudeRef and negate for S/W to match mobile.
    const lat = getGpsDecimal('GPSLatitude');
    if (lat != null) {
      const latRef = getStr('GPSLatitudeRef');
      normalized.GPSLatitude = Math.trunc((latRef && latRef.startsWith('S') ? -Math.abs(lat) : lat) * 1e4) / 1e4;
    }
    const lon = getGpsDecimal('GPSLongitude');
    if (lon != null) {
      const lonRef = getStr('GPSLongitudeRef');
      normalized.GPSLongitude = Math.trunc((lonRef && lonRef.startsWith('W') ? -Math.abs(lon) : lon) * 1e4) / 1e4;
    }
    const alt = getGpsDecimal('GPSAltitude');
    if (alt != null) normalized.GPSAltitude = Math.trunc(alt * 1e4) / 1e4;

    if (Object.keys(normalized).length === 0) {
      console.log('[NFT] EXIF hash (ExifReader): no meaningful fields found');
      return null;
    }

    // Universal decimal safety net: round non-GPS numerics to 4dp, trunc GPS to 4dp.
    // This catches any numeric field (current or future) that may have cross-platform float drift.
    const GPS_KEYS = new Set(['GPSLatitude', 'GPSLongitude', 'GPSAltitude']);
    const sorted = {};
    for (const key of Object.keys(normalized).sort()) {
      let v = normalized[key];
      if (typeof v === 'number' && !Number.isInteger(v)) {
        v = GPS_KEYS.has(key) ? t4(v) : r4(v);
      }
      sorted[key] = v;
    }
    const json = JSON.stringify(sorted);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    console.log('[NFT] Normalized EXIF hash via ExifReader (' + Object.keys(sorted).length + ' fields):', hash.substring(0, 16) + '...');
    return hash;
  } catch (e) {
    console.warn('[NFT] EXIF hash (ExifReader) failed:', e?.message);
    return null;
  }
}

function computeExifHash(exifBuffer) {
  if (!exifBuffer || exifBuffer.length === 0) return null;
  try {
    const exifReader = require('exif-reader');
    const parsed = exifReader(exifBuffer);
    if (!parsed) return null;

    // exif-reader v1 uses image/exif/gps, v2+ uses Image/Photo/GPSInfo
    const img = parsed.image || parsed.Image || {};
    const exif = parsed.exif || parsed.Photo || {};
    const gps = parsed.gps || parsed.GPSInfo || parsed.GPS || {};

    // Collect only stable, camera-related fields that survive cross-platform transfer.
    // Excluded: thumbnail, MakerNote, Software, UserComment, ImageUniqueID,
    // SubSecTime*, OffsetTime*, padding, and any binary/undefined fields.
    // Round non-GPS decimals to 4dp for cross-platform stability.
    // GPS uses trunc to avoid grid boundary crossing (49.99999→50 crosses a degree).
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const t4 = (v) => Math.trunc(v * 1e4) / 1e4;
    const num4 = (v) => { const n = Number(v); return Number.isInteger(n) ? n : r4(n); };
    const normalized = {};

    // IFD0 (image)
    const cleanStr = (s) => s ? String(s).replace(/\0/g, '').trim() : null;
    if (img.Make) normalized.Make = cleanStr(img.Make);
    if (img.Model) normalized.Model = cleanStr(img.Model);
    if (img.Orientation != null) normalized.Orientation = Number(img.Orientation);

    // ExifIFD (camera settings) — support both v1 and v2 field names
    const dto = exif.DateTimeOriginal || exif.DateTimeDigitized;
    if (dto) {
      // Format as EXIF string "YYYY:MM:DD HH:MM:SS" to match mobile TIFF parser output.
      // exif-reader returns a Date object; toISOString() produces "2024-01-15T14:30:00"
      // which would NOT match mobile's "2024:01:15 14:30:00" — breaking cross-platform hash.
      if (dto instanceof Date) {
        // exif-reader parses "YYYY:MM:DD HH:MM:SS" via Date.UTC() — the original
        // hour/minute/second are stored as UTC values. Use getUTC*() to recover them.
        const pad = (n) => String(n).padStart(2, '0');
        normalized.DateTimeOriginal = `${dto.getUTCFullYear()}:${pad(dto.getUTCMonth() + 1)}:${pad(dto.getUTCDate())} ${pad(dto.getUTCHours())}:${pad(dto.getUTCMinutes())}:${pad(dto.getUTCSeconds())}`;
      } else {
        normalized.DateTimeOriginal = String(dto).slice(0, 19);
      }
    }
    if (exif.ExposureTime != null) normalized.ExposureTime = num4(exif.ExposureTime);
    if (exif.FNumber != null) normalized.FNumber = num4(exif.FNumber);
    const iso = exif.ISO ?? exif.ISOSpeedRatings ?? exif.PhotographicSensitivity;
    if (iso != null) normalized.ISO = num4(iso);
    if (exif.FocalLength != null) normalized.FocalLength = num4(exif.FocalLength);
    const fl35 = exif.FocalLengthIn35mmFormat ?? exif.FocalLengthIn35mmFilm;
    if (fl35 != null) normalized.FocalLengthIn35mm = num4(fl35);
    if (exif.ExposureMode != null) normalized.ExposureMode = num4(exif.ExposureMode);
    if (exif.WhiteBalance != null) normalized.WhiteBalance = num4(exif.WhiteBalance);
    if (exif.MeteringMode != null) normalized.MeteringMode = num4(exif.MeteringMode);
    if (exif.Flash != null) normalized.Flash = num4(exif.Flash);
    if (exif.ColorSpace != null) normalized.ColorSpace = num4(exif.ColorSpace);
    // Pixel dimensions: v1 uses ExifImageWidth/Height, v2 uses PixelXDimension/PixelYDimension
    const pxW = exif.PixelXDimension ?? exif.ExifImageWidth;
    const pxH = exif.PixelYDimension ?? exif.ExifImageHeight;
    if (pxW != null) normalized.PixelXDimension = num4(pxW);
    if (pxH != null) normalized.PixelYDimension = num4(pxH);
    if (exif.SceneCaptureType != null) normalized.SceneCaptureType = num4(exif.SceneCaptureType);
    if (exif.LensMake) normalized.LensMake = cleanStr(exif.LensMake);
    if (exif.LensModel) normalized.LensModel = cleanStr(exif.LensModel);
    if (exif.BodySerialNumber) normalized.BodySerialNumber = cleanStr(exif.BodySerialNumber);

    // GPS — exif-reader v2 returns GPSLatitude/GPSLongitude as [deg, min, sec] arrays
    // (3 RATIONAL values), NOT as a single decimal. Convert DMS→decimal and apply N/S/E/W ref.
    const dmsToDecimal = (arr) => {
      if (Array.isArray(arr) && arr.length === 3) return arr[0] + arr[1] / 60 + arr[2] / 3600;
      if (typeof arr === 'number') return arr;
      return NaN;
    };
    if (gps.GPSLatitude != null) {
      let lat = dmsToDecimal(gps.GPSLatitude);
      if (!isNaN(lat)) {
        if (gps.GPSLatitudeRef === 'S') lat = -Math.abs(lat);
        normalized.GPSLatitude = t4(lat);
      }
    }
    if (gps.GPSLongitude != null) {
      let lon = dmsToDecimal(gps.GPSLongitude);
      if (!isNaN(lon)) {
        if (gps.GPSLongitudeRef === 'W') lon = -Math.abs(lon);
        normalized.GPSLongitude = t4(lon);
      }
    }
    if (gps.GPSAltitude != null) normalized.GPSAltitude = t4(Number(gps.GPSAltitude));

    // If no meaningful fields were found, return null instead of hashing empty object
    if (Object.keys(normalized).length === 0) {
      console.log('[NFT] EXIF hash: no meaningful fields found, returning null');
      return null;
    }

    // Universal decimal safety net: round non-GPS numerics to 4dp, trunc GPS to 4dp.
    // This catches any numeric field (current or future) that may have cross-platform float drift.
    const GPS_KEYS = new Set(['GPSLatitude', 'GPSLongitude', 'GPSAltitude']);
    const sorted = {};
    for (const key of Object.keys(normalized).sort()) {
      let v = normalized[key];
      if (typeof v === 'number' && !Number.isInteger(v)) {
        v = GPS_KEYS.has(key) ? t4(v) : r4(v);
      }
      sorted[key] = v;
    }
    const json = JSON.stringify(sorted);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    console.log('[NFT] Normalized EXIF hash (' + Object.keys(sorted).length + ' fields):', hash.substring(0, 16) + '...');
    return hash;
  } catch (e) {
    console.warn('[NFT] EXIF hash failed:', e?.message);
    return null;
  }
}

/**
 * Request an RFC 3161 trusted timestamp from FreeTSA.org.
 * Builds a minimal DER-encoded TimeStampReq, POSTs to TSA, returns base64 TSR.
 * Verifiable with: openssl ts -verify -in token.tsr -digest <hash> -CAfile cacert.pem
 * @param {string} hexHash - SHA-256 hex hash of the content to timestamp
 * @returns {Promise<{success:boolean, tsaToken:string|null, tsaUrl:string, tsaPolicy:string, error:string|null}>}
 */
async function requestRFC3161Timestamp(hexHash) {
  const TSA_URL = 'https://freetsa.org/tsr';
  const TSA_POLICY = '1.2.840.113549.1.9.16.1.4'; // FreeTSA policy OID
  const MAX_RETRIES = 3;
  const TIMEOUT_MS = 20000;
  
  const hashBytes = Buffer.from(hexHash, 'hex'); // 32 bytes for SHA-256

  // Build DER-encoded TimeStampReq manually (no asn1 library needed)
  // SHA-256 OID: 2.16.840.1.101.3.4.2.1
  const sha256OidBytes = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
  const nullBytes = Buffer.from([0x05, 0x00]);

  // AlgorithmIdentifier SEQUENCE { OID, NULL }
  const algIdContent = Buffer.concat([sha256OidBytes, nullBytes]);
  const algId = Buffer.concat([Buffer.from([0x30, algIdContent.length]), algIdContent]);

  // hashedMessage OCTET STRING
  const hashedMsg = Buffer.concat([Buffer.from([0x04, hashBytes.length]), hashBytes]);

  // MessageImprint SEQUENCE { AlgorithmIdentifier, hashedMessage }
  const msgImprintContent = Buffer.concat([algId, hashedMsg]);
  const msgImprint = Buffer.concat([Buffer.from([0x30, msgImprintContent.length]), msgImprintContent]);

  // version INTEGER 1
  const version = Buffer.from([0x02, 0x01, 0x01]);

  // certReq BOOLEAN TRUE
  const certReq = Buffer.from([0x01, 0x01, 0xff]);

  // TimeStampReq SEQUENCE { version, messageImprint, certReq }
  const tsqContent = Buffer.concat([version, msgImprint, certReq]);
  const tsq = Buffer.concat([Buffer.from([0x30, tsqContent.length]), tsqContent]);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // POST to FreeTSA
      const { statusCode, contentType, body } = await new Promise((resolve, reject) => {
        const url = new URL(TSA_URL);
        const options = {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/timestamp-query',
            'Content-Length': tsq.length,
          },
          timeout: TIMEOUT_MS,
        };
        const req = https.request(options, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('TSA request timed out')); });
        req.write(tsq);
        req.end();
      });

      if (statusCode !== 200) {
        throw new Error(`TSA returned HTTP ${statusCode} (${contentType})`);
      }
      if (!contentType.includes('timestamp-reply')) {
        throw new Error(`TSA returned unexpected content-type: ${contentType}`);
      }
      if (!body || body.length < 10) {
        throw new Error(`Empty TSA response (${body ? body.length : 0} bytes)`);
      }

      const tsaToken = body.toString('base64');
      console.log('[RFC3161] Timestamp obtained from FreeTSA, token size:', body.length, 'bytes (attempt', attempt + ')');
      return { success: true, tsaToken, tsaUrl: TSA_URL, tsaPolicy: TSA_POLICY, error: null };
    } catch (e) {
      lastError = e.message;
      console.warn(`[RFC3161] Attempt ${attempt}/${MAX_RETRIES} failed:`, e.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s backoff
      }
    }
  }
  console.warn('[RFC3161] All', MAX_RETRIES, 'attempts failed:', lastError);
  return { success: false, tsaToken: null, tsaUrl: TSA_URL, tsaPolicy: TSA_POLICY, error: lastError };
}

/**
 * Build a C2PA-compatible provenance manifest for a Limited Edition photo NFT.
 * C2PA (Coalition for Content Provenance and Authenticity) is backed by Adobe,
 * Microsoft, Google, BBC, Sony. This is a lightweight JSON manifest — not a
 * full binary C2PA file (which requires native SDK), but a structured record
 * that follows the C2PA claim schema and can be upgraded to full C2PA later.
 * @param {Object} params
 * @returns {Object} C2PA-compatible manifest object
 */
function buildC2PAManifest({ contentHash, exifHash, cameraSerialHash, creatorWallet, fileName, fileSize, originalFormat, originalResolution, tsaToken, tsaUrl, mintTimestamp }) {
  return {
    '@context': 'https://c2pa.org/statements/v1',
    'claim_generator': `PhotoLynk/${APP_VERSION}`,
    'title': fileName || 'PhotoLynk Certified Original',
    'format': originalFormat || 'image/jpeg',
    'instance_id': `urn:photolynk:${contentHash}`,
    'claim': {
      'dc:title': fileName || 'PhotoLynk Certified Original',
      'dc:format': originalFormat || 'image/jpeg',
      'created': mintTimestamp || new Date().toISOString(),
      'claim_generator': `PhotoLynk/${APP_VERSION} (Desktop)`,
      'assertions': [
        {
          'label': 'c2pa.hash.data',
          'data': {
            'algorithm': 'sha256',
            'hash': contentHash,
            'name': 'jumbf=c2pa.assertions/c2pa.hash.data',
          },
        },
        ...(exifHash ? [{
          'label': 'stealthlynk.hash.exif',
          'data': { 'algorithm': 'sha256', 'hash': exifHash },
        }] : []),
        ...(cameraSerialHash ? [{
          'label': 'stealthlynk.hash.camera_serial',
          'data': { 'algorithm': 'sha256', 'hash': cameraSerialHash },
        }] : []),
        {
          'label': 'c2pa.actions',
          'data': {
            'actions': [{
              'action': 'c2pa.created',
              'when': mintTimestamp || new Date().toISOString(),
              'softwareAgent': 'PhotoLynk Desktop',
            }],
          },
        },
        {
          'label': 'stealthlynk.blockchain',
          'data': {
            'chain': 'Solana',
            'creator_wallet': creatorWallet,
            'edition': 'Limited',
          },
        },
        ...(tsaToken ? [{
          'label': 'stealthlynk.rfc3161_timestamp',
          'data': {
            'tsa_url': tsaUrl,
            'tsa_token_base64': tsaToken,
            'algorithm': 'sha256',
            'hash': contentHash,
            'standard': 'RFC 3161',
          },
        }] : []),
      ],
      'signature_info': {
        'issuer': 'PhotoLynk',
        'cert_serial_number': creatorWallet,
        'time': mintTimestamp || new Date().toISOString(),
      },
    },
    'ingredients': [{
      'title': fileName || 'original',
      'format': originalFormat || 'image/jpeg',
      'instance_id': `urn:photolynk:original:${contentHash}`,
      'relationship': 'parentOf',
      'hash': { 'algorithm': 'sha256', 'value': contentHash },
      'size_bytes': fileSize || null,
      'resolution': originalResolution || null,
    }],
  };
}

// imagetracerjs for raster→SVG vector conversion
let ImageTracer = null;
try {
  ImageTracer = require('imagetracerjs');
  console.log('[NFT Desktop] imagetracerjs loaded for on-chain SVG');
} catch (e) {
  console.log('[NFT Desktop] imagetracerjs not available, on-chain SVG disabled');
}

/**
 * Convert a photo to an on-chain embeddable SVG containing a base64-encoded JPEG.
 * Preserves original image quality by embedding compressed JPEG inside SVG <image> tag.
 * Progressive size/quality reduction until the result fits under ONCHAIN_MAX_IMAGE_BYTES.
 * @param {string} filePath - Path to original image
 * @returns {Object} { success, dataUri, svgString, sizeBytes, error }
 */
async function generateOnChainImage(filePath) {
  if (!sharp) return { success: false, error: 'sharp not available' };
  try {
    // Progressive attempts: [width, jpegQuality]
    // Base64 overhead is ~33%, so target raw JPEG size = budget / 1.37
    const rawBudget = Math.floor(ONCHAIN_MAX_IMAGE_BYTES / 1.37);
    const attempts = [
      [800, 85],
      [600, 85],
      [512, 82],
      [400, 80],
      [400, 72],
      [320, 75],
      [320, 65],
      [256, 75],
      [256, 60],
      [200, 65],
      [160, 60],
      [128, 55],
      [128, 40],
    ];

    for (const [sz, quality] of attempts) {
      const jpegBuf = await sharp(filePath)
        .resize(sz, sz, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: false })
        .toBuffer();

      if (jpegBuf.length <= rawBudget) {
        const b64 = jpegBuf.toString('base64');
        // Get actual dimensions after resize
        const meta = await sharp(jpegBuf).metadata();
        const w = meta.width || sz;
        const h = meta.height || sz;
        const svgString = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="data:image/jpeg;base64,${b64}"/></svg>`;
        const svgBytes = Buffer.byteLength(svgString, 'utf8');
        const svgBase64 = Buffer.from(svgString, 'utf8').toString('base64');
        const dataUri = `data:image/svg+xml;base64,${svgBase64}`;
        console.log(`[NFT] On-chain SVG (embedded JPEG): ${w}x${h} q${quality} → ${jpegBuf.length}B jpeg, ${svgBytes}B svg`);
        return { success: true, dataUri, svgString, sizeBytes: svgBytes };
      }
      console.log(`[NFT] On-chain attempt ${sz}px q${quality}: ${jpegBuf.length}B jpeg (too large, budget ${rawBudget}B)`);
    }

    return { success: false, error: 'Image too large for on-chain embedding even at minimum quality. Try a smaller image.' };
  } catch (e) {
    return { success: false, error: e.message };
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
      nftKeyB64: Buffer.from(nftKey).toString('base64'), // raw key for metadata encryption (held in memory only)
      originalSize: plaintext.length,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Decrypt encrypted metadata JSON (matches mobile decryptMetadataJSON)
 * @param {Buffer|string} encryptedData - Encrypted metadata (Buffer or base64 string)
 * @param {Object} encryptionData - { wrappedKey, wrapNonce, metadataNonce } from local storage
 * @param {Buffer|Uint8Array} masterKey - 32-byte master key
 * @returns {Object|null} Parsed metadata object or null on failure
 */
function decryptMetadataJSON(encryptedData, encryptionData, masterKey) {
  try {
    let nacl;
    try { nacl = require('tweetnacl'); } catch (_) { return null; }
    if (!encryptedData || !encryptionData?.wrappedKey || !encryptionData?.wrapNonce || !encryptionData?.metadataNonce || !masterKey) {
      return null;
    }
    const wrappedKey = Buffer.from(encryptionData.wrappedKey, 'base64');
    const wrapNonce = Buffer.from(encryptionData.wrapNonce, 'base64');
    const nftKey = nacl.secretbox.open(new Uint8Array(wrappedKey), new Uint8Array(wrapNonce), masterKey);
    if (!nftKey) return null;
    const metadataNonce = Buffer.from(encryptionData.metadataNonce, 'base64');
    const ciphertext = (typeof encryptedData === 'string') ? Buffer.from(encryptedData, 'base64') : encryptedData;
    const plaintext = nacl.secretbox.open(new Uint8Array(ciphertext), new Uint8Array(metadataNonce), nftKey);
    if (!plaintext) return null;
    const jsonStr = Buffer.from(plaintext).toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[NFT] Metadata decryption failed:', e.message);
    return null;
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
  exifRawHash = null, exifHash = null, exifBindingHash = null,
  cameraSerialHash = null, originalFormat = null, originalResolution = null,
  creatorAddress = null, encryptionData = null, uploadMimeType = null, storageOption = null,
  tsaToken = null, tsaUrl = null, tsaPolicy = null,
  c2paManifest = null, mintTimestamp = null,
  certificationMode = null,
}) {
  const isLimited = edition === NFT_EDITION.LIMITED;
  const editionLabel = isLimited ? 'Limited' : 'Open';
  const bps = EDITION_ROYALTY_BPS[edition] || 500;
  const licenseEntry = NFT_LICENSE_OPTIONS.find(l => l.id === license);
  const licenseLabel = licenseEntry ? licenseEntry.label : 'All Rights Reserved';
  const defaultDesc = 'Certified Original — certificate of authenticity with RFC 3161 trusted timestamp and C2PA provenance';

  const metadata = {
    name: name || ('Certified Original — ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })),
    symbol: 'PLNK',
    description: description || defaultDesc,
    image: imageUrl,
    external_url: 'https://stealthlynk.io',
    attributes: [
      { trait_type: 'Edition', value: editionLabel },
      ...(contentHash ? [{ trait_type: 'Content Hash', value: `SHA256:${contentHash}` }] : []),
      ...(exifRawHash ? [{ trait_type: 'EXIF Raw Hash', value: `SHA256:${exifRawHash}` }] : []),
      ...(exifHash ? [{ trait_type: 'EXIF Hash', value: `SHA256:${exifHash}` }] : []),
      ...(exifBindingHash ? [{ trait_type: 'EXIF Binding Hash', value: `SHA256:${exifBindingHash}` }] : []),
      ...(cameraSerialHash ? [{ trait_type: 'Camera Hash', value: `SHA256:${cameraSerialHash}` }] : []),
      ...(fileSize ? [{ trait_type: 'Original Size', value: `${fileSize} bytes` }] : []),
      ...(originalFormat ? [{ trait_type: 'Original Format', value: originalFormat }] : []),
      ...(originalResolution ? [{ trait_type: 'Resolution', value: originalResolution }] : []),
      { trait_type: 'License', value: licenseLabel },
      { trait_type: 'Watermarked', value: watermarked ? 'true' : 'false' },
      { trait_type: 'Encrypted', value: encrypted ? 'true' : 'false' },
      { trait_type: 'Proof Type', value: 'Certificate of Authenticity' },
      ...(tsaToken ? [{ trait_type: 'RFC 3161 Timestamp', value: 'FreeTSA.org' }] : []),
      ...(c2paManifest ? [{ trait_type: 'C2PA Provenance', value: 'Included' }] : []),
      { trait_type: 'Storage', value: storageOption === 'cloud' ? 'StealthCloud' : storageOption === 'arweave' ? 'Arweave' : storageOption === 'onchain' ? 'Embedded SVG' : 'IPFS' },
      { trait_type: 'Minted With', value: 'PhotoLynk' },
      { trait_type: 'Platform', value: 'PhotoLynk Desktop' },
      ...(certificationMode ? [{ trait_type: 'Certification Mode', value: certificationMode === 'public' ? 'Public' : 'Private' }] : []),
    ],
    properties: {
      category: 'image',
      files: [{ uri: imageUrl, type: uploadMimeType || 'image/jpeg' }],
      creators: [{ address: creatorAddress || ownerAddress, share: 100 }],
      ...(encrypted ? { encryption: { method: 'NaCl-secretbox', encrypted: true, ...(encryptionData ? { wrappedKey: encryptionData.wrappedKey, wrapNonce: encryptionData.wrapNonce, nonce: encryptionData.nonce, ...(encryptionData.thumbnailNonce ? { thumbnailNonce: encryptionData.thumbnailNonce } : {}), ...(encryptionData.thumbnailUrl ? { thumbnailUrl: encryptionData.thumbnailUrl } : {}) } : {}) } } : {}),
      ...((true) ? {
        certificate: {
          version: 2,
          type: 'PhotoLynk Certificate of Authenticity',
          edition: editionLabel,
          mintedAt: mintTimestamp || new Date().toISOString(),
          originalHash: contentHash ? `SHA256:${contentHash}` : null,
          exifRawHash: exifRawHash ? `SHA256:${exifRawHash}` : null,
          exifHash: exifHash ? `SHA256:${exifHash}` : null,
          exifBindingHash: exifBindingHash ? `SHA256:${exifBindingHash}` : null,
          cameraSerialHash: cameraSerialHash ? `SHA256:${cameraSerialHash}` : null,
          originalFormat: originalFormat || null,
          originalResolution: originalResolution || null,
          originalSizeBytes: fileSize || null,
          creatorWallet: creatorAddress || ownerAddress,
          license: licenseLabel,
          watermarked,
          originalStorageMode: 'creator_device_only',
          ...(tsaToken ? {
            rfc3161: {
              standard: 'RFC 3161',
              tsa: tsaUrl || 'https://freetsa.org/tsr',
              tsaPolicy: tsaPolicy || null,
              tsaTokenBase64: tsaToken,
              hashAlgorithm: 'SHA-256',
              hashedContent: contentHash,
            },
          } : {}),
        },
        ...(c2paManifest ? { c2pa: c2paManifest } : {}),
      } : {}),
    },
    seller_fee_basis_points: bps,
  };
  return metadata;
}

/**
 * Compute SHA256 hash of camera serial number (device-binding proof — matches solana-seeker)
 * @param {string} filePath - Path to image file
 * @returns {Promise<string|null>} SHA256 hex hash of serial or null
 */
async function computeCameraSerialHash(filePath) {
  try {
    let serial = null;
    // Try sharp metadata first
    if (sharp) {
      try {
        const meta = await sharp(filePath).metadata();
        if (meta.exif && meta.exif.length > 0) {
          let exifReader;
          try { exifReader = require('exif-reader'); } catch (_) {}
          if (exifReader) {
            const parsed = exifReader(meta.exif);
            const exif = parsed.exif || parsed.Exif || {};
            serial = exif.BodySerialNumber || null;
          }
        }
      } catch (_) {}
    }
    // Fallback: ExifReader
    if (!serial) {
      try {
        const ExifReader = require('exifreader');
        const tags = await ExifReader.load(filePath);
        serial = tags.BodySerialNumber?.value || tags.SerialNumber?.value || tags.CameraSerialNumber?.value || null;
      } catch (_) {}
    }
    if (!serial) return null;
    const cleaned = String(serial).replace(/\0/g, '').trim();
    if (!cleaned) return null;
    return crypto.createHash('sha256').update(cleaned).digest('hex');
  } catch (e) {
    console.warn('[NFT] Camera serial hash failed:', e?.message);
    return null;
  }
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
    certificationMode = null,
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
    
    const fileSize = fs.statSync(filePath).size;
    
    // Extract EXIF and compute normalized cross-platform hash.
    // Uses parsed fields (not raw binary) so iOS/Android/desktop produce identical hashes.
    // Hash1: Raw EXIF binary hash (exact camera bytes, no parsing/rounding)
    let exifRawHash = null;
    // Hash2: Normalized EXIF hash (parsed + rounded for cross-platform dedup)
    let exifHash = null;
    // Hash3: Binding hash (cryptographically binds Hash1 + Hash2)
    let exifBindingHash = null;
    try {
      // Hash1 — exact raw binary
      exifRawHash = await computeExifRawHash(filePath);
      
      // Hash2 — normalized/rounded for cross-platform dedup
      if (sharp) {
        const imgMeta = await sharp(filePath).metadata();
        if (imgMeta.exif && imgMeta.exif.length > 0) {
          exifHash = computeExifHash(imgMeta.exif);
        }
      }
      // Fallback: use ExifReader for formats Sharp can't extract EXIF from (HEIC, RAW, etc.)
      if (!exifHash) {
        exifHash = await computeExifHashFromFile(filePath);
      }
      
      // Hash3 — binding proof
      exifBindingHash = computeExifBindingHash(exifRawHash, exifHash);
      console.log(`[NFT] EXIF 3-hash proof: raw=${exifRawHash?.substring(0, 12)}... norm=${exifHash?.substring(0, 12)}... bind=${exifBindingHash?.substring(0, 12)}...`);
    } catch (exifErr) {
      console.warn('[NFT] EXIF extraction failed:', exifErr?.message);
    }
    
    // Compute camera serial hash (device-binding proof — all editions, matches solana-seeker)
    let camSerialHash = null;
    try {
      camSerialHash = await computeCameraSerialHash(filePath);
      if (camSerialHash) console.log('[NFT] Camera serial hash:', camSerialHash.substring(0, 16) + '...');
    } catch (camErr) {
      console.warn('[NFT] Camera serial hash failed (non-blocking):', camErr?.message);
    }
    
    // Step 1: Compute content hash of ORIGINAL file for integrity proof
    onProgress?.({ status: 'Computing integrity proof...' });
    const contentHash = computeContentHash(filePath);
    const mintTimestamp = new Date().toISOString();

    // Step 1b: RFC 3161 trusted timestamp + C2PA manifest (all editions)
    let tsaResult = null;
    let c2paManifest = null;
    if (contentHash) {
      onProgress?.({ status: 'Requesting trusted timestamp (RFC 3161)...' });
      tsaResult = await requestRFC3161Timestamp(contentHash);
      if (tsaResult.success) {
        console.log('[NFT] RFC 3161 timestamp obtained');
      } else {
        console.warn('[NFT] RFC 3161 failed (non-blocking):', tsaResult.error);
      }
      c2paManifest = buildC2PAManifest({
        contentHash,
        exifHash,
        cameraSerialHash: camSerialHash,
        creatorWallet: walletAddress,
        fileName: path.basename(filePath),
        fileSize: fs.statSync(filePath).size,
        originalFormat: path.extname(filePath).replace('.', '').toUpperCase() || 'JPEG',
        originalResolution: null,
        tsaToken: tsaResult?.tsaToken || null,
        tsaUrl: tsaResult?.tsaUrl || null,
        mintTimestamp,
      });
      console.log('[NFT] C2PA manifest built');
    }

    // ========== EDITION-SPECIFIC IMAGE PROCESSING ==========
    let imageToUploadPath = uploadFilePath;
    let encryptionData = null;
    
    // Bake EXIF orientation into pixels so web viewers (Tensor, explorers) display
    // the image upright. sharp.rotate() with no args reads the EXIF Orientation tag,
    // rotates/flips the pixel data accordingly, and strips the tag from the output.
    // This MUST run after EXIF/content hashing (which need the untouched original).
    if (sharp) {
      try {
        const meta = await sharp(imageToUploadPath).metadata();
        if (meta.orientation && meta.orientation > 1) {
          const rotatedPath = path.join(os.tmpdir(), `nft_rotated_${Date.now()}.jpg`);
          await sharp(imageToUploadPath)
            .rotate()  // auto-rotate based on EXIF orientation
            .jpeg({ quality: 95, mozjpeg: false })
            .toFile(rotatedPath);
          cleanupTempFiles.push(rotatedPath);
          console.log(`[NFT] Auto-rotated image (EXIF orientation ${meta.orientation}) → ${rotatedPath}`);
          imageToUploadPath = rotatedPath;
        } else {
          console.log('[NFT] Image orientation OK (1 or absent), no rotation needed');
        }
      } catch (rotErr) {
        console.warn('[NFT] EXIF auto-rotation failed (non-blocking, using original):', rotErr?.message);
      }
    }
    
    // All editions: upload original image as-is (no resize/recompress)
    // onchain handles its own size budget in generateOnChainImage
    if (isLimited) {
      console.log('[NFT] Limited Edition: using original for on-chain embedding');
    } else {
      console.log('[NFT] Open Edition: using original image for upload');
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
    let nftKeyB64 = null; // Raw per-NFT key for metadata encryption (memory only, never persisted)
    if (encrypt && masterKey) {
      onProgress?.({ status: 'Encrypting image...' });
      console.log('[NFT] Encrypting with masterKey type:', typeof masterKey, 'length:', masterKey?.length, 'isUint8Array:', masterKey instanceof Uint8Array);
      // Ensure masterKey is a proper Uint8Array (IPC serialization can break typed arrays)
      const mk = (masterKey instanceof Uint8Array) ? masterKey : new Uint8Array(Object.values(masterKey));
      const encResult = await encryptNFTImage(imageToUploadPath, mk);
      if (encResult.success) {
        imageToUploadPath = encResult.encryptedPath;
        cleanupTempFiles.push(encResult.encryptedPath);
        nftKeyB64 = encResult.nftKeyB64; // Hold in memory for metadata encryption
        encryptionData = {
          wrappedKey: encResult.wrappedKey,
          wrapNonce: encResult.wrapNonce,
          nonce: encResult.nonce,
          originalSize: encResult.originalSize,
        };
        console.log('[NFT] Image encrypted for upload, encPath:', encResult.encryptedPath);
      } else {
        console.error('[NFT] Encryption FAILED:', encResult.error);
        return { success: false, error: 'Encryption failed: ' + encResult.error };
      }
    }
    
    // Step 2: Upload image
    onProgress?.({ status: 'Uploading image...' });
    // Detect MIME from the actual file being uploaded (may be a stripped .jpg, not the original .heic/.nef)
    const detectedMime = detectMimeType(imageToUploadPath);
    const uploadContentType = (encrypt && encryptionData) ? 'application/octet-stream' : detectedMime;
    console.log('[NFT] Storage option:', storageOption, 'ContentType:', uploadContentType);
    let imageUpload;
    let onChainDataUri = null;
    if (storageOption === 'onchain') {
      // Onchain: embed original image as data URI directly in metadata JSON.
      // No external IPFS image dependency — image is self-contained in the metadata.
      // Pinata accepts up to 256MB per file so no size reduction needed.
      console.log('[NFT] Using On-Chain storage: embedding original image as data URI');
      onProgress?.({ status: 'Embedding original image...' });
      try {
        const imgBuf = fs.readFileSync(imageToUploadPath);
        const ext = path.extname(imageToUploadPath).toLowerCase();
        const mimeMap = MIME_TYPES;
        const mime = mimeMap[ext] || uploadContentType || 'image/jpeg';
        onChainDataUri = `data:${mime};base64,${imgBuf.toString('base64')}`;
        imageUpload = { success: true, arweaveUrl: onChainDataUri, imageUrl: onChainDataUri, size: imgBuf.length };
        console.log(`[NFT] On-chain: embedded original ${imgBuf.length} bytes (${mime}) as data URI`);
      } catch (e) {
        return { success: false, error: 'On-chain image embedding failed: ' + e.message };
      }
    } else if (storageOption === 'cloud' && credentials && credentials.baseUrl && credentials.token) {
      console.log('[NFT] Using StealthCloud storage');
      imageUpload = await uploadToStealthCloud(imageToUploadPath, credentials);
      // If StealthCloud fails, fall back to IPFS
      if (!imageUpload.success) {
        console.log('[NFT] StealthCloud failed, falling back to IPFS:', imageUpload.error);
        imageUpload = await uploadToPinata(imageToUploadPath, uploadContentType);
      }
    } else if (storageOption === 'arweave') {
      console.log('[NFT] Using Arweave permanent storage (Akord)');
      onProgress?.({ status: 'Uploading to Arweave (permanent)...' });
      imageUpload = await uploadToAkordArweave(imageToUploadPath, uploadContentType);
    } else {
      console.log('[NFT] Using IPFS storage (Pinata)');
      imageUpload = await uploadToPinata(imageToUploadPath, uploadContentType);
    }
    
    if (!imageUpload.success) {
      for (const tmp of cleanupTempFiles) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} }
      return { success: false, error: 'Image upload failed: ' + imageUpload.error };
    }
    
    let imageUrl = imageUpload.imageUrl || imageUpload.arweaveUrl || imageUpload.gatewayUrl;
    console.log('[NFT] Image uploaded:', imageUrl);
    
    // Generate and upload gallery thumbnail
    // Encrypted: 50%-width encrypted thumbnail (.bin) — desktop album decrypts it for display
    // Unencrypted: plain JPEG thumbnail (matches mobile flow)
    // IPFS mode: dual thumbnail — IPFS (decentralized fallback) + StealthCloud (fast primary)
    let thumbnailUrl = null;
    let ipfsThumbnailUrl = null;
    if (credentials && credentials.baseUrl && credentials.token) {
      onProgress?.({ status: 'Creating thumbnail...' });
      if (encryptionData && nftKeyB64) {
        try {
          let nacl; try { nacl = require('tweetnacl'); } catch (_) {}
          if (nacl && sharp) {
            const meta = await sharp(filePath).metadata();
            const halfWidth = Math.round((meta.width || 800) / 2);
            const thumbBuf = await sharp(filePath).resize(halfWidth, null, { withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            console.log('[NFT] Encrypted thumbnail generated:', halfWidth, 'px wide,', thumbBuf.length, 'bytes');
            const nftKey = Buffer.from(nftKeyB64, 'base64');
            const thumbNonce = nacl.randomBytes(24);
            const thumbEnc = nacl.secretbox(new Uint8Array(thumbBuf), thumbNonce, nftKey);
            const encThumbPath = path.join(os.tmpdir(), `nft_enc_thumb_${Date.now()}.bin`);
            fs.writeFileSync(encThumbPath, Buffer.from(thumbEnc));
            cleanupTempFiles.push(encThumbPath);
            console.log('[NFT] Encrypted thumbnail:', thumbBuf.length, '→', thumbEnc.length, 'bytes');
            const thumbUpload = await uploadToStealthCloud(encThumbPath, credentials);
            if (thumbUpload.success) {
              thumbnailUrl = thumbUpload.imageUrl;
              encryptionData.thumbnailNonce = Buffer.from(thumbNonce).toString('base64');
              encryptionData.thumbnailUrl = thumbnailUrl;
              console.log('[NFT] Encrypted thumbnail stored:', thumbnailUrl);
            }
          }
        } catch (encThumbErr) {
          console.log('[NFT] Encrypted thumbnail failed (non-critical):', encThumbErr.message);
        }
      } else if (!encryptionData) {
        try {
          if (sharp) {
            const thumbBuf = await sharp(filePath).resize(400, null, { withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            const thumbPath = path.join(os.tmpdir(), `nft_thumb_${Date.now()}.jpg`);
            fs.writeFileSync(thumbPath, thumbBuf);
            cleanupTempFiles.push(thumbPath);
            const useIpfsMode = storageOption === 'ipfs' || (storageOption !== 'cloud' && storageOption !== 'arweave' && storageOption !== 'onchain');
            if (useIpfsMode && PINATA_JWT) {
              // Hybrid IPFS: dual thumbnail — IPFS (decentralized fallback) + StealthCloud (fast primary)
              // 1) Upload to IPFS (decentralized fallback + on-chain preview for Tensor/explorers)
              const thumbIpfs = await uploadToPinata(thumbPath, 'image/jpeg');
              if (thumbIpfs.success) {
                ipfsThumbnailUrl = thumbIpfs.arweaveUrl;
                console.log('[NFT] Thumbnail uploaded to IPFS:', ipfsThumbnailUrl);
              }
              // 2) Also upload to StealthCloud (fast primary for gallery)
              const thumbSC = await uploadToStealthCloud(thumbPath, credentials);
              if (thumbSC.success) {
                thumbnailUrl = thumbSC.imageUrl;
                console.log('[NFT] Thumbnail also stored on StealthCloud:', thumbnailUrl);
              }
              // Fallback: if StealthCloud failed, use IPFS as primary
              if (!thumbnailUrl) thumbnailUrl = ipfsThumbnailUrl;
            } else {
              // StealthCloud / Arweave / On-Chain: thumbnail → StealthCloud only
              const thumbUpload = await uploadToStealthCloud(thumbPath, credentials);
              if (thumbUpload.success) {
                thumbnailUrl = thumbUpload.imageUrl;
                console.log('[NFT] Thumbnail stored:', thumbnailUrl);
              }
            }
          }
        } catch (thumbErr) {
          console.log('[NFT] Thumbnail failed (non-critical):', thumbErr.message);
        }
      }
    }
    
    // Clean up temp files (best-effort)
    for (const tmp of cleanupTempFiles) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
    
    // Step 3: Build and upload metadata with edition support
    onProgress?.({ status: 'Uploading metadata...' });
    const metadata = buildNFTMetadata({
      name: name || 'Certified Original',
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
      exifRawHash,
      exifHash,
      exifBindingHash,
      cameraSerialHash: camSerialHash,
      encryptionData: encryptionData || null,
      originalFormat: path.extname(filePath).replace('.', '').toUpperCase() || 'JPEG',
      uploadMimeType: uploadContentType,
      storageOption,
      tsaToken: tsaResult?.tsaToken || null,
      tsaUrl: tsaResult?.tsaUrl || null,
      tsaPolicy: tsaResult?.tsaPolicy || null,
      c2paManifest: c2paManifest || null,
      mintTimestamp,
      certificationMode,
    });
    
    const metadataUpload = (storageOption === 'arweave')
      ? await uploadMetadataToAkordArweave(metadata, nftKeyB64)
      : await uploadMetadataToPinata(metadata, nftKeyB64);
    if (!metadataUpload.success) {
      return { success: false, error: 'Metadata upload failed: ' + metadataUpload.error };
    }
    // Save metadataNonce for later decryption
    if (metadataUpload.metadataNonce && encryptionData) {
      encryptionData.metadataNonce = metadataUpload.metadataNonce;
    }
    
    console.log('[NFT] Metadata uploaded:', metadataUpload.arweaveUrl || metadataUpload.gatewayUrl);
    
    // Free large data URI from memory — metadata is now on IPFS, transaction only needs the URL.
    // For on-chain NFTs the data URI can be multi-MB base64; replace with thumbnailUrl for gallery display.
    // (matches mobile nftOperations.js line 3252-3257)
    if (storageOption === 'onchain' && imageUrl && imageUrl.startsWith('data:')) {
      const replacement = thumbnailUrl || metadataUpload.arweaveUrl || metadataUpload.gatewayUrl;
      console.log('[NFT] Replacing on-chain data URI imageUrl with:', replacement?.slice(0, 80));
      imageUrl = replacement;
    }
    
    // Step 4: Calculate fee and open wallet for payment
    onProgress?.({ status: 'Opening wallet...' });
    
    // Use estimateNftCostsRealtime for accurate totals — Limited Edition uses dynamic fee
    const costEstimate = await estimateNftCostsRealtime({ nftType, storageOption, fileSizeBytes: fileSize, edition });
    const solPrice = costEstimate.solPrice;
    const feeUsd = costEstimate.fee.usd;
    const feeSol = costEstimate.fee.sol;
    const feeLamports = Math.ceil(feeSol * 1e9);
    const estimatedTotalSol = costEstimate.total.sol;
    const estimatedTotalUsd = costEstimate.total.usd;
    const networkSol = costEstimate.network.sol;
    const storageUsd = costEstimate.storage.usd;

    console.log('[NFT] Fee:', feeUsd, 'USD =', feeSol.toFixed(6), 'SOL =', feeLamports, 'lamports', 'edition:', edition);
    console.log('[NFT] Estimated total:', estimatedTotalUsd.toFixed(4), 'USD =', estimatedTotalSol.toFixed(6), 'SOL (network:', networkSol.toFixed(6), 'storage:', storageUsd.toFixed(4), 'USD)');
    
    // Generate unique reference for this mint
    const reference = crypto.randomBytes(32).toString('base64url');
    
    // Open local payment page in browser (where Phantom extension is installed)
    // This page will handle wallet connection and SOL transfer
    
    // For on-chain SVG, the imageUrl is a large data URI that would exceed URL length limits.
    // Register it server-side and pass a short token instead.
    let imageUrlForParam = imageUrl;
    let imageTokenForParam = '';
    if (storageOption === 'onchain' && imageUrl && imageUrl.startsWith('data:')) {
      try {
        imageTokenForParam = await new Promise((resolve, reject) => {
          const body = JSON.stringify({ dataUri: imageUrl });
          const req = http.request({ hostname: 'localhost', port: 3000, path: '/nft-image-token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data).token || ''); } catch (e) { resolve(''); } });
          });
          req.on('error', (e) => { console.warn('[NFT] Image token request error:', e.message); resolve(''); });
          req.setTimeout(8000, () => { console.warn('[NFT] Image token request timed out'); req.destroy(); resolve(''); });
          req.write(body);
          req.end();
        });
        if (imageTokenForParam) {
          imageUrlForParam = '';
          console.log('[NFT] Registered on-chain SVG as image token:', imageTokenForParam);
        } else {
          // Token registration failed — still clear the data URI to keep URL short
          // (Phantom extension won't inject on pages with extremely long URLs)
          imageUrlForParam = '';
          console.warn('[NFT] Image token registration returned empty, clearing imageUrl to keep URL short');
        }
      } catch (tokenErr) {
        console.warn('[NFT] Image token registration failed, clearing imageUrl:', tokenErr.message);
        imageUrlForParam = '';
      }
    }
    
    const paymentParams = new URLSearchParams({
      recipient: NFT_COMMISSION_WALLET,
      amount: feeSol.toFixed(9),
      feeUsd: feeUsd.toFixed(2),
      reference: reference,
      name: name || 'Certified Original',
      imageUrl: imageUrlForParam,
      ...(imageTokenForParam ? { imageToken: imageTokenForParam } : {}),
      metadataUrl: metadataUpload.arweaveUrl || metadataUpload.gatewayUrl,
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
      exifRawHash: exifRawHash || '',
      exifBindingHash: exifBindingHash || '',
      certificationMode: certificationMode || '',
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
      metadataUrl: metadataUpload.arweaveUrl || metadataUpload.gatewayUrl,
      nftType,
      feeUsd,
      feeSol,
      reference,
      encryptionData: encryptionData || null,
      thumbnailUrl: thumbnailUrl || null,
      ipfsThumbnailUrl: ipfsThumbnailUrl || null,
      // RFC 3161 + C2PA proof data (cached by renderer for generate-certificate after payment)
      tsaToken: tsaResult?.tsaToken || null,
      tsaUrl: tsaResult?.tsaUrl || null,
      tsaPolicy: tsaResult?.tsaPolicy || null,
      c2paManifest: c2paManifest || null,
      mintTimestamp: mintTimestamp || null,
      // EXIF 3-hash proof (direct fields for certificate generation)
      contentHash: contentHash || null,
      exifRawHash: exifRawHash || null,
      exifHash: exifHash || null,
      exifBindingHash: exifBindingHash || null,
      // Attributes + metadata for save-minted-nft so badges render from local storage
      attributes: metadata?.attributes || [],
      certificationMode: certificationMode || null,
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
 * Fetch on-chain metadata for a standard (non-compressed) NFT via Metaplex PDA
 * Same logic as mobile fetchNFTMetadata — derives PDA, reads account, parses URI, fetches JSON
 */
async function fetchStandardNFTMetadata(mintAddress) {
  if (!connection || !TOKEN_METADATA_PROGRAM_ID) return null;
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const metadataAccount = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      TOKEN_METADATA_PROGRAM_ID
    )[0];
    const accountInfo = await connection.getAccountInfo(metadataAccount);
    if (!accountInfo) return null;
    const data = accountInfo.data;
    let offset = 1 + 32 + 32; // key + updateAuthority + mint
    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '');
    offset += nameLen;
    const symbolLen = data.readUInt32LE(offset); offset += 4;
    offset += symbolLen;
    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '');
    if (uri) {
      try {
        const metaJson = await new Promise((resolve, reject) => {
          const u = new URL(uri.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + uri.slice(7) : uri);
          const client = u.protocol === 'https:' ? https : http;
          client.get(u.href, { timeout: 10000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              client.get(res.headers.location, { timeout: 10000 }, (res2) => {
                let d = ''; res2.on('data', c => d += c); res2.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { reject(new Error('parse')); } });
              }).on('error', reject);
              return;
            }
            let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { reject(new Error('parse')); } });
          }).on('error', reject);
        });
        return {
          name: metaJson.name || name,
          description: metaJson.description || '',
          image: metaJson.image || '',
          uri,
          attributes: metaJson.attributes || [],
          properties: metaJson.properties || {},
        };
      } catch (_) {
        return { name, uri };
      }
    }
    return { name, uri };
  } catch (e) {
    console.log(`[NFT] Metadata fetch failed for ${mintAddress}:`, e.message);
    return null;
  }
}

// Global lock: only one fetchUserNFTs runs at a time; concurrent callers await the same promise
let _fetchUserNFTsInFlight = null;

/**
 * Fetch NFTs from blockchain using DAS API (same as mobile)
 * @param {string} walletAddress - Solana wallet address
 * @param {number} limit - Max NFTs to return (default 9 for 3x3 grid)
 * @returns {Object} { success, nfts, error }
 */
function fetchUserNFTs(walletAddress, limit = 9, authHeaders = null) {
  if (!walletAddress) return Promise.resolve({ success: false, nfts: [], error: 'No wallet address' });
  if (_fetchUserNFTsInFlight) {
    console.log('[NFT] fetchUserNFTs — already in flight, waiting for existing call');
    return _fetchUserNFTsInFlight;
  }
  const run = async () => {
    try {
      return await _fetchUserNFTsImpl(walletAddress, limit, authHeaders);
    } finally {
      _fetchUserNFTsInFlight = null;
    }
  };
  _fetchUserNFTsInFlight = run();
  return _fetchUserNFTsInFlight;
}

async function _fetchUserNFTsImpl(walletAddress, limit = 9, authHeaders = null) {
  
  // Ensure Solana connection is initialized (needed for RPC fetch below)
  initializeSolana();
  
  console.log('[NFT] Fetching NFTs for wallet:', walletAddress);
  
  try {
    // 1. Fetch via DAS API (gets both standard + compressed NFTs, but may miss some standard ones)
    const nfts = await fetchNFTsFromDAS(walletAddress, limit, authHeaders);
    console.log('[NFT] DAS returned', nfts.length, 'NFTs');

    // 2. Also fetch standard NFTs via getTokenAccountsByOwner (catches ones DAS misses)
    if (solanaAvailable && connection && TOKEN_PROGRAM_ID) {
      try {
        const ownerPubkey = new PublicKey(walletAddress);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { programId: TOKEN_PROGRAM_ID });
        const nftMints = tokenAccounts.value
          .filter(a => a.account.data.parsed.info.tokenAmount.amount === '1' && a.account.data.parsed.info.tokenAmount.decimals === 0)
          .map(a => a.account.data.parsed.info.mint);
        
        // Find mints not already in DAS results
        const dasIds = new Set(nfts.map(n => (n.assetId || n.mintAddress || '').replace('cnft_', '')));
        const missing = nftMints.filter(m => !dasIds.has(m));
        
        if (missing.length > 0) {
          console.log(`[NFT] Found ${missing.length} standard NFTs not in DAS, fetching metadata...`);
          // Fetch metadata for missing standard NFTs in batches of 3
          for (let i = 0; i < missing.length; i += 3) {
            const batch = missing.slice(i, i + 3);
            const results = await Promise.all(batch.map(async (mintAddress) => {
              try {
                const metadataJson = await fetchStandardNFTMetadata(mintAddress);
                if (!metadataJson || !metadataJson.name) return null;
                const attrs = Array.isArray(metadataJson.attributes) ? metadataJson.attributes : [];
                const getAttr = (t) => { const a = attrs.find(x => x.trait_type === t); return a ? a.value : null; };
                const editionRaw = getAttr('Edition');
                const edition = editionRaw ? String(editionRaw).toLowerCase() : null;
                const encryptedFromAttr = getAttr('Encrypted') === 'true';
                const encryptedFromProps = !!(metadataJson.properties && metadataJson.properties.encryption && metadataJson.properties.encryption.encrypted);
                const encrypted = encryptedFromAttr || encryptedFromProps;
                let imgUrl = metadataJson.image || '';
                // Convert ipfs:// scheme to gateway URL (old standard NFTs use raw ipfs:// URIs)
                if (imgUrl.startsWith('ipfs://')) imgUrl = 'https://ipfs.io/ipfs/' + imgUrl.replace(/^ipfs:\/\/(ipfs\/)?/, '');
                const encProps = (metadataJson.properties && metadataJson.properties.encryption) ? metadataJson.properties.encryption : {};
                const storageAttr = getAttr('Storage');
                const storageType = storageAttr === 'StealthCloud' ? 'cloud' : storageAttr === 'Arweave' ? 'arweave' : storageAttr === 'Embedded SVG' ? 'onchain' : storageAttr === 'IPFS' ? 'ipfs' : (imgUrl.includes('stealthlynk.io') || imgUrl.includes('stealthcloud')) ? 'cloud' : imgUrl.startsWith('data:') ? 'onchain' : (imgUrl.includes('akrd.net') || imgUrl.includes('arweave.net')) ? 'arweave' : 'ipfs';
                return {
                  mintAddress,
                  assetId: mintAddress,
                  name: metadataJson.name || 'NFT',
                  description: metadataJson.description || '',
                  image: imgUrl,
                  imageUrl: imgUrl,
                  metadataUrl: metadataJson.uri || '',
                  ownerAddress: walletAddress,
                  isCompressed: false,
                  edition,
                  encrypted,
                  watermarked: getAttr('Watermarked') === 'true',
                  license: getAttr('License') || null,
                  storageType,
                  encryptionData: (encProps.wrappedKey) ? { wrappedKey: encProps.wrappedKey, wrapNonce: encProps.wrapNonce, nonce: encProps.nonce, ...(encProps.thumbnailNonce ? { thumbnailNonce: encProps.thumbnailNonce } : {}), ...(encProps.thumbnailUrl ? { thumbnailUrl: encProps.thumbnailUrl } : {}) } : null,
                  thumbnailUrl: encProps.thumbnailUrl || null,
                  attributes: attrs,
                  source: 'rpc',
                };
              } catch (_) { return null; }
            }));
            results.filter(Boolean).forEach(nft => nfts.push(nft));
            if (i + 3 < missing.length) await new Promise(r => setTimeout(r, 200));
          }
          console.log(`[NFT] After RPC merge: ${nfts.length} total NFTs`);
        }
      } catch (rpcErr) {
        console.log('[NFT] Standard NFT RPC fetch failed (non-critical):', rpcErr.message);
      }
    }

    console.log('[NFT] Found', nfts.length, 'NFTs');
    return { success: true, nfts };
  } catch (e) {
    console.error('[NFT] Fetch failed:', e.message);
    return { success: false, nfts: [], error: e.message };
  }
}

// Persist DAS cache to disk
const DAS_CACHE_FILE = path.join(userDataPath, 'nft_das_cache.json');

function saveDasCache(total, ts) {
  try {
    fs.writeFileSync(DAS_CACHE_FILE, JSON.stringify({ total, ts }));
  } catch (_) {}
}

function loadDasCache() {
  try {
    if (fs.existsSync(DAS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAS_CACHE_FILE, 'utf8'));
      _lastDasTotal = data.total;
      _lastDasTotalTs = data.ts;
      console.log(`[DAS] Restored cache from disk: total=${_lastDasTotal}, age=${Math.round((Date.now() - _lastDasTotalTs)/1000)}s`);
    }
  } catch (_) {}
}

function invalidateDasCache() {
  console.log('[NFT] Invalidating DAS cache (force refresh next scan)');
  _lastDasForceRefresh = true;
}

// DAS total-check cache: skip full pagination if total hasn't changed (1 call vs ~24)
let _lastDasTotal = null;       // Last known total from DAS page 1
let _lastDasTotalTs = 0;        // Timestamp of last total check
let _lastDasForceRefresh = false; // Set to true after mint to force full re-scan

loadDasCache();

// Global lock: only one fetchNFTsFromDAS runs at a time; concurrent callers await the same promise
let _dasInFlight = null;

/**
 * Fetch NFTs using Solana DAS (Digital Asset Standard) API
 * Same implementation as mobile app's fetchCompressedNFTs
 */
async function fetchNFTsFromDAS(walletAddress, limit = 9, authHeaders = null) {
  // Global lock: if another DAS fetch is already running, piggyback on it
  if (_dasInFlight) {
    console.log('[DAS] fetchNFTsFromDAS — already in flight, waiting for existing call');
    return _dasInFlight;
  }

  const run = async () => {
    try {
      return await _fetchNFTsFromDASImpl(walletAddress, limit, authHeaders);
    } finally {
      _dasInFlight = null;
    }
  };
  _dasInFlight = run();
  return _dasInFlight;
}

async function _fetchNFTsFromDASImpl(walletAddress, limit = 9, authHeaders = null) {
  let pageSize = 20; // Start small — auto-halves on "Response is too big"
  const MIN_PAGE_SIZE = 5;
  const MAX_PAGES = 50; // Desktop has no OOM concerns, fetch everything

  // Cooldown: if DAS was called recently (within 5 min) AND returned results, skip unless force-refreshing
  const forceRefresh = _lastDasForceRefresh;
  if (forceRefresh) _lastDasForceRefresh = false;
  if (!forceRefresh && _lastDasTotalTs && _lastDasTotal > 0 && Date.now() - _lastDasTotalTs < 300000) {
    console.log(`[DAS] Called ${Math.round((Date.now() - _lastDasTotalTs) / 1000)}s ago with ${_lastDasTotal} results, skipping (cooldown 300s)`);
    return [];
  }

  // Early exit: if local NFT count matches cached DAS total, skip API call entirely (0 calls)
  if (!forceRefresh && _lastDasTotal !== null && _lastDasTotal > 0 && Date.now() - _lastDasTotalTs < 900000) {
    try {
      const localNFTs = await getStoredNFTs();
      if (localNFTs.length >= _lastDasTotal) {
        console.log(`[DAS] Local NFTs (${localNFTs.length}) >= cached DAS total (${_lastDasTotal}), skipping API call`);
        return [];
      }
    } catch (_) {}
  }

  const buildDasUrls = () => {
    const urls = [];
    // Server DAS proxy first (30s server-side cache, avoids rate limits)
    urls.push({ name: 'server-proxy', url: 'http://localhost:3000/api/nft-service/das-proxy', isProxy: true });
    // Helius direct fallback
    if (process.env.HELIUS_API_KEY) {
      urls.push({ name: 'helius-1', url: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` });
    }
    if (process.env.HELIUS_API_KEY_2) {
      urls.push({ name: 'helius-2', url: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY_2}` });
    }
    return urls;
  };

  const requestPage = (endpoint, page, pgSize) => new Promise((resolve) => {
    const dasParams = { ownerAddress: walletAddress, page, limit: pgSize };
    const body = endpoint.isProxy
      ? JSON.stringify({ method: 'getAssetsByOwner', params: dasParams })
      : JSON.stringify({ jsonrpc: '2.0', id: 'photolynk-desktop-nft-fetch', method: 'getAssetsByOwner', params: dasParams });
    const u = new URL(endpoint.url);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (endpoint.isProxy && authHeaders) {
      Object.assign(reqHeaders, authHeaders);
    }

    const options = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: reqHeaders,
      timeout: 30000,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          console.error(`[DAS] ${endpoint.name} HTTP ${res.statusCode}: ${String(data).slice(0, 200)}`);
          resolve({ ok: false, items: [], errorCode: res.statusCode });
          return;
        }
        let json;
        try { json = JSON.parse(data); } catch (e) {
          console.error(`[DAS] ${endpoint.name} non-JSON response: ${String(data).slice(0, 200)}`);
          resolve({ ok: false, items: [] });
          return;
        }
        if (json?.error) {
          resolve({ ok: false, items: [], errorCode: json.error.code, errorMsg: json.error.message });
          return;
        }
        const items = json?.result?.items;
        if (!Array.isArray(items)) {
          console.error(`[DAS] ${endpoint.name} missing result.items`);
          resolve({ ok: false, items: [] });
          return;
        }
        const total = json?.result?.total || items.length;
        resolve({ ok: true, items, total });
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
    req.write(body);
    req.end();
  });

  // Find a working endpoint and paginate with auto-halve on "Response is too big"
  const endpoints = buildDasUrls();
  let items = [];
  for (const endpoint of endpoints) {
    let dasPage = 1;
    let found = false;
    let rateLimitRetries = 0;
    while (dasPage <= MAX_PAGES) {
      console.log(`[DAS] page ${dasPage} (limit=${pageSize})...`);
      const result = await requestPage(endpoint, dasPage, pageSize);

      // DAS total-check: after page 1 succeeds, compare total to last known
      if (result.ok && dasPage === 1 && !forceRefresh && _lastDasTotal !== null) {
        const currentTotal = result.total || 0;
        if (currentTotal === _lastDasTotal) {
          console.log(`[DAS] Total unchanged (${currentTotal}), skipping full pagination`);
          _lastDasTotalTs = Date.now();
          saveDasCache(_lastDasTotal, _lastDasTotalTs);
          return []; // No new NFTs — local storage is already up to date
        }
        console.log(`[DAS] Total changed: ${_lastDasTotal} → ${currentTotal}, doing full scan`);
      }

      if (!result.ok) {
        // Rate limited (429) — wait and retry with exponential backoff
        if ((result.errorCode === 429 || result.errorCode === -32429) && rateLimitRetries < 3) {
          const backoff = Math.min(30000, (rateLimitRetries + 1) * 10000); // 10s, 20s, 30s
          rateLimitRetries++;
          console.log(`[DAS] Rate limited, retrying in ${backoff / 1000}s (attempt ${rateLimitRetries}/3)`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        // "Response is too big" (-32702) — halve page size and retry same page
        if (result.errorCode === -32702 && pageSize > MIN_PAGE_SIZE) {
          pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
          console.log(`[DAS] Response too big, reducing page size to ${pageSize} and retrying`);
          continue;
        }
        // At minimum page size and still too big — skip this page (giant on-chain SVG)
        if (result.errorCode === -32702 && pageSize <= MIN_PAGE_SIZE) {
          console.log(`[DAS] Page ${dasPage} has oversized NFT (>20MB), skipping`);
          dasPage++;
          continue;
        }
        // Other error on first page — try next endpoint
        if (!found) break;
        // Other error on later page — stop pagination
        break;
      }
      rateLimitRetries = 0; // Reset on success

      found = true;
      if (result.items.length === 0) break;
      console.log(`[DAS] Page ${dasPage}: ${result.items.length} items`);
      items.push(...result.items);
      if (result.items.length < pageSize) break; // Last page
      dasPage++;
    }
    if (found) break; // Got results from this endpoint
  }

  if (!items.length) {
    // Don't set cooldown on failure — allow immediate retry
    return [];
  }
  // Update cached total for next check — only after successful fetch with results
  _lastDasTotal = items.length;
  _lastDasTotalTs = Date.now();
  saveDasCache(_lastDasTotal, _lastDasTotalTs);
  console.log(`[DAS] Total assets fetched: ${items.length}`);

  // Process a single DAS item into an NFT object
  const processItem = async (item) => {
    let imageUrl = item.content?.links?.image ||
                  item.content?.files?.[0]?.uri ||
                  '';
    if (imageUrl && imageUrl.startsWith('ipfs://')) imageUrl = 'https://ipfs.io/ipfs/' + imageUrl.slice(7);
    const metadataUrl = item.content?.json_uri || '';
    const isCompressed = item.compression?.compressed === true;
    let cachedImagePath = null;
    const metadataCid = extractIPFSCid(metadataUrl);

    // CHECK CACHE FIRST - try to find cached image before any network calls
    let cid = extractCacheKey(imageUrl);
    if (cid && cacheDir) {
      cachedImagePath = getCachedImagePath(cid);
      if (cachedImagePath) {
        console.log('[NFT Cache] Using cached image for', cid.slice(0, 8));
      }
    }

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

    // Always fetch full metadata JSON from json_uri (matches mobile fetchCompressedNFTs).
    // Encrypted metadata will fail JSON parse — that's a detection signal.
    let metadataJson = null;
    const dasAttrs = item.content?.metadata?.attributes || [];
    let metadataFetchFailed = false;
    if (metadataUrl) {
      // Always fetch full metadata — it contains encryption keys, Storage attribute,
      // and other critical cross-device data that DAS doesn't inline
      metadataJson = await fetchFullMetadata(metadataUrl, isCompressed);
      if (metadataJson) {
        if (!imageUrl && metadataJson.image) {
          imageUrl = metadataJson.image;
          if (imageUrl.startsWith('ipfs://')) imageUrl = 'https://ipfs.io/ipfs/' + imageUrl.slice(7);
          cid = extractCacheKey(imageUrl);
          if (metadataCid && cid) cacheMetadataMapping(metadataCid, cid);
          if (cid && cacheDir) {
            cachedImagePath = getCachedImagePath(cid);
            if (cachedImagePath) console.log('[NFT Cache] Using cached image for', cid.slice(0, 8));
          }
        }
      } else {
        metadataFetchFailed = true;
      }
    }

    const attrs = (metadataJson && Array.isArray(metadataJson.attributes)) ? metadataJson.attributes : dasAttrs;
    const getAttr = (traitName) => {
      const a = attrs.find(at => at.trait_type === traitName);
      return a ? a.value : null;
    };
    const editionRaw = getAttr('Edition');
    const edition = editionRaw ? String(editionRaw).toLowerCase() : null;
    // Extract encryption keys from metadata properties (matches mobile)
    const encProps = (metadataJson && metadataJson.properties && metadataJson.properties.encryption) ? metadataJson.properties.encryption : {};
    const encryptedFromAttr = getAttr('Encrypted') === 'true';
    const encryptedFromFileType = (item.content?.files?.[0]?.mime === 'application/octet-stream') || (item.content?.files?.[0]?.type === 'application/octet-stream');
    const encryptedFromProps = !!(encProps.encrypted);
    const encryptedFromKeys = !!(encProps.wrappedKey && encProps.nonce && encProps.wrapNonce);
    // Heuristic: metadata fetch returned non-JSON AND DAS has no inline attributes → encrypted
    const encryptedFromHeuristic = metadataFetchFailed && dasAttrs.length === 0;
    const encrypted = encryptedFromAttr || encryptedFromFileType || encryptedFromProps || encryptedFromKeys || encryptedFromHeuristic;
    const watermarked = getAttr('Watermarked') === 'true';
    const license = getAttr('License') || null;

    // Don't cache encrypted .bin files as images — they can't render
    if (encrypted && cachedImagePath) {
      cachedImagePath = null;
    }

    // Cache image if not cached yet (skip encrypted blobs)
    if (!encrypted && !cachedImagePath && cid && cacheDir && imageUrl) {
      const cacheHeaders = {};
      if (imageUrl.includes('stealthlynk.io') && authHeaders) {
        Object.assign(cacheHeaders, authHeaders);
      }
      if (imageUrl.includes('stealthlynk.io')) {
        try {
          cachedImagePath = await cacheImage(imageUrl, cid, cacheHeaders);
        } catch (_) {}
      } else {
        cacheImage(imageUrl, cid, cacheHeaders).catch(() => {});
      }
    }
    // Read on-chain Storage attribute (authoritative for cross-device detection), fall back to URL-based detection
    const storageAttr = getAttr('Storage');
    const storageType = storageAttr === 'StealthCloud' ? 'cloud' : storageAttr === 'Arweave' ? 'arweave' : storageAttr === 'Embedded SVG' ? 'onchain' : storageAttr === 'IPFS' ? 'ipfs' : (imageUrl && (imageUrl.includes('stealthlynk.io') || imageUrl.includes('stealthcloud'))) ? 'cloud' : (imageUrl && imageUrl.startsWith('data:')) ? 'onchain' : (imageUrl && (imageUrl.includes('akrd.net') || imageUrl.includes('arweave.net'))) ? 'arweave' : 'ipfs';
    return {
      mintAddress: isCompressed ? `cnft_${item.id}` : item.id,
      assetId: item.id,
      name: item.content?.metadata?.name || 'NFT',
      description: item.content?.metadata?.description || '',
      image: cachedImagePath || imageUrl,
      imageUrl: imageUrl,
      cachedPath: cachedImagePath,
      metadataUrl: metadataUrl,
      ownerAddress: walletAddress,
      isCompressed: isCompressed,
      merkleTree: item.compression?.tree || null,
      edition: edition,
      encrypted: encrypted,
      watermarked: watermarked,
      license: license,
      storageType: storageType,
      // Extract encryption keys + thumbnail info from metadata props (cross-device discovery)
      encryptionData: encryptedFromKeys ? { wrappedKey: encProps.wrappedKey, wrapNonce: encProps.wrapNonce, nonce: encProps.nonce, ...(encProps.thumbnailNonce ? { thumbnailNonce: encProps.thumbnailNonce } : {}), ...(encProps.thumbnailUrl ? { thumbnailUrl: encProps.thumbnailUrl } : {}) } : null,
      thumbnailUrl: encProps.thumbnailUrl || null,
      attributes: attrs,
      metadata: metadataJson ? { uri: metadataUrl, attributes: attrs, properties: metadataJson.properties || {} } : null,
      hasRfc3161: !!(metadataJson?.properties?.certificate?.rfc3161?.tsaTokenBase64),
      hasC2pa: !!(metadataJson?.properties?.c2pa),
      createdAt: item.created_at || null,
      source: 'das',
    };
  };

  // Process items in parallel batches of 3 (avoid 429 rate limits on IPFS gateways)
  const itemsToProcess = items.slice(0, limit);
  const nfts = [];
  for (let i = 0; i < itemsToProcess.length; i += 5) {
    const batch = itemsToProcess.slice(i, i + 5);
    const results = await Promise.all(batch.map(processItem));
    nfts.push(...results);
    if (i + 5 < itemsToProcess.length) {
      await new Promise(r => setTimeout(r, 100));
    }
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
    const req = protocol.get(url, { timeout: 8000 }, (res) => {
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
// Negative cache: metadata URLs that returned non-JSON (encrypted) — avoid re-fetching through 3+ gateways
const _metadataNegativeCache = {};
const _METADATA_NEG_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchFullMetadata(metadataUrl, isCompressed = false) {
  if (!metadataUrl) return null;
  
  const cid = extractIPFSCid(metadataUrl);
  const cacheKey = cid || metadataUrl;
  
  // Check negative cache — skip network calls for known-encrypted metadata
  if (_metadataNegativeCache[cacheKey] && (Date.now() - _metadataNegativeCache[cacheKey]) < _METADATA_NEG_CACHE_TTL) {
    return null;
  }
  
  const gatewayList = isCompressed ? CNFT_IPFS_GATEWAYS : IPFS_GATEWAYS;
  const gateways = cid ? gatewayList.map(g => g + cid) : [metadataUrl];
  
  let sawNonJson = false;
  for (const gateway of gateways) {
    try {
      console.log('[NFT] Trying metadata gateway:', gateway.slice(0, 50));
      const result = await fetchWithRedirects(gateway);
      
      if (result.ok && result.data) {
        try {
          const json = JSON.parse(result.data);
          if (json.image) {
            console.log('[NFT] Got image from metadata:', json.image.slice(0, 60));
          }
          // Clear negative cache on success
          delete _metadataNegativeCache[cacheKey];
          return json;
        } catch (e) {
          // Not valid JSON — likely encrypted metadata
          console.log('[NFT] Metadata at', gateway.slice(0, 50), 'is not JSON (likely encrypted)');
          sawNonJson = true;
          break; // No point trying other gateways — same CID will be non-JSON everywhere
        }
      }
    } catch (e) {
      console.log('[NFT] Gateway failed:', e.message);
    }
  }
  
  // Cache negative result so we don't re-fetch encrypted metadata on next scan
  if (sawNonJson) {
    _metadataNegativeCache[cacheKey] = Date.now();
  }
  
  return null;
}

async function fetchImageFromMetadata(metadataUrl, isCompressed = false) {
  const json = await fetchFullMetadata(metadataUrl, isCompressed);
  return json?.image || '';
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
    title: 'Certify Original',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });
  
  const fees = getCurrentFees();
  const promo = isPromoActive();
  const promoDays = getPromoDaysRemaining();
  
  const html = generateNFTMintHTML(fees, promo, promoDays, credentials);
  // Write HTML to temp file and load via file:// — data: URLs cause NSOpenPanel to freeze on macOS
  const tmpMintPath = path.join(os.tmpdir(), 'photolynk-mint.html');
  fs.writeFileSync(tmpMintPath, html, 'utf8');
  mintWindow.loadFile(tmpMintPath);
  
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
  <title>Certify Original</title>
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
    <h1><span>🛡️</span> Certify Original</h1>
    <button class="close-btn" onclick="window.close()">✕</button>
  </div>
  
  ${promo ? `<div class="promo-banner">
    <h3>🎉 Launch Special - ${promoDays} Days Left!</h3>
    <p>Up to 90% off certification fees!</p>
  </div>` : ''}
  
  <div class="section">
    <div class="section-title">PROOF TYPE</div>
    <div class="card">
      <div class="option selected" onclick="selectType('compressed', this)" data-type="compressed">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">Compressed Proof (cNFT)</div>
          <div class="option-subtitle">99.99% cheaper · Same cryptographic anchor · Recommended</div>
        </div>
        <div class="option-price" id="compressed-price">$${cnftCloudTotal.toFixed(2)}</div>
      </div>
      <div class="option" onclick="selectType('standard', this)" data-type="standard">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">Standard Proof</div>
          <div class="option-subtitle">Full on-chain anchor · Higher permanence cost</div>
        </div>
        <div class="option-price" id="standard-price">$${nftCloudTotal.toFixed(2)}</div>
      </div>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">IMAGE STORAGE</div>
    <div class="card">
      <div class="option" onclick="selectStorage('cloud', this)" data-storage="cloud">
        <div class="option-radio"></div>
        <div class="option-text">
          <div class="option-title">StealthCloud</div>
          <div class="option-subtitle" id="cloud-subtitle">Free storage • $${cnftCloudFee.toFixed(2)} fee</div>
        </div>
        <div class="option-price" id="cloud-price">$${cnftCloudTotal.toFixed(2)}</div>
      </div>
      <div class="option selected" onclick="selectStorage('ipfs', this)" data-storage="ipfs">
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
    <div class="section-title">PROOF DETAILS</div>
    <div class="card">
      <div class="input-group">
        <label>Name</label>
        <input type="text" id="nft-name" placeholder="Certified Original">
      </div>
      <div class="input-group">
        <label>Description (optional)</label>
        <textarea id="nft-description" placeholder="Description of the certified original..."></textarea>
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
    <span>🛡️</span> Certify Original
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
    let selectedStorage = 'ipfs';      // 'ipfs' or 'cloud' (default matches inline panel: Private = IPFS)
    let selectedPhoto = null;
    let walletAddress = null;
    let isMinting = false;
    let stripExif = false;             // Privacy option to remove EXIF metadata
    let certificationMode = 'private'; // 'private' (encrypted) or 'public'
    let encrypt = true;                // Private mode: always encrypted (matches inline panel default)
    let edition = 'open';              // 'open' or 'limited'
    let license = 'arr';              // All Rights Reserved by default
    let watermark = false;
    
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
    
    let _filePickerOpen = false;
    async function selectPhoto() {
      // Guard against multiple simultaneous file pickers
      if (_filePickerOpen) return;
      _filePickerOpen = true;
      try {
        const filePath = await new Promise((resolve) => {
          let resolved = false;
          const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.style.display = 'none';
          input.onchange = () => {
            if (input.files && input.files.length > 0) {
              done(input.files[0].path || null);
            } else {
              done(null);
            }
            input.remove();
          };
          input.addEventListener('cancel', () => { done(null); input.remove(); });
          document.body.appendChild(input);
          input.click();
          setTimeout(() => { done(null); try { input.remove(); } catch(_){} }, 120000);
        });
        if (filePath) {
          selectedPhoto = filePath;
          document.getElementById('preview-img').src = 'http://localhost:3000/local-image?path=' + encodeURIComponent(filePath);
          document.querySelector('.photo-select').style.display = 'none';
          document.getElementById('photo-preview').style.display = 'block';
          // Auto-populate name from filename
          const nameInput = document.getElementById('nft-name');
          if (nameInput && !nameInput.value.trim()) {
            const baseName = filePath.split('/').pop().replace(/\\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
            if (baseName) nameInput.value = baseName;
          }
          updateMintButton();
        }
      } catch (e) {
        console.error('selectPhoto error:', e);
      } finally {
        _filePickerOpen = false;
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
        btn.innerHTML = '<span>🛡️</span> Certify Original ($' + parseFloat(price).toFixed(2) + ')';
      }
    }
    
    async function mintNFT() {
      if (isMinting) return;
      isMinting = true;
      
      const btn = document.getElementById('mint-btn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span> Certifying...';
      
      const name = document.getElementById('nft-name').value || 'Certified Original';
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
          edition: edition,             // 'open' or 'limited'
          license: license,             // License type (e.g. 'arr', 'cc-by', etc.)
          watermark: watermark,         // Whether to apply watermark
          encrypt: encrypt,             // Whether to encrypt (true for Private mode)
          certificationMode: certificationMode, // 'private' or 'public'
        });
        
        if (result.success) {
          btn.innerHTML = '<span>✓</span> Certified!';
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
    title: 'Photo Album',
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
  <title>Photo Album</title>
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
    <h1>Photo Album</h1>
    <div class="header-actions">
      <button class="header-btn" onclick="refreshAlbum()" title="Refresh">↻</button>
      <button class="header-btn" onclick="window.close()" title="Close">✕</button>
    </div>
  </div>
  
  <div id="content">
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <span>Loading proofs...</span>
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
      
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading proofs...</span></div>';
      
      const result = await ipcRenderer.invoke('fetch-user-nfts', walletAddress, 9);
      
      if (result.success && result.nfts.length > 0) {
        nfts = result.nfts;
        renderGrid();
      } else if (result.nfts.length === 0) {
        showEmpty();
      } else {
        document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">Failed to load proofs</div><div class="empty-hint">' + (result.error || 'Try again later') + '</div></div>';
      }
    }
    
    function renderGrid() {
      let html = '<div class="grid">';
      nfts.forEach((nft, i) => {
        const imgUrl = nft.image || nft.imageUrl || '';
        const name = nft.name || 'Proof #' + (i + 1);
        html += '<div class="nft-item" onclick="openNFT(' + i + ')">';
        html += '<img src="' + imgUrl + '" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%231a1a1a%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23888%22 font-size=%2230%22>⬡</text></svg>\\'">';
        html += '<div class="nft-item-overlay"><div class="nft-item-name">' + name + '</div></div>';
        html += '</div>';
      });
      html += '</div>';
      document.getElementById('content').innerHTML = html;
    }
    
    function showEmpty() {
      document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-icon">🛡️</div><div class="empty-text">No proofs yet</div><div class="empty-hint">Certify your first original!</div></div>';
    }
    
    function showConnectPrompt() {
      document.getElementById('content').innerHTML = '<div class="connect-prompt"><div class="empty-icon" style="font-size: 48px; margin-bottom: 16px;">🔗</div><p style="color: var(--text-muted); margin-bottom: 20px;">Connect your wallet to view proofs</p><button class="connect-btn" onclick="connectWallet()">Connect Wallet</button></div>';
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
      const changed = walletAddress && walletAddress !== address;
      walletAddress = address;
      if (changed) {
        // Wallet switched: purge old NFTs and reload
        nfts = [];
        ipcRenderer.invoke('purge-nft-storage').catch(() => {});
      }
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
    const all = JSON.parse(data) || [];
    // Dedup by mintAddress as safety net (in case duplicates crept in)
    const seen = new Set();
    return all.filter(n => {
      const id = n && (n.mintAddress || n.assetId);
      if (!id) return true; // keep entries without id
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  } catch (e) {
    console.error('[NFT Storage] Read failed:', e.message);
    return [];
  }
}

async function saveNFTToStorage(nftData, serverUrl = null, authHeaders = null) {
  try {
    const existing = await getStoredNFTs();
    const id = nftData && (nftData.mintAddress || nftData.assetId);
    if (id) {
      const idx = existing.findIndex(n => (n.mintAddress || n.assetId) === id);
      if (idx >= 0) {
        // Update existing entry instead of duplicating
        existing[idx] = { ...existing[idx], ...nftData };
        console.log('[NFT Storage] Updated existing:', id);
      } else {
        existing.push(nftData);
        console.log('[NFT Storage] Saved new:', id);
      }
    } else {
      existing.push(nftData);
      console.log('[NFT Storage] Saved (no id):', nftData.name);
    }
    fs.writeFileSync(nftStorageFile, JSON.stringify(existing, null, 2));
    
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

async function bulkSaveNFTs(nfts) {
  if (!nftStorageFile || !Array.isArray(nfts) || nfts.length === 0) return;
  try {
    // First pass: build metadataUrl → index map so we can merge cnft_tx_ with real entries
    const byMeta = {};  // metadataUrl → array index in result
    const result = [];
    
    for (const n of nfts) {
      const id = n && (n.mintAddress || n.assetId);
      if (!id) continue;
      
      const isTxOnly = id.startsWith('cnft_tx_') || id.startsWith('tx_');
      const hasRealId = !isTxOnly && id.length > 20;
      
      if (n.metadataUrl && byMeta[n.metadataUrl] !== undefined) {
        const existingIdx = byMeta[n.metadataUrl];
        const existing = result[existingIdx];
        const existingId = existing && (existing.mintAddress || existing.assetId);
        const existingIsTx = existingId && (existingId.startsWith('cnft_tx_') || existingId.startsWith('tx_'));
        
        if (existingIsTx && hasRealId) {
          // Replace cnft_tx_ entry with real asset ID entry, preserving local fields
          result[existingIdx] = { ...existing, ...n, mintAddress: n.mintAddress, assetId: n.assetId };
          console.log('[NFT Storage] Replaced cnft_tx_ with real asset ID:', n.assetId || n.mintAddress);
          continue;
        } else if (isTxOnly && !existingIsTx) {
          // Skip tx_ entry if real entry already exists
          continue;
        }
        // Same-type duplicate — skip
        continue;
      }
      
      if (n.metadataUrl) byMeta[n.metadataUrl] = result.length;
      result.push(n);
    }
    
    // Dedup by mintAddress (safety net)
    const seenIds = new Set();
    const clean = result.filter(n => {
      const id = n && (n.mintAddress || n.assetId);
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    }).map(n => {
      const copy = { ...n };
      if (copy.imageBase64) delete copy.imageBase64;
      if (copy.thumbnailBase64) delete copy.thumbnailBase64;
      return copy;
    });
    fs.writeFileSync(nftStorageFile, JSON.stringify(clean, null, 2));
    console.log('[NFT Storage] Bulk saved', clean.length, 'NFTs');
  } catch (e) {
    console.error('[NFT Storage] Bulk save failed:', e.message);
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
    let merged = 0;
    
    // Build lookup maps by mintAddress AND metadataUrl (cNFT IDs may differ: cnft_tx_<sig> vs cnft_<assetId>)
    const localByMint = {};
    const localByMeta = {};
    localNFTs.forEach((n, i) => {
      if (n.mintAddress) localByMint[n.mintAddress] = i;
      if (n.metadataUrl) localByMeta[n.metadataUrl] = i;
    });
    
    for (const serverNFT of serverNFTs) {
      // Match by mintAddress first, then by metadataUrl (cross-device ID mismatch)
      let idx = serverNFT.mintAddress ? localByMint[serverNFT.mintAddress] : undefined;
      if (idx === undefined && serverNFT.metadataUrl) idx = localByMeta[serverNFT.metadataUrl];
      
      if (idx === undefined) {
        localNFTs.push(serverNFT);
        if (serverNFT.mintAddress) localByMint[serverNFT.mintAddress] = localNFTs.length - 1;
        if (serverNFT.metadataUrl) localByMeta[serverNFT.metadataUrl] = localNFTs.length - 1;
        merged++;
      } else {
        // Merge missing fields from server into local (cross-platform encryptionData, edition, etc.)
        const local = localNFTs[idx];
        // If local has cnft_tx_ (only tx sig) and server has real asset ID, update it
        if (local.mintAddress && local.mintAddress.startsWith('cnft_tx_') && serverNFT.assetId && !serverNFT.assetId.startsWith('tx_')) {
          local.mintAddress = serverNFT.mintAddress || ('cnft_' + serverNFT.assetId);
          local.assetId = serverNFT.assetId;
          console.log('[NFT Storage] Updated cnft_tx_ entry with real asset ID:', serverNFT.assetId);
          merged++;
        }
        if (serverNFT.assetId && !local.assetId) { local.assetId = serverNFT.assetId; merged++; }
        // Always overwrite encryptionData and thumbnailUrl — critical for cross-device encrypted NFTs
        if (serverNFT.encryptionData && !local.encryptionData) { local.encryptionData = serverNFT.encryptionData; merged++; }
        if (serverNFT.thumbnailUrl && !local.thumbnailUrl) { local.thumbnailUrl = serverNFT.thumbnailUrl; merged++; }
        if (serverNFT.edition && !local.edition) { local.edition = serverNFT.edition; merged++; }
        if (serverNFT.encrypted && !local.encrypted) { local.encrypted = serverNFT.encrypted; merged++; }
        if (serverNFT.watermarked && !local.watermarked) { local.watermarked = serverNFT.watermarked; merged++; }
        if (serverNFT.license && !local.license) { local.license = serverNFT.license; merged++; }
        if (serverNFT.storageType && (!local.storageType || (local.storageType === 'ipfs' && serverNFT.storageType !== 'ipfs'))) { local.storageType = serverNFT.storageType; merged++; }
      }
    }
    
    if (merged > 0) {
      fs.writeFileSync(nftStorageFile, JSON.stringify(localNFTs, null, 2));
      console.log('[NFT Storage] Merged/updated', merged, 'NFTs from server');
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
      
      // Use DAS API for real asset ID - route through proxy with Helius fallback
      const assetId = mintAddress.replace('cnft_', '');
      
      // Try proxy first
      const tryProxy = () => new Promise((resolve) => {
        const postData = JSON.stringify({ method: 'getAsset', params: { id: assetId } });
        const req = http.request({
          hostname: 'localhost', port: 3000, path: '/api/nft-service/das-proxy', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.result?.id) {
                resolve({ verified: true, exists: true, owner: json.result.ownership?.owner, compressed: true });
              } else {
                resolve(null); // Try fallback
              }
            } catch (e) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null)); // Try fallback
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(postData);
        req.end();
      });
      
      // Try Helius direct fallback
      const tryHelius = (apiKey) => new Promise((resolve) => {
        const postData = JSON.stringify({
          jsonrpc: '2.0', id: 'verify-cnft', method: 'getAsset', params: { id: assetId }
        });
        const req = https.request({
          hostname: 'mainnet.helius-rpc.com', port: 443, path: `/?api-key=${apiKey}`, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.result?.id) {
                resolve({ verified: true, exists: true, owner: json.result.ownership?.owner, compressed: true });
              } else {
                resolve(null);
              }
            } catch (e) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(postData);
        req.end();
      });
      
      // Try proxy first, then fallback to Helius keys
      let result = await tryProxy();
      if (!result && process.env.HELIUS_API_KEY) result = await tryHelius(process.env.HELIUS_API_KEY);
      if (!result && process.env.HELIUS_API_KEY_2) result = await tryHelius(process.env.HELIUS_API_KEY_2);
      
      return result || { verified: false, error: 'Asset not found or rate limited' };
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
 * Generate a Certificate of Authenticity JSON for a certified NFT (all editions)
 */
function generateCertificate(nftData) {
  if (!nftData) return null;
  // Only generate certificates for NFTs created within the PhotoLynk ecosystem
  // External NFTs (Bored Apes, DeGods, etc.) must never get PhotoLynk proofs
  if (!nftData.forceGenerate && !isPhotoLynkEcosystem(nftData)) return null;
  // Never generate certs for temporary tx_ entries — wait for real cnft_ ID
  // (unless forceGenerate is set, which is used by the post-mint path where we know it's a real mint)
  if (!nftData.forceGenerate && nftData.mintAddress && String(nftData.mintAddress).startsWith('tx_')) return null;
  const cert = {
    id: `cert_${nftData.mintAddress || Date.now()}`,
    version: 1,
    type: 'PhotoLynk Certificate of Authenticity',
    edition: nftData.edition || 'limited',
    certificationMode: nftData.certificationMode || (nftData.edition === 'limited' ? 'private' : nftData.edition === 'open' ? 'public' : null),
    mintAddress: nftData.mintAddress,
    txSignature: nftData.txSignature,
    creatorWallet: nftData.ownerAddress || nftData.creatorWallet,
    name: nftData.name,
    description: nftData.description,
    contentHash: null,
    exifRawHash: null,
    exifHash: null,
    exifBindingHash: null,
    license: nftData.license || 'arr',
    watermarked: !!nftData.watermarked,
    encrypted: !!nftData.encrypted,
    storageType: nftData.storageType || 'ipfs',
    imageUrl: nftData.arweaveUrl || nftData.imageUrl,
    metadataUrl: nftData.metadataUrl,
    createdAt: nftData.createdAt || new Date().toISOString(),
    issuedAt: new Date().toISOString(),
  };
  // Extract hashes from attributes (check both metadata.attributes and top-level attributes)
  // Normalize: always include SHA256: prefix for consistency across platforms
  const ensureHashPrefix = (h) => h && !h.startsWith('SHA256:') ? `SHA256:${h}` : h;
  // Try direct fields first (desktop post-mint)
  if (nftData.contentHash) cert.contentHash = ensureHashPrefix(nftData.contentHash);
  if (nftData.exifRawHash) cert.exifRawHash = ensureHashPrefix(nftData.exifRawHash);
  if (nftData.exifHash) cert.exifHash = ensureHashPrefix(nftData.exifHash);
  if (nftData.exifBindingHash) cert.exifBindingHash = ensureHashPrefix(nftData.exifBindingHash);
  // Then metadata attributes (matches solana-seeker: check both metadata.attributes and top-level attributes)
  const attrs = nftData.metadata?.attributes || nftData.attributes || [];
  for (const attr of attrs) {
    if (attr.trait_type === 'Content Hash' && !cert.contentHash) cert.contentHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Raw Hash' && !cert.exifRawHash) cert.exifRawHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Hash' && !cert.exifHash) cert.exifHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'EXIF Binding Hash' && !cert.exifBindingHash) cert.exifBindingHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'Camera Hash' && !cert.cameraHash) cert.cameraHash = ensureHashPrefix(attr.value);
    if (attr.trait_type === 'License' && !cert.license) cert.license = attr.value;
  }
  // Fallback: direct cameraHash field from nftData (matches mobile-v2)
  if (!cert.cameraHash && nftData.cameraHash) cert.cameraHash = ensureHashPrefix(nftData.cameraHash);
  // RFC 3161 + C2PA — from direct fields (desktop) or metadata properties (mobile)
  if (nftData.tsaToken) cert.rfc3161Token = nftData.tsaToken;
  if (nftData.tsaUrl) cert.rfc3161Tsa = nftData.tsaUrl;
  if (nftData.tsaPolicy) cert.rfc3161Policy = nftData.tsaPolicy;
  if (nftData.mintTimestamp) cert.mintedAt = nftData.mintTimestamp;
  if (nftData.c2paManifest) cert.c2paManifest = nftData.c2paManifest;
  // Also try from metadata properties (if full metadata object is passed)
  const metaCert = nftData.metadata?.properties?.certificate;
  if (metaCert) {
    if (metaCert.rfc3161?.tsaTokenBase64 && !cert.rfc3161Token) cert.rfc3161Token = metaCert.rfc3161.tsaTokenBase64;
    if (metaCert.rfc3161?.tsa && !cert.rfc3161Tsa) cert.rfc3161Tsa = metaCert.rfc3161.tsa;
    if (metaCert.mintedAt && !cert.mintedAt) cert.mintedAt = metaCert.mintedAt;
  }
  if (nftData.metadata?.properties?.c2pa && !cert.c2paManifest) {
    cert.c2paManifest = nftData.metadata.properties.c2pa;
  }
  // Set flags based on actual token presence (not unconditionally)
  cert.hasRfc3161 = !!cert.rfc3161Token;
  cert.hasC2pa = !!cert.c2paManifest;

  // Also check attributes for RFC3161/C2PA presence (fallback when metadata is stripped)
  const rfc3161Attr = attrs.find(a => a.trait_type === 'RFC 3161 Timestamp');
  const c2paAttr = attrs.find(a => a.trait_type === 'C2PA Provenance');
  if (rfc3161Attr && !cert.hasRfc3161) cert.hasRfc3161 = true;
  if (c2paAttr && !cert.hasC2pa) cert.hasC2pa = true;

  // Fallback: direct fields from nftData (matches mobile-v2)
  if (!cert.rfc3161Token && nftData.rfc3161Token) { cert.rfc3161Token = nftData.rfc3161Token; cert.hasRfc3161 = true; }
  if (!cert.hasRfc3161 && nftData.hasRfc3161) cert.hasRfc3161 = true;
  if (!cert.hasC2pa && nftData.hasC2pa) cert.hasC2pa = true;

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

async function removeCertificateLocal(mintAddress) {
  try {
    const filePath = getCertsFilePath();
    if (!fs.existsSync(filePath)) return { success: true };
    let certs = [];
    try { certs = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    const filtered = certs.filter(c => c.mintAddress !== mintAddress);
    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
    console.log('[NFT] Certificate removed for mint:', mintAddress);
    return { success: true };
  } catch (e) {
    console.error('[NFT] Remove certificate failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function saveCertificateLocal(cert) {
  try {
    const filePath = getCertsFilePath();
    console.log('[NFT] saveCertificateLocal path:', filePath, 'nftStorageFile:', nftStorageFile);
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
    console.log('[NFT] Certificate saved locally:', cert.id, 'total:', certs.length, 'at:', filePath);
    return { success: true };
  } catch (e) {
    console.error('[NFT] Save certificate failed:', e.message, 'path:', getCertsFilePath());
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
    'cc-by-nc-sa': 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)',
    'cc-by-nd': 'Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)',
    'cc-by-nc-nd': 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0)',
    'cc0': 'Creative Commons Zero 1.0 Universal (CC0 — Public Domain)',
    'commercial': 'Commercial License — Contact Rights Holder',
  };
  const licenseLabel = LICENSE_MAP[cert.license] || cert.license || 'All Rights Reserved';

  // License URL for legal deed reference
  const LICENSE_URL_MAP = {
    'cc-by': 'https://creativecommons.org/licenses/by/4.0/',
    'cc-by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
    'cc-by-nc': 'https://creativecommons.org/licenses/by-nc/4.0/',
    'cc-by-nc-sa': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    'cc-by-nd': 'https://creativecommons.org/licenses/by-nd/4.0/',
    'cc-by-nc-nd': 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    'cc0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  };
  const licenseUrl = LICENSE_URL_MAP[cert.license] || null;

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
  const contentHash = cert.contentHash || '— not recorded —';
  const exifHash = cert.exifHash || '— not recorded —';
  const exifRawHash = cert.exifRawHash || '— not recorded —';
  const exifBindingHash = cert.exifBindingHash || '— not recorded —';
  const storage = cert.storageType === 'cloud' ? 'StealthCloud (Encrypted Private Storage)' : cert.storageType === 'arweave' ? 'Arweave (Permanent Decentralized Storage)' : cert.storageType === 'onchain' ? 'Embedded On-Chain (Original Image in Metadata)' : 'IPFS (Decentralized Public Storage)';
  const hash = cert.contentHash ? cert.contentHash.replace(/^SHA256:/, '') : '<sha256_hash>';

  const lines = [
    '┌─────────────────────────────────────────────────────┐',
    '│                                                     │',
    '│          CERTIFICATE OF AUTHENTICITY                │',
    `│          Digital Asset — ${cert.certificationMode === 'public' ? 'Public Certified' : 'Private Certified'}          │`,
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
    `  Certification:  ${cert.certificationMode === 'public' ? 'Public Certified' : cert.certificationMode === 'private' ? 'Private Certified' : cert.edition === 'limited' ? 'Private Certified' : cert.edition === 'open' ? 'Public Certified' : 'Certified Original'}`,
    `  License:        ${licenseLabel}`,
    ...(licenseUrl ? [`  License Deed:   ${licenseUrl}`] : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 2 — BLOCKCHAIN PROVENANCE',
    '',
    `  Network:        Solana Mainnet`,
    `  Mint Address:   ${mint}`,
    `  Transaction:    ${tx}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    'SECTION 3 — INTEGRITY VERIFICATION',
    '',
    `  Content Hash:   ${contentHash}`,
    `  EXIF Hash:      ${exifHash}`,
    `  Raw EXIF Hash:  ${exifRawHash}`,
    `  Binding Hash:   ${exifBindingHash}`,
    '',
    '  The above cryptographic hashes were computed at the',
    '  time of minting and can be used to verify that the',
    '  original work has not been altered or tampered with.',
    '',
    '  HOW TO VERIFY CONTENT HASH:',
    '    sha256sum <original_file>',
    '',
    '  HOW TO VERIFY EXIF HASH:',
    '    The EXIF Hash is SHA-256 of normalized EXIF fields',
    '    (non-GPS decimals rounded to 4dp, GPS truncated to 4dp,',
    '    keys sorted alphabetically, then JSON.stringify + SHA-256).',
    '',
    '    npm install exifreader',
    '    node verify-exif-hash.js <original_file>',
    '',
    '    Script: https://github.com/viktorvishyn369/PhotoLynk/blob/main/server-tray/verify-exif-hash.js',
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
    ...(cert.rfc3161Token ? [
      'SECTION 5 — RFC 3161 TRUSTED TIMESTAMP',
      '',
      `  Authority:      FreeTSA.org (publicly trusted TSA)`,
      `  Standard:       RFC 3161 / RFC 5816`,
      `  Hash Algorithm: SHA-256`,
      `  Minted At:      ${cert.mintedAt || cert.createdAt || '—'}`,
      '',
      '  Verify with OpenSSL (macOS / Linux):',
      `  Step 1: printf '%s' "${cert.rfc3161Token}" | base64 -d > token.tsr`,
      '  Step 2: curl -o cacert.pem https://freetsa.org/files/cacert.pem',
      `  Step 3: openssl ts -verify -in token.tsr -digest ${hash} -CAfile cacert.pem`,
      '',
      '  Verify with PowerShell (Windows):',
      `  Step 1: [System.Convert]::FromBase64String("${cert.rfc3161Token}") | Set-Content token.tsr -Encoding Byte`,
      '  Step 2: Invoke-WebRequest https://freetsa.org/files/cacert.pem -OutFile cacert.pem',
      `  Step 3: openssl ts -verify -in token.tsr -digest ${hash} -CAfile cacert.pem`,
      '',
      '  Expected result: Verification: OK',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ] : []),
    ...(cert.c2paManifest ? [
      'SECTION 6 — C2PA PROVENANCE MANIFEST',
      '',
      `  Standard:       C2PA (Coalition for Content Provenance)`,
      `  Backed by:      Adobe, Microsoft, Google, BBC, Sony`,
      `  Claim Generator: ${cert.c2paManifest?.claim_generator || `PhotoLynk/${APP_VERSION}`}`,
      `  Created:        ${cert.c2paManifest?.claim?.created || cert.mintedAt || '—'}`,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ] : []),
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
  prewarmPriorityFee,
  
  // Upload functions (same as mobile)
  uploadToPinata,
  uploadMetadataToPinata,
  uploadToStealthCloud,
  uploadToAkordArweave,
  uploadMetadataToAkordArweave,
  
  // NFT metadata and minting
  buildNFTMetadata,
  computeContentHash,
  computeCameraSerialHash,
  mintNFT,
  
  // NFT fetching (uses DAS API like mobile)
  fetchUserNFTs,
  fetchImageFromMetadata,
  
  // NFT local storage (same as mobile)
  getStoredNFTs,
  saveNFTToStorage,
  removeNFTFromStorage,
  bulkSaveNFTs,
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
  generateOnChainImage,
  generateOptimizedPreview,
  generateLimitedEditionThumb,
  burnWatermark,
  encryptNFTImage,
  decryptNFTImage,
  decryptMetadataJSON,
  
  // Ecosystem check
  isPhotoLynkEcosystem,
  // Certificates (matches mobile)
  generateCertificate,
  saveCertificateLocal,
  removeCertificateLocal,
  formatCertificateForExport,
  getCertsFilePath,
  
  // Constants (same as mobile)
  NFT_COMMISSION_WALLET,
  isFeeWalletExempt,
  PHOTOLYNK_MERKLE_TREE,
  IPFS_GATEWAYS,
  NFT_STORAGE_OPTIONS,
  NFT_EDITION,
  NFT_LICENSE_OPTIONS,
  EDITION_ROYALTY_BPS,
  SOLANA_RPC_ENDPOINTS,
  PINATA_JWT,
  
  // DAS cache control
  invalidateDasCache,
  
  // Status flags
  solanaAvailable,
  splTokenAvailable,
};
