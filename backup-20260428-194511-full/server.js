/**
 * server.js — 自动土狗交易系统主服务
 *
 * 功能：
 * - 启动 DexScreener 扫描引擎
 * - 启动策略引擎（持仓监控 + 止盈止损）
 * - 提供 RESTful API
 * - 提供 Web 监控面板
 * - 密码认证保护
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
  getWalletAddress, getBalancesForWallet, reinitEngine, simulateBuy, simulateSell, checkTokenTax
} from './engine.js';
import {
  importWallet, removeWallet, switchWallet,
  getWallets, getActivePrivateKey, getActiveWallet,
  getWalletCount, hasWallets, initWalletManager,
  addWatchedToken, removeWatchedToken, getWatchedTokens
} from './wallet-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

// ============ Express 应用 ============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 认证系统 ============
const AUTH_PASSWORD=process.env.AUTH_PASSWORD || 'oknc2018';
const AUTH_PASSWORD_READONLY=process.env.AUTH_PASSWORD_READONLY || 'oknc888';
const AUTH_SECRET=process.env.AUTH_SECRET || crypto.randomBytes(16).toString('hex');
const AUTH_TOKEN_EXPIRY=24 * 60 * 60 * 1000; // 24小时

const validTokens = new Map();

function generateToken(role = 'admin') {
  return crypto.createHash('sha256')
    .update(AUTH_PASSWORD + AUTH_SECRET + Date.now() + role)
    .digest('hex');
}

// 只读中间件 — 只读账号不能执行写操作
function readonlyMiddleware(req, res, next) {
  if (req.user && req.user.role === 'readonly') {
    return res.status(403).json({ error: '只读账号，无权执行此操作', code: 'READONLY' });
  }
  next();
}

// 认证中间件
function authMiddleware(req, res, next) {
  // 登录和检查接口不需要认证
  if (req.path === '/api/auth/login' || req.path === '/api/auth/check') {
    return next();
  }
  // 静态文件不需要认证
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
  // 刷新过期时间
  tokenData.expiresAt = Date.now() + AUTH_TOKEN_EXPIRY;
  req.user = tokenData;
  next();
}
app.use(authMiddleware);
// 只读中间件 — 拦截交易/策略相关操作
app.use((req, res, next) => {
  if (req.user && req.user.role === 'readonly') {
    const blockedPaths = ['/api/trade/buy', '/api/trade/sell', '/api/trade/liquidate',
                          '/api/strategy/start', '/api/strategy/stop',
                          '/api/engine/start', '/api/engine/stop'];
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

// --- 检查登录状态 ---
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
    screener: {
      running: true,
      lastScan: screener.getLastScanTime(),
      candidateCount: screener.getCandidates().length,
    },
    strategy: strategy.getStrategyStatus(),
    engine: getStatus(),
    walletAddress: getWalletAddress(),
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
    // 切换链后重新触发一次扫描
    screener.forceScan().catch(() => {});
    res.json({ success: true, chain: screener.getCurrentChain() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 余额 ---
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

// --- 持仓列表 ---
app.get('/api/positions', (req, res) => {
  res.json(strategy.getPositions());
});

// --- 决策日志（分页）---
app.get('/api/decisions', (req, res) => {
  const count = parseInt(req.query.count || '50', 10);
  const offset = parseInt(req.query.offset || '0', 10);
  res.json(strategy.getDecisions(count, offset));
});

// --- 交易日志（分页）---
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
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/strategy/stop', (req, res) => {
  try {
    strategy.stopStrategy();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 手动买入 ---
app.post('/api/trade/buy', async (req, res) => {
  try {
    const { tokenAddress, tokenSymbol, tokenName, liquidityUSD, priceUSD, score } = req.body;
    const amountBNB = req.body.amountBNB;
    if (!tokenAddress) {
      return res.status(400).json({ error: '需要 tokenAddress' });
    }
    const candidate = {
      tokenAddress, tokenSymbol, tokenName,
      liquidityUSD: liquidityUSD || 0,
      priceUSD: priceUSD || 0,
      score: score || 0,
    };
    const result = await strategy.manualBuy(candidate, amountBNB);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 手动卖出 ---
app.post('/api/trade/sell', async (req, res) => {
  try {
    const { positionId, percent } = req.body;
    if (!positionId) return res.status(400).json({ error: '需要 positionId' });
    const result = await strategy.sellPosition(positionId, percent || 100);
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
    const { tokenAddress } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });

    // 1. DexScreener 数据 + 评分
    const dexData = await screener.analyzeToken(tokenAddress);
    if (dexData.error) return res.json({ error: dexData.error, tokenAddress });

    const result = {
      ...dexData,
      chainSimulation: null,
    };

    // 2. 链上仿真检测（仅当引擎已初始化时）
    try {
      const buySim = await simulateBuy(tokenAddress, 0.001);
      result.chainSimulation = {
        buyTaxPct: buySim.buyTaxPct,
        buyHoneypot: buySim.isHoneypot,
      };
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
    } catch { /* 可选 */ }

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

// --- 获取环境变量（脱敏）---
app.get('/api/env', (req, res) => {
  res.json({
    MIN_LIQUIDITY_USD: process.env.MIN_LIQUIDITY_USD,
    MAX_AGE_HOURS: process.env.MAX_AGE_HOURS,
    MIN_VOLUME_USD: process.env.MIN_VOLUME_USD,
    MAX_TAX_PERCENT: process.env.MAX_TAX_PERCENT,
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
    BSCSCAN_API_KEY: process.env.BSCSCAN_API_KEY ? (process.env.BSCSCAN_API_KEY.slice(0,4) + '***') : '',
    BSCSCAN_API_KEY: process.env.BSCSCAN_API_KEY ? "已配置" : "未配置",
    BSCSCAN_DEEP_CHECK: process.env.BSCSCAN_DEEP_CHECK,
  });
});

// ============ 保存设置（写入 .env + 运行时生效）============
app.post('/api/env/save', (req, res) => {
  try {
    const settings = req.body;
    const envPath = path.join(__dirname, '.env');

    // 读取当前 .env 文件
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* 文件不存在则新建 */ }

    // 可保存的配置项列表
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

    // 写回 .env 文件
    fs.writeFileSync(envPath, envContent);

    // 运行时应用扫描间隔变更
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

// --- 导入钱包 ---
app.post('/api/wallets', async (req, res) => {
  try {
    const { privateKey, label } = req.body;
    if (!privateKey) return res.status(400).json({ error: '需要 privateKey' });
    const result = importWallet(privateKey, label || '');
    if (result.imported && getWalletCount() === 1) {
      const pk = getActivePrivateKey();
      if (pk) await reinitEngine(pk);
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
    const pk = getActivePrivateKey();
    if (pk) await reinitEngine(pk);
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

// ============ 跟踪代币 API ============

app.post('/api/tokens/watch', (req, res) => {
  try {
    const { tokenAddress, symbol } = req.body;
    if (!tokenAddress) return res.status(400).json({ error: '需要 tokenAddress' });
    const tokens = addWatchedToken(tokenAddress, symbol || '');
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

// ============ 状态 (增强版) ============
app.get('/api/status', (req, res) => {
  res.json({
    chain: screener.getCurrentChain(),
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
  });
});

// ============ 启动服务 ============

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    OKNC 自动土狗交易系统 v2.1            ║');
  console.log('║    多钱包 · 资产监控 · 自动交易          ║');
  console.log('║    密码认证 · PWA 安装支持                ║');
  console.log('╚══════════════════════════════════════════╝');

  // 1. 初始化钱包管理器
  initWalletManager();

  // 2. 如果有已导入的钱包，自动初始化 engine
  if (hasWallets()) {
    try {
      const pk = getActivePrivateKey();
      if (pk) {
        await reinitEngine(pk);
        console.log(`[Server] ✅ 交易引擎初始化成功 (${getActiveWallet()?.slice(0, 10)}...)`);
      }
    } catch (err) {
      console.error(`[Server] ❌ 交易引擎初始化失败: ${err.message}`);
    }
  } else {
    try {
      await initEngine();
      console.log('[Server] ✅ 交易引擎初始化成功（.env 模式）');
      const envKey = process.env.PRIVATE_KEY;
      if (envKey && !envKey.includes('你的钱包私钥')) {
        importWallet(envKey, '默认钱包 (.env)');
        console.log('[Server] 💼 .env 钱包已自动导入');
      }
    } catch (err) {
      console.log('[Server] ⚠️ 无可用钱包，请在面板导入私钥');
    }
  }

  // 3. 启动 DexScreener 扫描
  console.log('[Server] 🔍 启动 DexScreener 扫描...');
  screener.startScanning();

  // 4. 策略引擎待手动启动
  console.log('[Server] 📋 策略引擎待激活（需在前端手动启动）');

  // 5. 启动 Web 服务
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 🌐 控制面板: http://localhost:${PORT}`);
    console.log(`[Server] 📡 API: http://localhost:${PORT}/api/status`);
    console.log(`[Server] 🔒 密码认证: ${AUTH_PASSWORD ? '已启用' : '未启用'}`);

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