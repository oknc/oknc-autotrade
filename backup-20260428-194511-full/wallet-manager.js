/**
 * wallet-manager.js — 多钱包管理模块
 */
import Web3 from 'web3';
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
  if (wallets.length > 0 && !activeWalletAddress) {
    activeWalletAddress = wallets[0].address;
  }
}

function saveWallets() {
  ensureDataDir();
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

loadWallets();

export function importWallet(privateKey, label = '') {
  const tempWeb3 = new Web3();
  const formattedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const account = tempWeb3.eth.accounts.privateKeyToAccount(formattedKey);
  const address = account.address.toLowerCase();

  const existing = wallets.find(w => w.address === address);
  if (existing) {
    existing.label = label || existing.label;
    existing.encryptedKey = encrypt(formattedKey);
    existing.importedAt = new Date().toISOString();
    saveWallets();
    return { address, label: existing.label, imported: false };
  }

  wallets.push({
    address,
    label: label || `钱包 ${wallets.length + 1}`,
    encryptedKey: encrypt(formattedKey),
    importedAt: new Date().toISOString(),
  });
  saveWallets();
  if (wallets.length === 1) activeWalletAddress = address;
  return { address, label: label || `钱包 ${wallets.length}`, imported: true };
}

export function removeWallet(address) {
  const addr = address.toLowerCase();
  const idx = wallets.findIndex(w => w.address === addr);
  if (idx === -1) throw new Error('钱包不存在');
  wallets.splice(idx, 1);
  if (activeWalletAddress === addr) {
    activeWalletAddress = wallets.length > 0 ? wallets[0].address : null;
  }
  saveWallets();
}

export function switchWallet(address) {
  const addr = address.toLowerCase();
  const wallet = wallets.find(w => w.address === addr);
  if (!wallet) throw new Error('钱包不存在');
  activeWalletAddress = addr;
  return { address: wallet.address, label: wallet.label };
}

export function getActivePrivateKey() {
  if (!activeWalletAddress) return null;
  const wallet = wallets.find(w => w.address === activeWalletAddress);
  if (!wallet) return null;
  try { return decrypt(wallet.encryptedKey); }
  catch { return null; }
}

export function getWallets(masked = true) {
  return wallets.map(w => ({
    address: masked ? w.address.slice(0, 8) + '...' + w.address.slice(-6) : w.address,
    addressRaw: w.address,
    label: w.label,
    isActive: w.address === activeWalletAddress,
    importedAt: w.importedAt,
  }));
}

export function getActiveWallet() { return activeWalletAddress; }
export function getWalletCount() { return wallets.length; }
export function hasWallets() { return wallets.length > 0; }

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

export function addWatchedToken(tokenAddress, symbol = '') {
  const tokens = loadWatchedTokens();
  const addr = tokenAddress.toLowerCase();
  if (tokens.find(t => t.address === addr)) return tokens;
  tokens.push({ address: addr, symbol: symbol || `Token ${tokens.length+1}`, addedAt: new Date().toISOString() });
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
  if (activeWalletAddress) {
    const active = wallets.find(w => w.address === activeWalletAddress);
    console.log(`[WalletManager] 当前: ${active?.label || activeWalletAddress}`);
  }
}
