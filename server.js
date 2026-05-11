/**
 * server.js — 自动土狗交易系统主服务 (v3)
 *
 * 多链支持: BSC (PancakeSwap) + Solana (Jupiter)
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import 'dotenv/config';

import * as screener from './screener.js';
import * as strategy from './strategy.js';
import {
  initEngine, getBalances, getRecentLogs, getStatus,
  updateSettings, startEngine, stopEngine, executeClear,
  getWalletAddress, getBalancesForWallet, reinitEngine, simulateBuy, simulateSell, checkTokenTax,
  appendLog
} from './engine.js';
import {
  importWallet, removeWallet, switchWallet,
  getWallets, getActivePrivateKey, getActiveWallet,
  getWalletCount, hasWallets, initWalletManager,
  getActivePrivateKeyForChain, getActiveWalletForChain,
  getWalletsByChain, hasChainWallets,
  addWatchedToken, removeWatchedToken, getWatchedTokens
} from './wallet-manager.js';
import * as solEngine from './sol-engine.js';
import * as cexEngine from './cex-engine.js';
import * as cexStrategy from "./cex-strategy.js";
import * as adaptive from './cex-adaptive.js';
import * as riskManager from "./risk-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// ============ Express 应用 ============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// root -> contract panel
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "contract.html"));
});

// 合约交易面板路由
app.get('/contract', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contract.html'));
});

// ============ 认证系统 ============
const AUTH_PASSWORD=process.env.AUTH_PASSWORD || 'oknc2018';
const AUTH_PASSWORD_READONLY=process.env.AUTH_PASSWORD_READONLY || 'oknc888';
const AUTH_SECRET=process.env.AUTH_SECRET || crypto.randomBytes(16).toString('hex');
const AUTH_TOKEN_EXPIRY=(process.env.AUTH_TOKEN_EXPIRY || 24) * 60 * 60 * 1000; // 24小时

const validTokens = new Map();

function generateToken(role = 'admin') {
  return crypto.createHash('sha256')
    .update(AUTH_PASSWORD + AUTH_SECRET + Date.now() + role)
    .digest('hex');
}

// 认证中间件
function authMiddleware(req, res, next) {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/check' || req.path === '/api/cex/intel') {
    return next();
  }
  if (!req.path.startsWith('/api/')) {
    return next();
  }
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: '未登录，请先登录', code: 'UNAUTHORIZED' });
  }
  const tokenData = validTokens.get(token);
  if (Date.now() > tokenData.expiresAt) {
    validTokens.delete(token);
    return res.status(401).json({ error: '会话已过期，请重新登录', code: 'TOKEN_EXPIRED' });
  }
  tokenData.expiresAt = Date.now() + AUTH_TOKEN_EXPIRY;
  req.user = tokenData;
  next();
}
app.use(authMiddleware);

// 只读中间件 — 拦截交易/策略相关操作
app.use((req, res, next) => {
  if (req.user && req.user.role === 'readonly') {
    const blockedPaths = [
      '/api/trade/buy', '/api/trade/sell', '/api/trade/liquidate',
      '/api/strategy/start', '/api/strategy/stop',
      '/api/engine/start', '/api/engine/stop',
      '/api/sol/trade/buy', '/api/sol/trade/sell',
      '/api/cex/exchanges', '/api/cex/position/open', '/api/cex/position/close', '/api/cex/leverage', '/api/cex/style',
      '/api/cex/strategy/start', '/api/cex/strategy/stop',
      '/api/cex/risk/reset', '/api/cex/log',
    ];
    if (blockedPaths.includes(req.path)) {
      return res.status(403).json({ error: '只读账号，无权执行此操作', code: 'READONLY' });
    }
  }
  next();
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  let role = null;
  if (password && password === AUTH_PASSWORD) {
    role = 'admin';
  } else if (password && AUTH_PASSWORD_READONLY && password === AUTH_PASSWORD_READONLY) {
    role = 'readonly';
  }
  if (!role) {
    return res.status(401).json({ error: '密码错误', success: false });
  }
  const token = generateToken(role);
  validTokens.set(token, { role, createdAt: Date.now(), expiresAt: Date.now() + AUTH_TOKEN_EXPIRY });
  res.json({ success: true, token, role, expiresIn: AUTH_TOKEN_EXPIRY });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: false });
});

// ============ 链接 Screener → Strategy ============
screener.setOnNewCandidates((newCandidates, allCandidates) => {
  strategy.evaluateAndBuy(newCandidates).catch(err => {
    console.error(`[Server] 自动买入评估失败: ${err.message}`);
  });
});

// ============ API 路由 ============

// --- 状态 ---
app.get('/api/status', (req, res) => {
  res.json({
    chain: screener.getCurrentChain(),
    strategyChain: strategy.getStrategyChain(),
    screener: {
      running: true,
      lastScan: screener.getLastScanTime(),
      candidateCount: screener.getCandidates().length,
    },
    strategy: strategy.getStrategyStatus(),
    engine: getStatus(),
    walletAddress: getWalletAddress(),
    wallets: getWallets(true),
    activeWallet: getActiveWallet(),
    walletCount: getWalletCount(),
    sol: {
      initialized: solEngine.isSolInitialized(),
      walletAddress: solEngine.getSolWalletAddress(),
    },
  });
});

// --- 链切换 ---
app.get('/api/chain', (req, res) => {
  res.json({ chain: screener.getCurrentChain(), supported: Object.keys(screener.CHAIN_CONFIG || { bsc: 1, sol: 1 }) });
});

app.post('/api/chain', (req, res) => {
  try {
    const { chain } = req.body;
    if (!chain) return res.status(400).json({ error: '需要 chain 参数' });
    screener.setCurrentChain(chain);
    strategy.setStrategyChain(chain);
    screener.forceScan().catch(() => {});
    res.json({ success: true, chain: screener.getCurrentChain() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- BSC 余额 ---
app.get('/api/balances', async (req, res) => {
  try {
    const balances = await getBalances();
    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 候选列表 ---
app.get('/api/candidates', (req, res) => {
  const list = screener.getCandidates();
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(list.slice(0, limit));
});

app.delete('/api/candidates/:address', (req, res) => {
  const result = screener.removeCandidate(req.params.address);
  res.json(result);
});

// --- 原始扫描结果（未过滤，展开模式）---
app.get('/api/candidates/raw', (req, res) => {
  const list = screener.getAllRawTokens();
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(list.slice(0, limit));
});

// --- 持仓列表 ---
app.get('/api/positions', (req, res) => {
  res.json(strategy.getPositions());
});

// --- 手动添加持仓 ---
app.post('/api/positions', (req, res) => {
  try {
    const { tokenAddress, tokenSymbol, buyAmountBNB, buyAmountToken, buyPriceUSD, txHash, chain } = req.body;
    if (!tokenAddress || !tokenSymbol || !buyAmountBNB) {
      return res.status(400).json({ error: '需要 tokenAddress, tokenSymbol, buyAmountBNB' });
    }
    const pos = strategy.addPosition({
      tokenAddress,
      tokenSymbol,
      buyAmountBNB: parseFloat(buyAmountBNB),
      buyAmountToken: parseFloat(buyAmountToken || 0),
      buyPriceUSD: parseFloat(buyPriceUSD || 0),
      txHash: txHash || '',
      chain: chain || undefined,
    });
    res.json({ success: true, position: pos });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 删除持仓 ---
app.delete('/api/positions/:id', (req, res) => {
  try {
    const result = strategy.removePosition(req.params.id);
    if (!result) return res.status(404).json({ error: '持仓不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 决策日志（分页）---
app.get('/api/decisions', (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(strategy.getDecisions(count, offset));
});

// --- BSC 交易日志（分页）---
app.get('/api/logs', (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(getRecentLogs(count, offset));
});

// --- 引擎设置 ---
app.get('/api/settings', (req, res) => {
  res.json(getStatus());
});

app.post('/api/settings', (req, res) => {
  try {
    updateSettings(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 引擎控制 ---
app.post('/api/engine/start', (req, res) => {
  try {
    startEngine(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/engine/stop', (req, res) => {
  try {
    stopEngine();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 策略控制 ---
app.post('/api/strategy/start', async (req, res) => {
  try {
    await strategy.startStrategy();
    appendLog({ type: 'system', action: 'strategy_start', chain: typeof strategy.getCurrentChain === 'function' ? strategy.getCurrentChain() : 'unknown', detail: '策略引擎已启动' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/strategy/stop', (req, res) => {
  try {
    strategy.stopStrategy();
    appendLog({ type: 'system', action: 'strategy_stop', chain: typeof strategy.getCurrentChain === 'function' ? strategy.getCurrentChain() : 'unknown', detail: '策略引擎已停止' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- BSC 手动买入 ---
app.post('/api/trade/buy', async (req, res) => {
  try {
    const { tokenAddress, tokenSymbol, tokenName, liquidityUSD, priceUSD, score } = req.body;
    const amountBNB = req.body.amountBNB;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });
    const candidate = { tokenAddress, tokenSymbol, tokenName, liquidityUSD: liquidityUSD || 0, priceUSD: priceUSD || 0, score: score || 0 };
    const result = await strategy.manualBuy(candidate, amountBNB);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- BSC 手动卖出 ---
app.post('/api/trade/sell', async (req, res) => {
  try {
    const { positionId, percent } = req.body;
    if (!positionId) return res.status(400).json({ error: '需要 positionId' });
    const result = await strategy.sellPosition(positionId, percent || 100, 'manual');
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 清仓所有 ---
app.post('/api/trade/liquidate', async (req, res) => {
  try {
    const results = await strategy.liquidateAll();
    res.json({ success: true, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 代币分析（手动输入合约地址）---
app.post('/api/token/analyze', async (req, res) => {
  try {
    const { tokenAddress, chain: reqChain } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });

    // 判断链：0x开头 = BSC，base58 = SOL
    const chain = reqChain || (/^0x/i.test(tokenAddress) ? 'bsc' : 'sol');

    if (chain === 'sol') {
      // SOL 链分析（Jupiter + DexScreener）
      let dexData = {};
      try {
        dexData = await screener.analyzeToken(tokenAddress, 'sol');
        if (dexData.error) dexData = {};
      } catch { dexData = {}; }
      const result = { ...dexData, chain: 'sol', chainSimulation: null };

      // Jupiter 价格
      try {
        const jupPrice = await solEngine.getJupiterPrice(tokenAddress);
        result.jupiterPriceSOL = jupPrice.priceInSOL;
        result.jupiterPriceUSD = jupPrice.priceInUSD;
      } catch {}

      // SOL 链上数据
      try {
        const onChain = await solEngine.analyzeSolToken(tokenAddress);
        result.onChainData = onChain;
      } catch {}

      // 仿真（仅报价，不交易）
      if (solEngine.isSolInitialized()) {
        try {
          const buySim = await solEngine.simulateSolBuy(tokenAddress, 0.01);
          result.chainSimulation = { buyTaxPct: buySim.priceImpactPct, buyHoneypot: false };
        } catch { result.chainSimulation = { error: 'SOL仿真失败' }; }
      }

      return res.json({ success: true, result });
    }

    // BSC 链分析（原有逻辑）
    const dexData = await screener.analyzeToken(tokenAddress, 'bsc');
    if (dexData.error) return res.json({ error: dexData.error, tokenAddress });

    const result = { ...dexData, chain: 'bsc', chainSimulation: null };

    try {
      const buySim = await simulateBuy(tokenAddress, 0.001);
      result.chainSimulation = { buyTaxPct: buySim.buyTaxPct, buyHoneypot: buySim.isHoneypot };
    } catch { result.chainSimulation = { buyTaxPct: null, buyHoneypot: null, error: '引擎未初始化' }; }

    try {
      const sellSim = await simulateSell(tokenAddress, 0.001);
      result.chainSimulation.sellTaxPct = sellSim.sellTaxPct;
      result.chainSimulation.sellHoneypot = sellSim.isHoneypot;
    } catch { result.chainSimulation.sellTaxPct = null; result.chainSimulation.sellHoneypot = null; }

    try {
      const taxInfo = await checkTokenTax(tokenAddress);
      result.chainSimulation.onChainBuyTax = taxInfo.buyTax;
      result.chainSimulation.onChainSellTax = taxInfo.sellTax;
      result.chainSimulation.onChainMaxTax = taxInfo.maxTax;
    } catch {}

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 强制扫描 ---
app.post('/api/screener/scan', async (req, res) => {
  try {
    const candidates = await screener.forceScan();
    res.json({ success: true, count: candidates.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 更新持仓配置 ---
app.post('/api/positions/:id/config', (req, res) => {
  try {
    const pos = strategy.updatePositionConfig(req.params.id, req.body);
    res.json({ success: true, position: pos });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 删除持仓 ---
app.delete('/api/positions/:id', (req, res) => {
  try {
    const result = strategy.removePosition(req.params.id);
    if (!result) return res.status(404).json({ error: '持仓不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 获取环境变量（脱敏）---
app.get('/api/env', (req, res) => {
  res.json({
    MIN_LIQUIDITY_USD: process.env.MIN_LIQUIDITY_USD,
    MAX_AGE_HOURS: process.env.MAX_AGE_HOURS,
    MIN_VOLUME_USD: process.env.MIN_VOLUME_USD,
    SCAN_INTERVAL_SEC: process.env.SCAN_INTERVAL_SEC,
    BUY_MIN_BNB: process.env.BUY_MIN_BNB,
    BUY_MAX_BNB: process.env.BUY_MAX_BNB,
    LOSS_CUT_PERCENT: process.env.LOSS_CUT_PERCENT,
    TAKE_PROFIT_PERCENT: process.env.TAKE_PROFIT_PERCENT,
    TRAILING_STOP_PERCENT: process.env.TRAILING_STOP_PERCENT,
    SLIPPAGE: process.env.SLIPPAGE,
    PORT: process.env.PORT,
    MIN_TXNS_H1: process.env.MIN_TXNS_H1,
    MIN_BUY_SELL_RATIO_H1: process.env.MIN_BUY_SELL_RATIO_H1,
    MAX_BUY_SELL_RATIO_H1: process.env.MAX_BUY_SELL_RATIO_H1,
    MIN_BUY_SELL_RATIO_M5: process.env.MIN_BUY_SELL_RATIO_M5,
    MAX_BUY_SELL_RATIO_M5: process.env.MAX_BUY_SELL_RATIO_M5,
    MIN_LIQ_MCAP_RATIO: process.env.MIN_LIQ_MCAP_RATIO,
    MAX_LIQ_MCAP_RATIO: process.env.MAX_LIQ_MCAP_RATIO,
    MIN_PRICE_USD: process.env.MIN_PRICE_USD,
    MAX_PRICE_USD: process.env.MAX_PRICE_USD,
    MAX_POSITIONS: process.env.MAX_POSITIONS,
    MIN_SCORE: process.env.MIN_SCORE,
    PRICE_DIVERGENCE_LIMIT: process.env.PRICE_DIVERGENCE_LIMIT,
    MIN_CONFIRMATIONS: process.env.MIN_CONFIRMATIONS,
    SCAN_ADAPTIVE_ENABLED: process.env.SCAN_ADAPTIVE_ENABLED,
    SCAN_MIN_INTERVAL: process.env.SCAN_MIN_INTERVAL,
    SCAN_MAX_INTERVAL: process.env.SCAN_MAX_INTERVAL,
    BUY_ENABLE_SIMULATION: process.env.BUY_ENABLE_SIMULATION,
    BUY_MAX_TAX_ALLOWED: process.env.BUY_MAX_TAX_ALLOWED,
    BATCH_BUY_ENABLED: process.env.BATCH_BUY_ENABLED,
    BATCH_BUY_MIN_SCORE: process.env.BATCH_BUY_MIN_SCORE,
    BATCH_BUY_SPLIT: process.env.BATCH_BUY_SPLIT,
    BSCSCAN_API_KEY: process.env.BSCSCAN_API_KEY ? "已配置" : "未配置",
    BSCSCAN_DEEP_CHECK: process.env.BSCSCAN_DEEP_CHECK,
    SOL_RPC: process.env.SOL_RPC ? "已配置" : "未配置",
  });
});

// ============ 保存设置（写入 .env + 运行时生效）============
app.post('/api/env/save', (req, res) => {
  try {
    const settings = req.body;
    const envPath = path.join(__dirname, '.env');

    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}

    const SAVEABLE_KEYS = [
      'MIN_LIQUIDITY_USD', 'MAX_AGE_HOURS', 'MIN_VOLUME_USD', 'MAX_TAX_PERCENT',
      'SCAN_INTERVAL_SEC', 'BUY_MIN_BNB', 'BUY_MAX_BNB', 'SLIPPAGE',
      'LOSS_CUT_PERCENT', 'TAKE_PROFIT_PERCENT', 'TRAILING_STOP_PERCENT',
      'MIN_TXNS_H1', 'MIN_BUY_SELL_RATIO_H1', 'MAX_BUY_SELL_RATIO_H1',
      'MIN_BUY_SELL_RATIO_M5', 'MAX_BUY_SELL_RATIO_M5',
      'MIN_LIQ_MCAP_RATIO', 'MAX_LIQ_MCAP_RATIO',
      'MIN_PRICE_USD', 'MAX_PRICE_USD', 'MAX_POSITIONS', 'MIN_SCORE',
      'PRICE_DIVERGENCE_LIMIT', 'MIN_CONFIRMATIONS',
      'SCAN_ADAPTIVE_ENABLED', 'SCAN_MIN_INTERVAL', 'SCAN_MAX_INTERVAL',
      'BUY_ENABLE_SIMULATION', 'BUY_MAX_TAX_ALLOWED',
      'BATCH_BUY_ENABLED', 'BATCH_BUY_MIN_SCORE', 'BATCH_BUY_SPLIT',
      'MAX_DAILY_LOSS_BNB',
    ];

    let updatedKeys = [];

    for (const key of SAVEABLE_KEYS) {
      if (settings[key] !== undefined && settings[key] !== null && settings[key] !== '') {
        const value = settings[key].toString();
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `\n${key}=${value}`;
        }
        process.env[key] = value;
        updatedKeys.push(key);
      }
    }

    fs.writeFileSync(envPath, envContent);

    if (settings.SCAN_INTERVAL_SEC) {
      screener.updateScanInterval(parseInt(settings.SCAN_INTERVAL_SEC));
    }

    console.log(`[Server] 💾 设置已保存: ${updatedKeys.length} 项`);
    res.json({ success: true, updatedKeys, message: `已更新 ${updatedKeys.length} 项设置` });
  } catch (err) {
    console.error(`[Server] ❌ 保存设置失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============ 钱包 API ============

// --- 导入钱包（自动检测 BSC/SOL）---
app.post('/api/wallets', async (req, res) => {
  try {
    const { privateKey, label, chain: forceChain } = req.body;
    if (!privateKey) return res.status(400).json({ error: '需要 privateKey' });
    const result = importWallet(privateKey, label || '', forceChain || null);
    
    // 如果是第一个钱包，自动初始化对应引擎
    if (result.imported) {
      if (result.chain === 'bsc' && getWalletCount() >= 1) {
        const pk = getActivePrivateKey();
        if (pk) await reinitEngine(pk);
      }
      if (result.chain === 'sol') {
        const solPk = getActivePrivateKeyForChain('sol');
        if (solPk) {
          try { await solEngine.initSolEngine(solPk); } catch(e) { console.log('[Server] SOL引擎初始化:', e.message); }
        }
      }
    }
    res.json({ success: true, wallet: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 钱包列表 ---
app.get('/api/wallets', (req, res) => {
  res.json({ wallets: getWallets(true), count: getWalletCount() });
});

// --- 切换钱包 ---
app.post('/api/wallets/switch', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: '需要 address' });
    const wallet = switchWallet(address);
    
    if (wallet.chain === 'bsc') {
      const pk = getActivePrivateKey();
      if (pk) await reinitEngine(pk);
    }
    
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 删除钱包 ---
app.delete('/api/wallets/:address', async (req, res) => {
  try {
    const wasActive = getActiveWallet()?.toLowerCase() === req.params.address?.toLowerCase();
    removeWallet(req.params.address);
    if (wasActive && hasWallets()) {
      const pk = getActivePrivateKey();
      if (pk) await reinitEngine(pk);
    } else if (wasActive && !hasWallets()) {
      stopEngine();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ 余额 API ============

app.get('/api/balances/:address', async (req, res) => {
  try {
    const watchedTokens = getWatchedTokens().map(t => t.address);
    const balances = await getBalancesForWallet(req.params.address, watchedTokens);
    res.json({ balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SOL 链 API ============

// --- SOL 引擎初始化 ---
app.post('/api/sol/init', async (req, res) => {
  try {
    const { privateKey } = req.body;
    let pk = privateKey;
    if (!pk) {
      pk = getActivePrivateKeyForChain('sol');
    }
    if (!pk) {
      return res.status(400).json({ error: '没有找到 SOL 钱包私钥' });
    }
    const address = await solEngine.initSolEngine(pk);
    res.json({ success: true, address, balance: await solEngine.getSolBalance() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- SOL 余额 ---
app.get('/api/sol/balance', async (req, res) => {
  try {
    if (!solEngine.isSolInitialized()) {
      // 自动尝试初始化
      const pk = getActivePrivateKeyForChain('sol');
      if (pk) {
        try { await solEngine.initSolEngine(pk); } catch {}
      }
    }
    const balance = await solEngine.getSolBalance();
    const walletAddress = solEngine.getSolWalletAddress();
    res.json({ balance, walletAddress, initialized: solEngine.isSolInitialized() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SOL 买入 ---
app.post('/api/sol/trade/buy', async (req, res) => {
  try {
    const { tokenMint, amountSOL, slippageBps } = req.body;
    if (!tokenMint || !amountSOL) return res.status(400).json({ error: '需要 tokenMint 和 amountSOL' });
    
    if (!solEngine.isSolInitialized()) {
      const pk = getActivePrivateKeyForChain('sol');
      if (!pk) return res.status(400).json({ error: 'SOL 引擎未初始化，请先导入 SOL 钱包' });
      await solEngine.initSolEngine(pk);
    }
    
    const result = await solEngine.executeSolBuy(tokenMint, amountSOL, slippageBps || 100);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- SOL 卖出 ---
app.post('/api/sol/trade/sell', async (req, res) => {
  try {
    const { tokenMint, amountToken, tokenDecimals, slippageBps } = req.body;
    if (!tokenMint || !amountToken) return res.status(400).json({ error: '需要 tokenMint 和 amountToken' });
    
    if (!solEngine.isSolInitialized()) {
      const pk = getActivePrivateKeyForChain('sol');
      if (!pk) return res.status(400).json({ error: 'SOL 引擎未初始化，请先导入 SOL 钱包' });
      await solEngine.initSolEngine(pk);
    }
    
    const result = await solEngine.executeSolSell(tokenMint, amountToken, tokenDecimals || 6, slippageBps || 100);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- SOL 日志 ---
app.get('/api/sol/logs', (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(solEngine.getSolRecentLogs(count, offset));
});

// --- SOL 报价查询 ---
app.post('/api/sol/quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, decimals } = req.body;
    if (!inputMint || !outputMint || !amount) return res.status(400).json({ error: '需要 inputMint, outputMint, amount' });
    const quote = await solEngine.getQuote(inputMint, outputMint, amount, 100, decimals || 9);
    res.json({ success: true, quote });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============ 跟踪代币 API ============

app.post('/api/tokens/watch', (req, res) => {
  try {
    const { tokenAddress, symbol, chain } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });
    const tokens = addWatchedToken(tokenAddress, symbol || '', chain || 'bsc');
    res.json({ success: true, tokens });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tokens/watch', (req, res) => {
  try {
    const { tokenAddress } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });
    const tokens = removeWatchedToken(tokenAddress);
    res.json({ success: true, tokens });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/tokens/watch', (req, res) => {
  res.json({ tokens: getWatchedTokens() });
});

// ============ 启动服务 ============

// ============ CEX 风控 API ============

app.get('/api/cex/risk/status', async (req, res) => {
  try {
    res.json(riskManager.getStatus(req.query.exchangeId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 追踪止盈检查间隔
app.get('/api/cex/trail-interval', (req, res) => {
  try { res.json(cexStrategy.getTrailInterval()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/trail-interval', (req, res) => {
  try {
    const { interval } = req.body;
    const result = cexStrategy.setTrailInterval(interval);
    if (result.success) {
      appendCexLog('trail_interval', `追踪止盈间隔改为 ${result.intervalMs / 1000}s`);
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/risk/reset', (req, res) => {
  try {
    riskManager.resetCircuitBreaker();
    appendCexLog('risk_reset', '熔断已重置');
    res.json({ success: true, status: riskManager.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/strategy/status', (req, res) => {
  try {
    res.json(cexStrategy.getStrategyStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/strategy/signals', (req, res) => {
  try {
    res.json(cexStrategy.getSignalsSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/cex/strategy/trail-state', (req, res) => {
  try {
    res.json(cexStrategy.getTrailingState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 策略模式（双币/单币）切换
// 夏普比率 API
app.get('/api/cex/strategy/sharpe', (req, res) => {
  try {
    const symbol = req.query.symbol;
    if (symbol) {
      res.json({ symbol, sharpe: adaptive.calcSharpeRatio(symbol) });
    } else {
      res.json(adaptive.getAllSharpeRatios());
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/strategy/mode', (req, res) => {
  try {
    res.json(cexStrategy.getStrategyMode());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/strategy/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode || !['dual', 'single'].includes(mode)) {
      return res.status(400).json({ error: '模式仅支持 dual(双币) 或 single(单币)' });
    }
    // 先停止当前策略
    if (cexStrategy.getStrategyStatus().running) {
      cexStrategy.stopStrategy();
    }
    // 设置新模式
    const result = cexStrategy.setStrategyMode(mode);
    if (!result.success) {
      return res.status(400).json(result);
    }
    // 持久化模式到 .env
    if (result.success) {
      try {
        const fs = require("fs");
        const envPath = "/root/autotrade/.env";
        let env = fs.readFileSync(envPath, "utf-8");
        if (/CEX_STRATEGY_MODE=/.test(env)) {
          env = env.replace(/CEX_STRATEGY_MODE=.*/, "CEX_STRATEGY_MODE=" + mode);
        } else {
          env += "\nCEX_STRATEGY_MODE=" + mode + "\n";
        }
        fs.writeFileSync(envPath, env);
      } catch(e) {
        console.log("[Strategy] \u26a0\ufe0f \u6301\u4e85\u5316\u6a21\u5f0f\u5931\u8d25:", e.message);
      }
    }
    // 获取新模式的交易对
    const modeInfo = cexStrategy.getStrategyMode();
    const symbols = modeInfo.mode === 'dual' 
      ? ['BTC/USDT:USDT', 'ETH/USDT:USDT'] 
      : [modeInfo.primarySymbol];
    // 重启策略
    const startResult = await cexStrategy.startStrategy(symbols);
    if (startResult.success) {
      appendCexLog('strategy_mode', `策略模式切换为${mode === 'dual' ? '双币(BTC+ETH)' : '单币('+modeInfo.primarySymbol+')'}，仓位${mode === 'dual' ? '对半分' : '全给主币'}`);
    }
    res.json({ success: true, mode, symbols, prevMode: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/strategy/start', async (req, res) => {
  try {
    const { symbols, exchangeMap } = req.body;
    // 应用交易所映射（如有）
    if (exchangeMap) {
      for (const [sym, exId] of Object.entries(exchangeMap)) {
        cexStrategy.setSymbolExchange(sym, exId);
      }
    }
    const result = await cexStrategy.startStrategy(symbols || ['BTC/USDT:USDT']);
    if (result.success) appendCexLog('strategy_start', '[' + cexEngine.getExchangeLabel(req.body.exchangeMap?.[Object.keys(req.body.exchangeMap||{})[0]] || 'binance') + '] 策略启动 ' + ((symbols || ['BTC/USDT:USDT']).map(s => s.replace(':USDT','')).join(', ')));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取/设置交易对的交易所映射
app.get('/api/cex/strategy/exchange-map', (req, res) => {
  res.json({ exchangeMap: cexStrategy.getSymbolExchangeMap() });
});

app.post('/api/cex/strategy/exchange-map', (req, res) => {
  try {
    const { symbol, exchangeId } = req.body;
    if (!symbol || !exchangeId) {
      return res.status(400).json({ error: '需要 symbol 和 exchangeId 参数' });
    }
    const supported = cexEngine.getSupportedExchanges();
    if (!supported.includes(exchangeId)) {
      return res.status(400).json({ error: `不支持的交易所: ${exchangeId}，可用: ${supported.join(', ')}` });
    }
    cexStrategy.setSymbolExchange(symbol, exchangeId);
    res.json({ success: true, symbol, exchangeId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/strategy/stop', (req, res) => {
  try {
    const result = cexStrategy.stopStrategy();
    if (result.success) appendCexLog('strategy_stop', '[全部] 策略停止');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE 实时行情推送
app.get('/api/cex/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  async function pushData() {
    if (res.writableEnded) return;
    try {
      const [tickerEth, tickerBtc, positions, risk, signals, strategyStatus] = await Promise.allSettled([
        cexEngine.getTicker('ETH/USDT').catch(() => null),
        cexEngine.getTicker('BTC/USDT').catch(() => null),
        cexEngine.getPositions().catch(() => ({ success: false, positions: [] })),
        Promise.resolve(riskManager.getStatus()).catch(() => ({})),
        Promise.resolve(cexStrategy.getSignalsSummary()).catch(() => ({})),
        Promise.resolve(cexStrategy.getStrategyStatus()).catch(() => ({})),
      ]);

      const tickerData = {};
      if (tickerEth.value?.success && tickerEth.value?.ticker) {
        tickerData['ETH/USDT'] = tickerEth.value.ticker;
      }
      if (tickerBtc.value?.success && tickerBtc.value?.ticker) {
        tickerData['BTC/USDT'] = tickerBtc.value.ticker;
      }

      const payload = {
        type: 'market',
        ticker: tickerData[Object.keys(tickerData)[0]] || null,
        tickers: tickerData,
        positions: positions.value?.positions || null,
        risk: risk.value || {},
        signals: signals.value || {},
        strategyRunning: strategyStatus.value?.running || false,
        funding: tickerData['ETH/USDT']?.fundingRate || tickerData['BTC/USDT']?.fundingRate || null,
        timestamp: Date.now(),
      };
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    } catch (e) {}
  }

  await pushData();
  const sseInterval = setInterval(() => pushData(), 3000);
  req.on('close', () => { clearInterval(sseInterval); });
});

// ============ CEX 合约交易 API ========== CEX 合约交易 API ============

app.get('/api/cex/status', (req, res) => {
  try {
    res.json(cexEngine.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/exchanges', (req, res) => {
  res.json({ supported: cexEngine.getSupportedExchanges(), status: cexEngine.getStatus() });
});

app.post('/api/cex/exchanges', async (req, res) => {
  try {
    const { exchangeId, label, apiKey, secret, password, testnet } = req.body;
    if (!exchangeId || !apiKey || !secret) {
      return res.status(400).json({ error: '缺少必填参数: exchangeId, apiKey, secret' });
    }
    const result = cexEngine.addExchange({ exchangeId, label, apiKey, secret, password, testnet });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cex/exchanges/:exchangeId', (req, res) => {
  try {
    res.json(cexEngine.removeExchange(req.params.exchangeId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/exchanges/switch', (req, res) => {
  try {
    const result = cexEngine.setActiveExchange(req.body.exchangeId);
    // 同步更新策略引擎的交易所映射——所有活跃交易对切换到新交易所
    if (result.success && cexStrategy && typeof cexStrategy.setSymbolExchange === 'function') {
      try {
        const activeSymbols = cexStrategy.getStrategyStatus().symbols || [];
        for (const sym of activeSymbols) {
          cexStrategy.setSymbolExchange(sym, req.body.exchangeId);
        }
        console.log(`[Server] 🔄 策略交易对已全部切换到 ${req.body.exchangeId}`);
      } catch(e) { /* 策略未运行，忽略 */ }
    }
    appendCexLog('exchange_switch', `切换到 ${cexEngine.getExchangeLabel(req.body.exchangeId)}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/balance', async (req, res) => {
  try {
    const result = await cexEngine.getBalance(req.query.exchangeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/orders', async (req, res) => {
  try {
    const { symbol, exchangeId } = req.query;
    const result = await cexEngine.getOpenOrders(symbol, exchangeId);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/positions', async (req, res) => {
  try {
    const result = await cexEngine.getPositions(req.query.exchangeId, req.query.symbol);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/styles', (req, res) => {
  res.json(cexEngine.getStyles());
});

app.get('/api/cex/style', (req, res) => {
  res.json(cexEngine.getCurrentStyle());
});

app.post('/api/cex/style', (req, res) => {
  try {
    const { style, exchangeId } = req.body;
    const r = cexEngine.setStyle(style);
    if (r.success) appendCexLog('style_change', '[' + cexEngine.getExchangeLabel(exchangeId||'binance') + '] 切换风格: ' + ({conservative:'保守', moderate:'稳健', aggressive:'激进'}[style] || style));
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/position/calculate', (req, res) => {
  try {
    const { totalCapital } = req.body;
    const capital = parseFloat(totalCapital) || 30;
    res.json(cexEngine.calculatePosition(capital));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/leverage', async (req, res) => {
  try {
    const { symbol, leverage, exchangeId } = req.body;
    const r = await cexEngine.setLeverage(symbol, leverage, exchangeId);
    if (r.success) appendCexLog('leverage_change', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] ${symbol} 杠杆: ${leverage}x`);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/position/open', async (req, res) => {
  try {
    const { symbol, side, contracts, exchangeId, leverage, stopLoss, takeProfit, marginMode } = req.body;
    if (!symbol || !side || !contracts) {
      return res.status(400).json({ error: '缺少必填参数: symbol, side, amount' });
    }
    const result = await cexEngine.openPosition(symbol, side, parseFloat(contracts), exchangeId, {
      leverage, stopLoss, takeProfit, marginMode,
    });
    if (result.success) {
      appendCexLog('manual_open', '[' + cexEngine.getExchangeLabel(exchangeId||'binance') + '] 手动开' + (side === 'long' ? '多' : '空') + ' ' + symbol + ' ' + parseFloat(contracts) + '张 ' + (leverage||'?') + 'x');
    } else {
      appendCexLog('manual_open_fail', '[' + cexEngine.getExchangeLabel(exchangeId||'binance') + '] 开仓失败 ' + symbol + ': ' + (result.error || ''));
    }
    res.json(result);
  } catch (err) {
    appendCexLog('manual_open_fail', '[' + cexEngine.getExchangeLabel(req.body.exchangeId||'binance') + '] 开仓异常 ' + symbol + ': ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/position/close', async (req, res) => {
  try {
    const { symbol, side, exchangeId, percent } = req.body;
    if (!symbol || !side) {
      return res.status(400).json({ error: '缺少必填参数: symbol, side' });
    }
    const result = await cexEngine.closePosition(symbol, side, exchangeId, { percent });
    if (result.success) {
      appendCexLog('manual_close', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 手动平${side === 'long' ? '多' : '空'} ${symbol} 盈亏: ${result.realizedPnl?.toFixed(4) || '?'}`, { realizedPnl: result.realizedPnl, pnlPercent: result.pnlPercent, closePrice: result.closePrice });
    }
    res.json(result);
  } catch (err) {
    appendCexLog('manual_close_fail', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 平仓失败 ${symbol}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/ticker', async (req, res) => {
  try {
    const { symbol, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getTicker(symbol, exchangeId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/ohlcv', async (req, res) => {
  try {
    const { symbol, timeframe, limit, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getOHLCV(symbol, timeframe, parseInt(limit) || 100, exchangeId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/funding', async (req, res) => {
  try {
    const { symbol, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getFundingRate(symbol, exchangeId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

import { appendCexLog, getCexLogs } from './cex-logger.js';
import * as cexIntel from './cex-intel.js';

// 操作日志 API
app.get('/api/cex/logs', (req, res) => {
  const count = parseInt(req.query.count) || 20;
  const offset = parseInt(req.query.offset) || 0;
  res.json(getCexLogs(count, offset));
});

// 客户端记录事件（如调节阀、UI操作）
app.post('/api/cex/log', (req, res) => {
  try {
    const { type, detail } = req.body;
    if (!type) return res.status(400).json({ error: '缺少 type' });
    appendCexLog(type, detail, { source: 'ui' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 情报系统 API ============

app.get('/api/cex/intel', (req, res) => {
res.header('Access-Control-Allow-Origin', '*');
  res.json(cexIntel.getIntel());
});

app.get('/api/cex/intel/factors', (req, res) => {
  res.json(cexIntel.getAdjustmentFactors());
});

app.post('/api/cex/intel', async (req, res) => {
  try {
    const { newsContent } = req.body;
    const result = await cexIntel.updateIntel(newsContent);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    OKNC 自动土狗交易系统 v3.0            ║');
  // load cached market intel
  cexIntel.loadIntel();
  console.log('║    多链 · 多钱包 · 自动交易              ║');
  console.log('║    BSC + Solana · 密码认证 · PWA         ║');
  console.log('╚══════════════════════════════════════════╝');

  // 1. 初始化钱包管理器
  initWalletManager();

  // 2. 初始化 BSC 引擎
  if (hasWallets()) {
    try {
      const pk = getActivePrivateKeyForChain('bsc');
      if (pk) {
        await reinitEngine(pk);
        console.log(`[Server] ✅ BSC 引擎初始化成功`);
      }
    } catch (err) {
      console.error(`[Server] ❌ BSC 引擎初始化失败: ${err.message}`);
    }
  } else {
    try {
      await initEngine();
      console.log('[Server] ✅ BSC 引擎初始化成功（.env 模式）');
      const envKey = process.env.PRIVATE_KEY;
      if (envKey && !envKey.includes('你的钱包私钥')) {
        importWallet(envKey, '默认钱包 (.env)');
        console.log('[Server] 💼 .env 钱包已自动导入');
      }
    } catch (err) {
      console.log('[Server] ⚠️ 无可用 BSC 钱包，请在面板导入 BSC 私钥');
    }
  }

  // 3. 初始化 SOL 引擎（如果有 SOL 钱包）
  try {
    const solPk = getActivePrivateKeyForChain('sol');
    if (solPk) {
      await solEngine.initSolEngine(solPk);
      const solBal = await solEngine.getSolBalance();
      console.log(`[Server] ✅ SOL 引擎初始化成功，余额: ${solBal.toFixed(4)} SOL`);
    } else {
      console.log('[Server] ⚠️ 无 SOL 钱包，请在面板导入 SOL 私钥');
    }
  } catch (err) {
    console.log(`[Server] ⚠️ SOL 引擎初始化跳过: ${err.message}`);
  }

  // 4. 初始化 CEX 合约引擎
  try {
    const cexInit = cexEngine.initAllExchanges();
    if (cexInit.length > 0) {
      console.log(`[Server] ✅ CEX 合约引擎已初始化: ${cexInit.join(", ")}`);
    } else {
      console.log('[Server] ⚠️ 未配置交易所，请在面板添加 CEX API Key');
    }
  } catch (err) {
    console.log(`[Server] ⚠️ CEX 初始化跳过: ${err.message}`);
  }

  // 5. 启动 DexScreener 扫描
  // CEX 策略引擎待用户在面板启动
  console.log('[Server] 🧠 CEX 策略引擎已就绪，可通过 API 启动');
  // 初始化风控
  try {
    await riskManager.initRiskManager();
  } catch (err) {
    console.log(`[Server] ⚠️ 风控初始化跳过: ${err.message}`);
  }

  console.log('[Server] 🔍 启动 DexScreener 扫描...');
  screener.startScanning();

  // 6. 自动启动 CEX 合约策略
  (async () => {
    try {
      console.log('[Server] 🚀 自动启动 CEX 合约策略...');
      const modeInfo = cexStrategy.getStrategyMode();
      const symbols = modeInfo.mode === 'dual'
        ? ['BTC/USDT:USDT', 'ETH/USDT:USDT']
        : [modeInfo.primarySymbol];
      const result = await cexStrategy.startStrategy(symbols);
      if (result.success) {
      const symbolsStr = symbols.map(s => s.replace(':USDT','')).join(', ');
      appendCexLog('strategy_start', '[' + cexEngine.getExchangeLabel() + '] 策略启动 ' + symbolsStr + ' (自动)');
      console.log('[Server] ✅ CEX 合约策略已自动启动 (' + symbolsStr + ')');
        
        
      }
    } catch (err) {
      console.log(`[Server] ⚠️ CEX 策略自动启动失败: ${err.message}`);
    }
  })();

  // 7. 启动 Web 服务
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 🌐 控制面板: http://localhost:${PORT}`);
    console.log(`[Server] 🔒 密码认证已启用`);
    
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`[Server] 🌍 网络访问: http://${net.address}:${PORT}`);
        }
      }
    }
  });
}

main().catch(err => {
  console.error(`[Server] 启动失败: ${err.message}`);
  process.exit(1);
});