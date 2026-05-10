/**
 * wallet-manager.js — 多链钱包管理模块 (v2)
 *
 * 支持 BSC (web3) 和 Solana (solana/web3.js)
 * 自动检测密钥格式
 */
import Web3 from 'web3';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = path.join(__dirname, 'data', 'wallets.json');
const WATCHED_TOKENS_FILE = path.join(__dirname, 'data', 'watched_tokens.json');

const ENCRYPTION_KEY = crypto.createHash('sha256')
  .update('oknc-autotrade-wallet-v1')
  .digest('hex')
  .slice(0, 32);

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

let wallets = [];
let activeWalletAddress = null;

function ensureDataDir() {
  const dir = path.dirname(WALLETS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadWallets() {
  ensureDataDir();
  if (fs.existsSync(WALLETS_FILE)) {
    try { wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8')); }
    catch { wallets = []; }
  }
  for (const w of wallets) {
    if (!w.chain) w.chain = 'bsc';
  }
  if (wallets.length > 0 && !activeWalletAddress) {
    activeWalletAddress = wallets[0].address;
  }
}

function saveWallets() {
  ensureDataDir();
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

loadWallets();

function detectChain(privateKey) {
  const pk = privateKey.trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(pk)) return 'bsc';
  if (/^[a-fA-F0-9]{64}$/.test(pk)) return 'bsc';
  if (pk.length >= 32 && !pk.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]+$/.test(pk)) {
    return 'sol';
  }
  return 'bsc';
}

function importSolWallet(privateKey, label = '') {
  let secretKey;
  const pk = privateKey.trim();

  try {
    const decoded = bs58.decode(pk);
    if (decoded.length === 64) {
      secretKey = decoded;
    } else if (decoded.length === 32) {
      secretKey = Keypair.fromSeed(decoded).secretKey;
    } else {
      throw new Error('无效的SOL私钥长度');
    }
  } catch (e) {
    if (e.message && e.message.includes('无效')) throw e;
    try {
      const arr = JSON.parse(pk);
      if (Array.isArray(arr) && arr.length === 64) {
        secretKey = new Uint8Array(arr);
      } else {
        throw new Error('无效的SOL私钥格式(JSON数组需64位)');
      }
    } catch {
      try {
        const nums = pk.split(',').map(n => parseInt(n.trim(), 10));
        if (nums.length === 64 && nums.every(n => n >= 0 && n <= 255)) {
          secretKey = new Uint8Array(nums);
        } else {
          throw new Error('无法解析SOL私钥，请使用base58或JSON数组格式');
        }
      } catch {
        throw new Error('无法解析SOL私钥，请使用base58或JSON数组格式');
      }
    }
  }

  const keypair = Keypair.fromSecretKey(secretKey);
  const address = keypair.publicKey.toBase58();

  const existing = wallets.find(w => w.address === address && w.chain === 'sol');
  if (existing) {
    existing.label = label || existing.label;
    existing.encryptedKey = encrypt(pk);
    existing.importedAt = new Date().toISOString();
    saveWallets();
    return { address, label: existing.label, chain: 'sol', imported: false };
  }

  wallets.push({
    address,
    label: label || `SOL钱包 ${wallets.filter(w => w.chain === 'sol').length + 1}`,
    chain: 'sol',
    encryptedKey: encrypt(pk),
    importedAt: new Date().toISOString(),
  });
  saveWallets();
  if (wallets.length === 1) activeWalletAddress = address;
  return { address, label: label || `SOL钱包 ${wallets.filter(w => w.chain === 'sol').length}`, chain: 'sol', imported: true };
}

export function importWallet(privateKey, label = '', forceChain = null) {
  const chain = forceChain || detectChain(privateKey);
  if (chain === 'sol') return importSolWallet(privateKey, label);

  const tempWeb3 = new Web3();
  const formattedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const account = tempWeb3.eth.accounts.privateKeyToAccount(formattedKey);
  const address = account.address.toLowerCase();

  const existing = wallets.find(w => w.address === address && w.chain === 'bsc');
  if (existing) {
    existing.label = label || existing.label;
    existing.encryptedKey = encrypt(formattedKey);
    existing.importedAt = new Date().toISOString();
    saveWallets();
    return { address, label: existing.label, chain: 'bsc', imported: false };
  }

  wallets.push({
    address,
    label: label || `钱包 ${wallets.filter(w => w.chain === 'bsc').length + 1}`,
    chain: 'bsc',
    encryptedKey: encrypt(formattedKey),
    importedAt: new Date().toISOString(),
  });
  saveWallets();
  if (wallets.length === 1) activeWalletAddress = address;
  return { address, label: label || `钱包 ${wallets.filter(w => w.chain === 'bsc').length}`, chain: 'bsc', imported: true };
}

export function removeWallet(address) {
  const wallet = wallets.find(w => w.address === address || w.address === address.toLowerCase());
  if (!wallet) throw new Error('钱包不存在');
  const idx = wallets.indexOf(wallet);
  wallets.splice(idx, 1);
  if (wallets.length > 0) {
    activeWalletAddress = wallets[0].address;
  } else {
    activeWalletAddress = null;
  }
  saveWallets();
}

export function switchWallet(address) {
  const wallet = wallets.find(w => w.address === address || w.address === address.toLowerCase());
  if (!wallet) throw new Error('钱包不存在');
  activeWalletAddress = wallet.address;
  return { address: wallet.address, label: wallet.label, chain: wallet.chain };
}

export function getActivePrivateKey() {
  if (!activeWalletAddress) return null;
  const wallet = wallets.find(w => w.address === activeWalletAddress);
  if (!wallet) return null;
  try { return decrypt(wallet.encryptedKey); }
  catch { return null; }
}

export function getActivePrivateKeyForChain(chain) {
  if (activeWalletAddress) {
    const active = wallets.find(w => w.address === activeWalletAddress && w.chain === chain);
    if (active) {
      try { return decrypt(active.encryptedKey); }
      catch { return null; }
    }
  }
  const first = wallets.find(w => w.chain === chain);
  if (first) {
    activeWalletAddress = first.address;
    try { return decrypt(first.encryptedKey); }
    catch { return null; }
  }
  return null;
}

export function getActiveWalletForChain(chain) {
  if (activeWalletAddress) {
    const active = wallets.find(w => w.address === activeWalletAddress && w.chain === chain);
    if (active) return active.address;
  }
  const first = wallets.find(w => w.chain === chain);
  return first?.address || null;
}

export function getWallets(masked = true) {
  return wallets.map(w => ({
    address: masked
      ? (w.chain === 'sol'
        ? w.address.slice(0, 6) + '...' + w.address.slice(-4)
        : w.address.slice(0, 8) + '...' + w.address.slice(-6))
      : w.address,
    addressRaw: w.address,
    label: w.label,
    chain: w.chain || 'bsc',
    isActive: w.address === activeWalletAddress,
    importedAt: w.importedAt,
  }));
}

export function getWalletsByChain(chain, masked = true) {
  return wallets
    .filter(w => (w.chain || 'bsc') === chain)
    .map(w => ({
      address: masked
        ? (chain === 'sol'
          ? w.address.slice(0, 6) + '...' + w.address.slice(-4)
          : w.address.slice(0, 8) + '...' + w.address.slice(-6))
        : w.address,
      addressRaw: w.address,
      label: w.label,
      chain: w.chain || 'bsc',
      isActive: w.address === activeWalletAddress,
      importedAt: w.importedAt,
    }));
}

export function getActiveWallet() { return activeWalletAddress; }
export function getWalletCount() { return wallets.length; }
export function hasWallets() { return wallets.length > 0; }
export function hasChainWallets(chain) {
  return wallets.some(w => (w.chain || 'bsc') === chain);
}

// === 跟踪代币管理 ===
function loadWatchedTokens() {
  ensureDataDir();
  if (fs.existsSync(WATCHED_TOKENS_FILE)) {
    try { return JSON.parse(fs.readFileSync(WATCHED_TOKENS_FILE, 'utf-8')); }
    catch { return []; }
  }
  return [];
}

function saveWatchedTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(WATCHED_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

export function addWatchedToken(tokenAddress, symbol = '', chain = 'bsc') {
  const tokens = loadWatchedTokens();
  const addr = chain === 'sol' ? tokenAddress : tokenAddress.toLowerCase();
  if (tokens.find(t => t.address === addr)) return tokens;
  tokens.push({ address: addr, symbol: symbol || `Token ${tokens.length+1}`, addedAt: new Date().toISOString(), chain });
  saveWatchedTokens(tokens);
  return tokens;
}

export function removeWatchedToken(tokenAddress) {
  const tokens = loadWatchedTokens();
  const filtered = tokens.filter(t => t.address !== tokenAddress.toLowerCase());
  saveWatchedTokens(filtered);
  return filtered;
}

export function getWatchedTokens() { return loadWatchedTokens(); }

export function initWalletManager() {
  loadWallets();
  console.log(`[WalletManager] ${wallets.length} 个钱包已加载`);
  const bscCount = wallets.filter(w => w.chain === 'bsc').length;
  const solCount = wallets.filter(w => w.chain === 'sol').length;
  console.log(`[WalletManager] BSC: ${bscCount}, SOL: ${solCount}`);
  if (activeWalletAddress) {
    const active = wallets.find(w => w.address === activeWalletAddress);
    console.log(`[WalletManager] 当前: ${active?.label || activeWalletAddress} (${active?.chain || 'bsc'})`);
  }
}
