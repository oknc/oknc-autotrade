/**
 * sol-engine.js — Solana 链交易引擎
 *
 * 使用 Jupiter Swap API V2 进行代币兑换
 * 支持 SOL → 代币（买入）和 代币 → SOL（卖出）
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'sol-log.json');

// === 常量 ===
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_BASE = 'https://api.jup.ag';
const JUPITER_ORDER_API = `${JUPITER_BASE}/swap/v2/order`;
const JUPITER_EXECUTE_API = `${JUPITER_BASE}/swap/v2/execute`;
const JUPITER_PRICE_API = `${JUPITER_BASE}/price/v2`;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%

// Solana RPC
const SOL_RPC = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';

// === 引擎状态 ===
let connection = null;
let walletKeypair = null;
let isInitialized = false;

/**
 * 获取 SOL 的 USD 价格
 */
let solPriceCache = { price: 0, time: 0 };
async function getSOLPriceUSD() {
  if (Date.now() - solPriceCache.time < 30000 && solPriceCache.price > 0) {
    return solPriceCache.price;
  }
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (resp.ok) {
      const data = await resp.json();
      solPriceCache = { price: data.solana.usd, time: Date.now() };
      return data.solana.usd;
    }
  } catch {}
  return 0;
}

/**
 * 初始化 SOL 引擎
 * @param {string} privateKey - base58 编码的 Solana 私钥
 */
export async function initSolEngine(privateKey = null) {
  const pk = privateKey || process.env.SOL_PRIVATE_KEY;
  if (!pk) {
    throw new Error('SOL 私钥未提供，请在 .env 配置 SOL_PRIVATE_KEY 或在钱包中导入');
  }

  connection = new Connection(SOL_RPC, 'confirmed');

  let secretKey;
  try {
    const decoded = bs58.decode(pk.trim());
    if (decoded.length === 64) secretKey = decoded;
    else if (decoded.length === 32) secretKey = Keypair.fromSeed(decoded).secretKey;
    else throw new Error('无效的 SOL 私钥长度');
  } catch (e) {
    if (e.message && e.message.includes('无效')) throw e;
    // JSON 数组格式
    try {
      const arr = JSON.parse(pk.trim());
      secretKey = new Uint8Array(arr);
    } catch {
      throw new Error('无法解析 SOL 私钥');
    }
  }

  const { Keypair } = await import('@solana/web3.js');
  walletKeypair = Keypair.fromSecretKey(secretKey);
  isInitialized = true;
  console.log(`[SolEngine] ✅ 初始化完成，钱包: ${walletKeypair.publicKey.toBase58()}`);
  return walletKeypair.publicKey.toBase58();
}

export function isSolInitialized() { return isInitialized; }

export function getSolWalletAddress() {
  return walletKeypair?.publicKey?.toBase58() || null;
}

/**
 * 获取 SOL 余额（native）
 */
export async function getSolBalance() {
  if (!connection || !walletKeypair) {
    console.log('[SolEngine] ⚠️ 引擎未初始化，尝试初始化...');
    return 0;
  }
  try {
    const balance = await connection.getBalance(walletKeypair.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error('[SolEngine] 获取SOL余额失败:', err.message);
    return 0;
  }
}

/**
 * 获取 SPL 代币余额
 * @param {string} tokenMint - 代币 Mint 地址
 */
export async function getTokenBalance(tokenMint) {
  if (!connection || !walletKeypair) return 0;
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const tokenAccount = await getAssociatedTokenAddress(mintPubkey, walletKeypair.publicKey);
    try {
      const accountInfo = await getAccount(connection, tokenAccount);
      const decimals = 6;
      return Number(accountInfo.amount) / Math.pow(10, decimals);
    } catch {
      return 0;
    }
  } catch {
    return 0;
  }
}

/**
 * 获取 SPL 代币余额（返回原始 wei 级数量 + decimals）
 */
export async function getTokenBalanceRaw(tokenMint) {
  if (!connection || !walletKeypair) return { amount: 0n, decimals: 6 };
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const tokenAccount = await getAssociatedTokenAddress(mintPubkey, walletKeypair.publicKey);
    try {
      const accountInfo = await getAccount(connection, tokenAccount);
      let decimals = 6;
      try {
        const mintInfo = await connection.getAccountInfo(mintPubkey);
        if (mintInfo && mintInfo.data) {
          decimals = mintInfo.data[44];
        }
      } catch {}
      return { amount: accountInfo.amount, decimals };
    } catch {
      return { amount: 0n, decimals: 6 };
    }
  } catch {
    return { amount: 0n, decimals: 6 };
  }
}

/**
 * 从 Jupiter API 获取代币价格（新版 price/v2）
 * @param {string} tokenMint - 代币 mint 地址
 */
export async function getJupiterPrice(tokenMint) {
  try {
    const url = `${JUPITER_PRICE_API}?ids=${tokenMint}&vsToken=${WSOL_MINT}`;
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      if (data.data && data.data[tokenMint]) {
        const priceInSOL = parseFloat(data.data[tokenMint].price);
        const solPrice = await getSOLPriceUSD();
        return { priceInSOL, priceInUSD: priceInSOL * solPrice };
      }
    }
  } catch {}
  return { priceInSOL: 0, priceInUSD: 0 };
}

/**
 * 从 Jupiter Swap API V2 获取报价 + 交易
 * 使用 /swap/v2/order 端点（Meta-Aggregator 路径）
 *
 * @param {string} inputMint - 输入代币 mint
 * @param {string} outputMint - 输出代币 mint
 * @param {number} amount - 输入数量（人类可读单位）
 * @param {number} slippageBps - 滑点 (bps, 默认100=1%)
 * @param {number} decimals - 输入代币精度
 * @param {string} taker - 交易者钱包地址（可选，默认使用当前钱包）
 */
export async function getQuote(inputMint, outputMint, amount, slippageBps = DEFAULT_SLIPPAGE_BPS, decimals = 9, taker = null) {
  const amountRaw = Math.floor(amount * Math.pow(10, decimals));
  const takerAddr = taker || (walletKeypair ? walletKeypair.publicKey.toBase58() : '');
  const url = `${JUPITER_ORDER_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&taker=${takerAddr}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    let errBody = '';
    try { errBody = await resp.text(); } catch {}
    throw new Error(`Jupiter 报价错误: ${resp.status} - ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();

  // 检查是否有错误
  if (data.errorCode && data.errorCode !== 0) {
    throw new Error(`Jupiter 报价失败: ${data.errorMessage || data.error || '未知错误'}`);
  }

  if (!data.routePlan || data.routePlan.length === 0) {
    throw new Error('Jupiter 未找到交易路径');
  }

  return data;
}

/**
 * 执行买入：SOL → 代币
 * 使用新版 Swap API V2: /swap/v2/order → 签名 → /swap/v2/execute
 *
 * @param {string} tokenMint - 代币 mint 地址
 * @param {number} amountSOL - 买入 SOL 数量
 * @param {number} slippageBps - 滑点 (bps)
 */
export async function executeSolBuy(tokenMint, amountSOL, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  if (!isInitialized) throw new Error('SOL 引擎未初始化');

  const solBalance = await getSolBalance();
  if (solBalance < amountSOL + 0.001) {
    throw new Error(`SOL 余额不足: ${solBalance.toFixed(4)} SOL，需要 ${amountSOL} SOL + gas`);
  }

  const takerAddr = walletKeypair.publicKey.toBase58();

  // 1. 获取报价 + 组装好的交易
  const orderData = await getQuote(WSOL_MINT, tokenMint, amountSOL, slippageBps, 9, takerAddr);

  // 2. 从 order 回复获取交易（base64 格式）
  const txBase64 = orderData.transaction;
  if (!txBase64 || txBase64.length === 0) {
    throw new Error('Jupiter 未能构建交易（可能余额不足或其他错误）');
  }

  // 3. 反序列化并签名
  const txBuffer = Buffer.from(txBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([walletKeypair]);

  // 4. 通过 Jupiter /execute 执行（托管落地）
  const executeResp = await fetch(JUPITER_EXECUTE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      requestId: orderData.requestId,
    }),
  });

  if (!executeResp.ok) {
    const errText = await executeResp.text();
    throw new Error(`Jupiter 执行失败: ${executeResp.status} - ${errText}`);
  }

  const executeResult = await executeResp.json();
  const txHash = executeResult.signature;

  console.log(`[SolEngine] ✅ 买入完成: ${txHash}`);

  // 5. 计算实际获得的代币数量
  const outAmount = parseFloat(orderData.outAmount) / Math.pow(10, 6);
  const solPrice = await getSOLPriceUSD();
  const actualPriceUSD = amountSOL > 0 && outAmount > 0
    ? (amountSOL / outAmount) * solPrice
    : 0;

  const result = {
    type: 'buy',
    chain: 'sol',
    amountIn: amountSOL,
    symbolIn: 'SOL',
    amountOut: outAmount,
    symbolOut: tokenMint.slice(0, 6) + '...',
    actualPriceUSD,
    txHash,
    gasUsed: 0,
  };
  appendSolLog(result);
  return result;
}

/**
 * 执行卖出：代币 → SOL
 * 使用新版 Swap API V2
 *
 * @param {string} tokenMint - 代币 mint 地址
 * @param {number} amountToken - 卖出代币数量
 * @param {number} tokenDecimals - 代币精度
 * @param {number} slippageBps - 滑点 (bps)
 */
export async function executeSolSell(tokenMint, amountToken, tokenDecimals = 6, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  if (!isInitialized) throw new Error('SOL 引擎未初始化');

  // 获取链上实际余额
  const rawBalance = await getTokenBalanceRaw(tokenMint);
  const sellAmountRaw = BigInt(Math.floor(amountToken * Math.pow(10, tokenDecimals)));
  const actualSellAmount = sellAmountRaw < rawBalance.amount ? sellAmountRaw : rawBalance.amount;

  if (rawBalance.amount < 1n) {
    throw new Error(`代币链上余额为 0，无法卖出`);
  }

  const takerAddr = walletKeypair.publicKey.toBase58();

  // 1. 获取报价 + 交易（使用实际 wei 值）
  const amountInRaw = actualSellAmount.toString();
  const orderUrl = `${JUPITER_ORDER_API}?inputMint=${tokenMint}&outputMint=${WSOL_MINT}&amount=${amountInRaw}&slippageBps=${slippageBps}&taker=${takerAddr}`;
  const orderResp = await fetch(orderUrl);
  if (!orderResp.ok) {
    let errBody = '';
    try { errBody = await orderResp.text(); } catch {}
    throw new Error(`Jupiter 报价错误: ${orderResp.status} - ${errBody.slice(0, 200)}`);
  }
  const orderData = await orderResp.json();

  if (orderData.errorCode && orderData.errorCode !== 0) {
    throw new Error(`Jupiter 报价失败: ${orderData.errorMessage || orderData.error || '未知错误'}`);
  }

  if (!orderData.routePlan || orderData.routePlan.length === 0) {
    throw new Error('Jupiter 未找到交易路径');
  }

  // 2. 获取交易
  const txBase64 = orderData.transaction;
  if (!txBase64 || txBase64.length === 0) {
    throw new Error('Jupiter 未能构建交易（可能余额不足或其他错误）');
  }

  // 3. 反序列化并签名
  const txBuffer = Buffer.from(txBase64, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuffer);
  transaction.sign([walletKeypair]);

  // 4. 通过 /execute 执行
  const executeResp = await fetch(JUPITER_EXECUTE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: Buffer.from(transaction.serialize()).toString('base64'),
      requestId: orderData.requestId,
    }),
  });

  if (!executeResp.ok) {
    const errText = await executeResp.text();
    throw new Error(`Jupiter 执行失败: ${executeResp.status} - ${errText}`);
  }

  const executeResult = await executeResp.json();
  const txHash = executeResult.signature;

  console.log(`[SolEngine] ✅ 卖出完成: ${txHash}`);

  const outAmount = parseFloat(orderData.outAmount) / LAMPORTS_PER_SOL;
  const result = {
    type: 'sell',
    chain: 'sol',
    amountIn: Number(actualSellAmount) / Math.pow(10, tokenDecimals),
    symbolIn: tokenMint.slice(0, 6) + '...',
    amountOut: outAmount,
    symbolOut: 'SOL',
    txHash,
    gasUsed: 0,
  };
  appendSolLog(result);
  return result;
}

/**
 * 模拟买入（仅报价，不执行交易）
 */
export async function simulateSolBuy(tokenMint, amountSOL) {
  if (!isInitialized) return { buyTaxPct: null, isHoneypot: null, error: '引擎未初始化' };
  try {
    const takerAddr = walletKeypair.publicKey.toBase58();
    const orderData = await getQuote(WSOL_MINT, tokenMint, amountSOL, DEFAULT_SLIPPAGE_BPS, 9, takerAddr);
    const expectedOut = parseFloat(orderData.outAmount) / Math.pow(10, 6);
    const priceImpactPct = parseFloat(orderData.priceImpactPct || '0') || 0;
    return {
      buyTaxPct: Math.min(priceImpactPct * 100, 20),
      isHoneypot: false,
      expectedOut,
      priceImpactPct,
    };
  } catch (err) {
    return { buyTaxPct: null, isHoneypot: null, error: err.message };
  }
}

/**
 * 模拟卖出（仅报价，不执行交易）
 */
export async function simulateSolSell(tokenMint, amountToken, decimals = 6) {
  if (!isInitialized) return { sellTaxPct: null, isHoneypot: null, error: '引擎未初始化' };
  try {
    const takerAddr = walletKeypair.publicKey.toBase58();
    const amountRaw = Math.floor(amountToken * Math.pow(10, decimals));
    const url = `${JUPITER_ORDER_API}?inputMint=${tokenMint}&outputMint=${WSOL_MINT}&amount=${amountRaw}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&taker=${takerAddr}`;
    const resp = await fetch(url);
    if (!resp.ok) return { sellTaxPct: null, isHoneypot: null, error: `Jupiter 报价失败: ${resp.status}` };
    const data = await resp.json();
    if (data.errorCode && data.errorCode !== 0) {
      return { sellTaxPct: null, isHoneypot: null, error: data.errorMessage || data.error };
    }
    const expectedOut = parseFloat(data.outAmount) / LAMPORTS_PER_SOL;
    const priceImpactPct = parseFloat(data.priceImpactPct || '0') || 0;
    return {
      sellTaxPct: Math.min(priceImpactPct * 100, 20),
      isHoneypot: false,
      expectedOut,
      priceImpactPct,
    };
  } catch (err) {
    return { sellTaxPct: null, isHoneypot: null, error: err.message };
  }
}

// === 日志 ===
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendSolLog(entry) {
  ensureDataDir();
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
    catch { /* 忽略 */ }
  }
  logs.push({ ...entry, time: new Date().toISOString() });
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - THREE_DAYS_MS;
  logs = logs.filter(l => {
    const t = new Date(l.time).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  if (logs.length > 2000) logs = logs.slice(-2000);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

export function getSolRecentLogs(count = 50, offset = 0) {
  ensureDataDir();
  if (!fs.existsSync(LOG_FILE)) return { items: [], total: 0 };
  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    const reversed = [...logs].reverse();
    const items = reversed.slice(offset, offset + count);
    return { items, total: logs.length };
  } catch {
    return { items: [], total: 0 };
  }
}

/**
 * 获取综合链上数据（代币分析用）
 */
export async function analyzeSolToken(tokenMint) {
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const acctInfo = await connection.getAccountInfo(mintPubkey);
    if (!acctInfo) {
      return { error: '该地址不是有效的 Solana 代币 Mint' };
    }
    const decimals = acctInfo.data[44];
    const supplyBuffer = acctInfo.data.slice(36, 44);
    const supply = supplyBuffer.readBigUInt64LE(0);
    const supplyParsed = Number(supply) / Math.pow(10, decimals);

    const priceInfo = await getJupiterPrice(tokenMint);

    return {
      decimals,
      supplyFormatted: supplyParsed.toLocaleString(),
      priceSOL: priceInfo.priceInSOL,
      priceUSD: priceInfo.priceInUSD,
    };
  } catch (err) {
    return { error: err.message };
  }
}
