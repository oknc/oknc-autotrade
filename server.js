/**
 * server.js — OKNC 合约自动交易系统 (纯合约版)
 *
 * 支持: Binance / Gate.io / OKX 合约交易
 * 功能: 自动策略、手动交易、风控、情报系统、K线
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import 'dotenv/config';

import * as cexEngine from './cex-engine.js';
import * as cexStrategy from "./cex-strategy.js";
import * as adaptive from './cex-adaptive.js';
import * as riskManager from "./risk-manager.js";
import { appendCexLog, getCexLogs } from './cex-logger.js';
import * as cexIntel from './cex-intel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// root -> contract panel
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "contract.html"));
});
app.get('/contract', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contract.html'));
});

// ============ 认证系统 ============
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'oknc2018';
const AUTH_PASSWORD_READONLY = process.env.AUTH_PASSWORD_READONLY || 'oknc888';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(16).toString('hex');
const AUTH_TOKEN_EXPIRY = (process.env.AUTH_TOKEN_EXPIRY || 24) * 60 * 60 * 1000;

const validTokens = new Map();

function generateToken(role = 'admin') {
  return crypto.createHash('sha256')
    .update(AUTH_PASSWORD + AUTH_SECRET + Date.now() + role)
    .digest('hex');
}

function authMiddleware(req, res, next) {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/check' || req.path === '/api/cex/intel' || req.path === '/api/cex/trade-markers') return next();
  if (!req.path.startsWith('/api/')) return next();
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

app.use((req, res, next) => {
  if (req.user && req.user.role === 'readonly') {
    const blockedPaths = [
      '/api/cex/exchanges', '/api/cex/position/open', '/api/cex/position/close', '/api/cex/leverage', '/api/cex/style',
      '/api/cex/strategy/start', '/api/cex/strategy/stop',
      '/api/cex/risk/reset', '/api/cex/log',
    ];
    if (blockedPaths.includes(req.path) || (req.path.startsWith('/api/cex/exchanges') && req.method !== 'GET')) {
      return res.status(403).json({ error: '只读账号，无权执行此操作', code: 'READONLY' });
    }
  }
  next();
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  let role = null;
  if (password && password === AUTH_PASSWORD) role = 'admin';
  else if (password && AUTH_PASSWORD_READONLY && password === AUTH_PASSWORD_READONLY) role = 'readonly';
  if (!role) return res.status(401).json({ error: '密码错误', success: false });
  const token = generateToken(role);
  validTokens.set(token, { role, createdAt: Date.now(), expiresAt: Date.now() + AUTH_TOKEN_EXPIRY });
  res.json({ success: true, token, role, expiresIn: AUTH_TOKEN_EXPIRY });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: false });
});

// ============ CEX 风控 API ============
app.get('/api/cex/risk/status', async (req, res) => {
  try { res.json(riskManager.getStatus(req.query.exchangeId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/trail-interval', (req, res) => {
  try { res.json(cexStrategy.getTrailInterval()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/trail-interval', (req, res) => {
  try {
    const { interval } = req.body;
    const result = cexStrategy.setTrailInterval(interval);
    if (result.success) appendCexLog('trail_interval', `追踪止盈间隔改为 ${result.intervalMs / 1000}s`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/risk/reset', (req, res) => {
  try {
    riskManager.resetCircuitBreaker();
    appendCexLog('risk_reset', '熔断已重置');
    res.json({ success: true, status: riskManager.getStatus() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ 策略 API ============
app.get('/api/cex/strategy/status', (req, res) => {
  try { res.json(cexStrategy.getStrategyStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/strategy/signals', (req, res) => {
  try { res.json(cexStrategy.getSignalsSummary()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/strategy/trail-state', (req, res) => {
  try { res.json(cexStrategy.getTrailingState()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 夏普比率 API
app.get('/api/cex/strategy/sharpe', (req, res) => {
  try {
    const symbol = req.query.symbol;
    if (symbol) res.json({ symbol, sharpe: adaptive.calcSharpeRatio(symbol) });
    else res.json(adaptive.getAllSharpeRatios());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/strategy/mode', (req, res) => {
  try { res.json(cexStrategy.getStrategyMode()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/strategy/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode || !['dual', 'single'].includes(mode)) {
      return res.status(400).json({ error: '模式仅支持 dual(双币) 或 single(单币)' });
    }
    if (cexStrategy.getStrategyStatus().running) cexStrategy.stopStrategy();
    const result = cexStrategy.setStrategyMode(mode);
    if (!result.success) return res.status(400).json(result);
    const modeInfo = cexStrategy.getStrategyMode();
    const symbols = modeInfo.mode === 'dual'
      ? ['BTC/USDT:USDT', 'ETH/USDT:USDT']
      : [modeInfo.primarySymbol];
    const startResult = await cexStrategy.startStrategy(symbols);
    if (startResult.success) {
      appendCexLog('strategy_mode', `策略模式切换为${mode === 'dual' ? '双币(BTC+ETH)' : '单币('+modeInfo.primarySymbol+')'}`);
    }
    res.json({ success: true, mode, symbols });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/strategy/start', async (req, res) => {
  try {
    const { symbols, exchangeMap } = req.body;
    if (exchangeMap) {
      for (const [sym, exId] of Object.entries(exchangeMap)) {
        cexStrategy.setSymbolExchange(sym, exId);
      }
    }
    const result = await cexStrategy.startStrategy(symbols || ['BTC/USDT:USDT']);
    if (result.success) appendCexLog('strategy_start', `策略启动 ${(symbols || ['BTC/USDT:USDT']).map(s => s.replace(':USDT','')).join(', ')}`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/strategy/exchange-map', (req, res) => {
  res.json({ exchangeMap: cexStrategy.getSymbolExchangeMap() });
});

app.post('/api/cex/strategy/exchange-map', (req, res) => {
  try {
    const { symbol, exchangeId } = req.body;
    if (!symbol || !exchangeId) return res.status(400).json({ error: '需要 symbol 和 exchangeId' });
    const supported = cexEngine.getSupportedExchanges();
    if (!supported.includes(exchangeId)) return res.status(400).json({ error: `不支持的交易所: ${exchangeId}，可用: ${supported.join(', ')}` });
    cexStrategy.setSymbolExchange(symbol, exchangeId);
    res.json({ success: true, symbol, exchangeId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/strategy/stop', (req, res) => {
  try {
    const { exchangeId } = req.body;
    const result = cexStrategy.stopStrategy(exchangeId);
    if (result.success) {
      if (exchangeId && !result.fullStop) {
        appendCexLog('strategy_stop', '[' + cexEngine.getExchangeLabel(exchangeId) + '] 策略停止');
      } else {
        appendCexLog('strategy_stop', '[全部] 策略停止');
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ SSE 实时行情推送 ============
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
      if (tickerEth.value?.success && tickerEth.value?.ticker) tickerData['ETH/USDT'] = tickerEth.value.ticker;
      if (tickerBtc.value?.success && tickerBtc.value?.ticker) tickerData['BTC/USDT'] = tickerBtc.value.ticker;

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

// ============ 合约交易 API ============
app.get('/api/cex/status', (req, res) => {
  try { res.json(cexEngine.getStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/exchanges', (req, res) => {
  res.json({ supported: cexEngine.getSupportedExchanges(), status: cexEngine.getStatus() });
});

app.post('/api/cex/exchanges', async (req, res) => {
  try {
    const { exchangeId, label, apiKey, secret, password, testnet } = req.body;
    if (!exchangeId || !apiKey || !secret) return res.status(400).json({ error: '缺少必填参数: exchangeId, apiKey, secret' });
    const result = cexEngine.addExchange({ exchangeId, label, apiKey, secret, password, testnet });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cex/exchanges/:exchangeId', (req, res) => {
  try { res.json(cexEngine.removeExchange(req.params.exchangeId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/exchanges/switch', (req, res) => {
  try {
    const result = cexEngine.setActiveExchange(req.body.exchangeId);
    appendCexLog('exchange_switch', `切换到 ${cexEngine.getExchangeLabel(req.body.exchangeId)}`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/cex/exchanges/config", (req, res) => {
  try {
    const supported = cexEngine.getSupportedExchanges();
    const configured = {};
    for (const ex of supported) {
      configured[ex] = cexEngine.isExchangeConfigured(ex);
    }
    res.json({ configured });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/balance', async (req, res) => {
  try {
    const result = await cexEngine.getBalance(req.query.exchangeId);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/styles', (req, res) => {
  try { res.json(cexEngine.getStyles()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/style', (req, res) => {
  try { res.json(cexEngine.getCurrentStyle()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/style', (req, res) => {
  try {
    const { style, exchangeId } = req.body;
    const r = cexEngine.setStyle(style);
    if (r.success) appendCexLog('style_change', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 切换风格: ${({conservative:'保守', moderate:'稳健', aggressive:'激进'}[style] || style)}`);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/position/calculate', (req, res) => {
  try {
    const { totalCapital } = req.body;
    const capital = parseFloat(totalCapital) || 30;
    res.json(cexEngine.calculatePosition(capital));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/leverage', async (req, res) => {
  try {
    const { symbol, leverage, exchangeId } = req.body;
    const r = await cexEngine.setLeverage(symbol, leverage, exchangeId);
    if (r.success) appendCexLog('leverage_change', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] ${symbol} 杠杆: ${leverage}x`);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/position/open', async (req, res) => {
  try {
    const { symbol, side, contracts, exchangeId, leverage, stopLoss, takeProfit, marginMode } = req.body;
    if (!symbol || !side || !contracts) return res.status(400).json({ error: '缺少必填参数: symbol, side, amount' });
    const result = await cexEngine.openPosition(symbol, side, parseFloat(contracts), exchangeId, { leverage, stopLoss, takeProfit, marginMode });
    if (result.success) {
      appendCexLog('manual_open', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 手动开${side === 'long' ? '多' : '空'} ${symbol} ${parseFloat(contracts)}张 ${leverage||'?'}x @ ${result.entryPrice ?? '?'}`);
    } else {
      appendCexLog('manual_open_fail', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 开仓失败 ${symbol}: ${result.error || ''}`);
    }
    res.json(result);
  } catch (err) {
    appendCexLog('manual_open_fail', `开仓异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cex/position/close', async (req, res) => {
  try {
    const { symbol, side, exchangeId, percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: '缺少必填参数: symbol, side' });
    const result = await cexEngine.closePosition(symbol, side, exchangeId, { percent });
    if (result.success) {
      appendCexLog('manual_close', `[${cexEngine.getExchangeLabel(exchangeId||'binance')}] 手动平${side === 'long' ? '多' : '空'} ${symbol} @ ${result.closePrice ?? '?'} PnL:${result.realizedPnl>0?'+':''}$${result.realizedPnl?.toFixed(2)||'?'} (${result.pnlPercent>0?'+':''}${result.pnlPercent?.toFixed(2)||'?'}%)`);
      riskManager.onPositionClosed(symbol, side, result.realizedPnl, result.pnlPercent, exchangeId).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    appendCexLog('manual_close_fail', `平仓失败 ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cex/ticker', async (req, res) => {
  try {
    const { symbol, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getTicker(symbol, exchangeId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/ohlcv', async (req, res) => {
  try {
    const { symbol, timeframe, limit, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getOHLCV(symbol, timeframe, parseInt(limit) || 100, exchangeId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/funding', async (req, res) => {
  try {
    const { symbol, exchangeId } = req.query;
    if (!symbol) return res.status(400).json({ error: '缺少 symbol' });
    res.json(await cexEngine.getFundingRate(symbol, exchangeId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// K线成交标记 API - 返回开平仓记录用于K线标记
app.get('/api/cex/trade-markers', (req, res) => {
  try {
    const { symbol, hours } = req.query;
    const result = getCexLogs(500, 0);
    const logs = result.logs || [];
    const cutoff = hours ? Date.now() - parseInt(hours) * 3600 * 1000 : 0;

    // 从detail字符串中解析symbol和side
    function parseDetail(detail, type) {
      if (!detail) return { symbol: null, side: null };
      const symMatch = detail.match(/(BTC\/USDT|ETH\/USDT|SOL\/USDT|BNB\/USDT|ADA\/USDT|DOGE\/USDT|XRP\/USDT)/);
      const sideMatch = detail.match(/开(多|空)/);
      const closeSideMatch = detail.match(/平(多|空)/);
      let side = null;
      if (sideMatch) side = sideMatch[1] === '多' ? 'long' : 'short';
      else if (closeSideMatch) side = closeSideMatch[1] === '多' ? 'long' : 'short';
      return { symbol: symMatch ? symMatch[1] : null, side };
    }

    const markers = [];
    for (const e of logs) {
      const t = e.time || '';
      const ts = t ? new Date(t).getTime() : 0;
      if (cutoff > 0 && ts < cutoff) continue;
      const type = e.type;
      // 是否交易事件
      if (type !== 'auto_open' && type !== 'manual_open' && type !== 'auto_close' && type !== 'strategy_close' && type !== 'manual_close') continue;
      // 解析detail
      const parsed = parseDetail(e.detail, type);
      // 按交易对过滤
      if (symbol && parsed.symbol) {
        const symQuery = symbol.replace(':USDT','').replace('/','').toUpperCase();
        const symTarget = parsed.symbol.replace('/','').toUpperCase();
        if (!symTarget.includes(symQuery)) continue;
      }
      // 如果没有解析出symbol但传了symbol过滤 -> 跳过
      if (symbol && !parsed.symbol) continue;

      // 保留精确的Unix秒，由前端做精确匹配
      const rawTime = Math.floor(ts / 1000);

      if (type === 'auto_open' || type === 'manual_open') {
        markers.push({
          time: rawTime,
           position: parsed.side === 'short' ? 'aboveBar' : 'belowBar',
           color: parsed.side === 'short' ? '#f05555' : '#00c087',
           shape: parsed.side === 'short' ? 'arrowDown' : 'arrowUp',
           text: parsed.side === 'short' ? '开空' : '开多',
           size: 1.5
         });
       } else {
         const pnl = e.realizedPnl;
         const isWin = pnl && pnl > 0;
         markers.push({
           time: rawTime,
           position: 'inBar',
          color: isWin ? '#00c087' : '#f05555',
          shape: 'circle',
          text: (isWin ? '+' : '') + (pnl ? pnl.toFixed(2) : '平') + '$',
          size: 1.2
        });
      }
    }
    res.json({ success: true, markers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 操作日志 API
app.get('/api/cex/logs', (req, res) => {
  const count = parseInt(req.query.count) || 20;
  const offset = parseInt(req.query.offset) || 0;
  res.json(getCexLogs(count, offset));
});

app.post('/api/cex/log', (req, res) => {
  try {
    const { type, detail } = req.body;
    if (!type) return res.status(400).json({ error: '缺少 type' });
    appendCexLog(type, detail, { source: 'ui' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ 情报系统 API ============
app.get('/api/cex/intel', (req, res) => {
  try { res.json(cexIntel.getIntel()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cex/intel/factors', (req, res) => {
  try { res.json(cexIntel.getAdjustmentFactors()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cex/intel', async (req, res) => {
  try {
    const { newsContent } = req.body;
    const result = await cexIntel.updateIntel(newsContent);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============ 启动 ============
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    OKNC 合约自动交易系统                  ║');
  console.log('║    多交易所 · 自动策略 · 风控              ║');
  console.log('║    Binance + Gate.io + OKX               ║');
  console.log('╚══════════════════════════════════════════╝');

  // 1. 初始化 CEX 合约引擎
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

  // 2. 初始化风控
  try {
    await riskManager.initRiskManager();
    console.log('[Server] ✅ 风控系统已初始化');
  } catch (err) {
    console.log(`[Server] ⚠️ 风控初始化跳过: ${err.message}`);
  }

  // 3. 自动启动 CEX 合约策略
  (async () => {
    try {
      console.log('[Server] 🚀 自动启动 CEX 合约策略...');
      const symbols = ['BTC/USDT:USDT'];
      const result = await cexStrategy.startStrategy(symbols);
      if (result.success) {
        appendCexLog('strategy_start', '[自动] 策略启动 BTC/USDT');
        console.log('[Server] ✅ CEX 合约策略已自动启动 (BTC/USDT)');
      }
    } catch (err) {
      console.log(`[Server] ⚠️ CEX 策略自动启动失败: ${err.message}`);
    }
  })();

  // 4. 启动 Web 服务
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 🌐 合约交易面板: http://localhost:${PORT}`);
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
