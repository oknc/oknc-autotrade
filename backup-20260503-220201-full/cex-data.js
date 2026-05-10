/**
 * cex-data.js — 中心化交易所实时行情引擎 (v1)
 *
 * 基于 Binance Futures WebSocket API
 * 实时推送: ticker / kline / 深度
 */
import WebSocket from 'ws';


// ============ 配置 ============
const BINANCE_WS_BASE = 'wss://fstream.binance.com/ws';
const BINANCE_COMBINED_WS = 'wss://fstream.binance.com/stream';

// 默认追踪的交易对
const DEFAULT_SYMBOLS = ['ethusdt', 'btcusdt', 'bnbusdt'];

// ============ 状态 ============
let wsConnections = {};
let marketData = {};           // { 'ethusdt': { last, bid, ask, change, volume, ... } }
let klineCache = {};           // { 'ETH/USDT': { '1h': [...candles], '15m': [...], ... } }
let klineCallbacks = new Map(); // event → callbacks[]
let tickerCallbacks = new Map();
let activeSymbols = [...DEFAULT_SYMBOLS];
let isRunning = false;
let reconnectTimers = {};

// 缓存大小限制
const MAX_CANDLES = 500;
const MAX_TICKER_HISTORY = 100;

// ============ WebSocket 连接管理 ============

/**
 * 启动所有 WebSocket 订阅
 */
export function startDataStream(symbols = DEFAULT_SYMBOLS) {
  if (isRunning) return;
  activeSymbols = symbols.map(s => s.toLowerCase().replace('/', '').replace(':', ''));
  isRunning = true;

  // 1. 连接整体 ticker 流（所有交易对一起推送）
  connectCombinedTicker();

  // 2. 为每个活跃交易对连接 kline 流
  for (const sym of activeSymbols) {
    connectKlineStream(sym);
  }

  console.log(`[CEX-Data] 📡 行情引擎已启动 (${activeSymbols.join(', ')})`);
  return { activeSymbols };
}

/**
 * 停止所有 WebSocket 连接
 */
export function stopDataStream() {
  isRunning = false;
  for (const key of Object.keys(wsConnections)) {
    closeWS(key);
  }
  for (const key of Object.keys(reconnectTimers)) {
    clearTimeout(reconnectTimers[key]);
    delete reconnectTimers[key];
  }
  console.log('[CEX-Data] 📡 行情引擎已停止');
}

function closeWS(key) {
  if (wsConnections[key]) {
    try { wsConnections[key].close(); } catch {}
    delete wsConnections[key];
  }
}

function scheduleReconnect(key, delay = 5000) {
  if (reconnectTimers[key]) clearTimeout(reconnectTimers[key]);
  reconnectTimers[key] = setTimeout(() => {
    if (!isRunning) return;
    console.log(`[CEX-Data] 🔄 重连 ${key}...`);
    if (key.startsWith('ticker_')) connectCombinedTicker();
    else if (key.startsWith('kline_')) {
      const sym = key.replace('kline_', '');
      connectKlineStream(sym);
    }
  }, delay);
}

/**
 * 连接 Binance 组合 Ticker 流
 */
function connectCombinedTicker() {
  const streams = activeSymbols.map(s => `${s}@ticker`).join('/');
  const url = `${BINANCE_COMBINED_WS}?streams=${streams}`;

  closeWS('ticker_combined');

  try {
    const ws = new WebSocket(url);
    wsConnections['ticker_combined'] = ws;

    ws.on('open', () => {
      console.log('[CEX-Data] ✅ Ticker 流已连接');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.data && msg.data.e === '24hrTicker') {
          updateTicker(msg.data);
        } else if (msg.e === '24hrTicker') {
          updateTicker(msg);
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log('[CEX-Data] ⚠️ Ticker 流断开');
      delete wsConnections['ticker_combined'];
      if (isRunning) scheduleReconnect('ticker_combined');
    });

    ws.on('error', (err) => {
      console.error(`[CEX-Data] ⚠️ Ticker 流错误: ${err.message}`);
      closeWS('ticker_combined');
      if (isRunning) scheduleReconnect('ticker_combined');
    });
  } catch (err) {
    console.error(`[CEX-Data] ❌ Ticker 连接失败: ${err.message}`);
    if (isRunning) scheduleReconnect('ticker_combined');
  }
}

function updateTicker(data) {
  const sym = (data.s || '').toLowerCase();
  if (!sym) return;

  marketData[sym] = {
    symbol: data.s,
    last: parseFloat(data.c || 0),
    bid: parseFloat(data.b || 0),
    ask: parseFloat(data.a || 0),
    high: parseFloat(data.h || 0),
    low: parseFloat(data.l || 0),
    volume: parseFloat(data.v || 0),
    quoteVolume: parseFloat(data.q || 0),
    change: parseFloat(data.p || 0),
    percentage: parseFloat(data.P || 0),
    timestamp: data.E || Date.now(),
  };

  // 触发回调
  const cbs = tickerCallbacks.get(sym) || [];
  for (const cb of cbs) {
    try { cb(marketData[sym]); } catch {}
  }
  const globalCbs = tickerCallbacks.get('*') || [];
  for (const cb of globalCbs) {
    try { cb(sym, marketData[sym]); } catch {}
  }
}

/**
 * 连接指定交易对的 Kline 流
 */
function connectKlineStream(symbol) {
  const key = `kline_${symbol}`;
  closeWS(key);

  // 订阅多个时间周期
  const intervals = ['1m', '5m', '15m', '1h'];
  const streams = intervals.map(i => `${symbol}@kline_${i}`).join('/');
  const url = `${BINANCE_COMBINED_WS}?streams=${streams}`;

  try {
    const ws = new WebSocket(url);
    wsConnections[key] = ws;

    ws.on('open', () => {
      console.log(`[CEX-Data] ✅ Kline 流已连接: ${symbol}`);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const k = msg.data?.k || msg.k;
        if (!k) return;

        const klineSymbol = k.s || symbol;
        const interval = k.i;
        const candle = {
          timestamp: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          quoteVolume: parseFloat(k.q),
          isFinal: k.x, // 是否已收盘
        };

        // 更新 kline 缓存
        const cacheKey = `${klineSymbol.toUpperCase()}/${interval}`;
        if (!klineCache[cacheKey]) klineCache[cacheKey] = [];

        const arr = klineCache[cacheKey];
        const lastIdx = arr.length - 1;

        if (arr.length > 0 && arr[lastIdx].timestamp === candle.timestamp) {
          // 更新同一根 candle
          arr[lastIdx] = candle;
        } else if (arr.length > 0 && arr[lastIdx].timestamp < candle.timestamp) {
          // 新 candle
          arr.push(candle);
          if (arr.length > MAX_CANDLES) arr.shift();
        } else if (arr.length === 0) {
          arr.push(candle);
        }

        // 触发回调
        const cbs = klineCallbacks.get(cacheKey) || [];
        for (const cb of cbs) {
          try { cb(candle, arr); } catch {}
        }
      } catch {}
    });

    ws.on('close', () => {
      delete wsConnections[key];
      if (isRunning) scheduleReconnect(key);
    });

    ws.on('error', () => {
      closeWS(key);
      if (isRunning) scheduleReconnect(key);
    });
  } catch (err) {
    if (isRunning) scheduleReconnect(key);
  }
}

// ============ 数据订阅 (给策略引擎用) ============

/**
 * 订阅 ticker 更新
 * @param {string} symbol - 'ethusdt' 或 '*' 通配
 * @param {function} callback - fn(data) 或 fn(symbol, data)
 */
export function onTicker(symbol, callback) {
  const key = symbol.toLowerCase();
  if (!tickerCallbacks.has(key)) tickerCallbacks.set(key, []);
  tickerCallbacks.get(key).push(callback);
  return () => {
    const arr = tickerCallbacks.get(key);
    if (arr) {
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
}

/**
 * 订阅 Kline 更新
 * @param {string} symbol - 'ETH/USDT'
 * @param {string} interval - '1m', '5m', '15m', '1h'
 * @param {function} callback - fn(candle, fullArray)
 */
export function onKline(symbol, interval, callback) {
  const key = `${symbol}/${interval}`;
  if (!klineCallbacks.has(key)) klineCallbacks.set(key, []);
  klineCallbacks.get(key).push(callback);
  return () => {
    const arr = klineCallbacks.get(key);
    if (arr) {
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    }
  };
}

// ============ 数据查询 ============

/**
 * 获取最新 ticker 数据
 */
export function getTicker(symbol) {
  const key = (symbol || '').toLowerCase().replace('/', '').replace(':', '');
  return marketData[key] || null;
}

/**
 * 获取 Kline 缓存
 */
export function getKlines(symbol, interval = '15m', limit = 100) {
  const key = `${symbol}/${interval}`;
  const arr = klineCache[key] || [];
  return arr.slice(-limit);
}

/**
 * 获取多个时间周期的 Kline
 */
export function getMultiTimeframeKlines(symbol, intervals = ['15m', '1h'], limit = 100) {
  const result = {};
  for (const iv of intervals) {
    result[iv] = getKlines(symbol, iv, limit);
  }
  return result;
}

/**
 * 获取所有活跃数据
 */
export function getAllMarketData() {
  return { ...marketData };
}

/**
 * 添加追踪交易对
 */
export function addSymbol(symbol) {
  const sym = symbol.toLowerCase().replace('/', '').replace(':', '');
  if (!activeSymbols.includes(sym)) {
    activeSymbols.push(sym);
    if (isRunning) {
      // 需要重连 ticker 流
      connectCombinedTicker();
      connectKlineStream(sym);
    }
  }
}

/**
 * 获取引擎状态
 */
export function getDataStatus() {
  return {
    running: isRunning,
    activeSymbols,
    tickerCount: Object.keys(marketData).length,
    klineChannels: Object.keys(klineCache).length,
    connections: Object.keys(wsConnections).length,
  };
}

/**
 * 初始化时先从 REST 获取历史 K 线补全缓存
 */
export async function prefetchKlines(symbol, intervals = ['15m', '1h'], limit = 100) {
  try {
    const { default: ccxt } = await import('ccxt');
    const ex = new ccxt.binance({
      options: { defaultType: 'swap', adjustForTimeDifference: true },
      enableRateLimit: true,
    });

    for (const iv of intervals) {
      const ohlcv = await ex.fetchOHLCV(symbol, iv, undefined, limit);
      const key = `${symbol}/${iv}`;
      klineCache[key] = ohlcv.map(c => ({
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
        isFinal: true,
      }));
      console.log(`[CEX-Data] 📥 预加载 ${key}: ${klineCache[key].length} 根K线`);
    }
    return { success: true };
  } catch (err) {
    console.error(`[CEX-Data] ⚠️ K线预加载失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

console.log('[CEX-Data] 📊 行情引擎已加载');