/**
 * cex-engine.js — 中心化交易所合约交易引擎 (v1)
 *
 * 基于 CCXT 统一接口，当前支持 Binance 合约 (USDT-M)
 * 可扩展: Gate.io / OKX
 */
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { appendCexLog } from './cex-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXCHANGE_FILE = path.join(__dirname, 'data', 'exchange-keys.json');

// ============ 加密（复用钱包加密模式） ============
const ENCRYPTION_KEY = crypto.createHash('sha256')
  .update('oknc-cex-engine-v1')
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
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// ============ Binance REST API 直连（绕过CCXT缺陷） ============

/** 获取第一个激活的币安交易所的明文密钥（已由loadExchangeConfigs解密） */
function getBinanceCredentials() {
  const cfg = exchangeConfigs.find(c => c.exchangeId === 'binance' && c.isActive);
  if (!cfg) throw new Error('币安交易所未配置');
  if (!cfg.apiKey || !cfg.secret) throw new Error('币安密钥无效');
  return {
    apiKey: cfg.apiKey,
    secret: cfg.secret,
  };
}

/** 将 CCXT 符号名转为 Binance REST 符号名 (ETH/USDT:USDT -> ETHUSDT) */
function toBinanceSymbol(symbol) {
  if (!symbol) return symbol;
  return symbol.replace(/\/USDT.*$/, 'USDT').replace(/\//, '');
}

/** 发起币安合约签名请求 */
async function binanceRequest(method, endpoint, params = {}) {
  const { apiKey, secret } = getBinanceCredentials();
  params.timestamp = Date.now();
  params.recvWindow = 50000;
  const query = Object.keys(params).map(k => k + '=' + params[k]).join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  const url = 'https://fapi.binance.com' + endpoint + '?' + query + '&signature=' + signature;
  const resp = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey }
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * 通过 REST API 创建币安订单（支持STOP/TAKE_PROFIT等CCXT有缺陷的类型）
 */
async function restCreateOrder(symbol, type, side, quantity, price, stopPrice, options = {}) {
  const params = {
    symbol: toBinanceSymbol(symbol),
    side,
    type,
    quantity: String(quantityToPrecision(symbol, quantity)),
  };
  if (options.positionSide) params.positionSide = options.positionSide;
  if (options.reduceOnly) params.reduceOnly = 'true';
  if (options.workingType) params.workingType = options.workingType;
  if (price !== null && price !== undefined && price > 0) params.price = String(priceToPrecision(price));
  if (stopPrice !== null && stopPrice !== undefined && stopPrice > 0) params.stopPrice = String(priceToPrecision(stopPrice));
  if (type === 'LIMIT' || type === 'STOP' || type === 'TAKE_PROFIT') {
    params.timeInForce = 'GTC';
  }

  const result = await binanceRequest('POST', '/fapi/v1/order', params);
  if (result.code) {
    return { success: false, error: '[' + result.code + '] ' + (result.msg || '') };
  }
  return {
    success: true,
    orderId: result.orderId,
    symbol: result.symbol,
    type: result.type,
    side: result.side,
    stopPrice: result.stopPrice,
    price: result.price,
    origQty: result.origQty,
    status: result.status,
  };
}

/** 通过 REST API 取消单笔订单 */
async function restCancelOrder(symbol, orderId) {
  const result = await binanceRequest('DELETE', '/fapi/v1/order', {
    symbol: toBinanceSymbol(symbol),
    orderId: String(orderId),
  });
  if (result.code) {
    return { success: false, error: '[' + result.code + '] ' + (result.msg || '') };
  }
  return { success: true, orderId: result.orderId, status: result.status };
}

/** 通过 REST API 取消指定交易对的所有订单 */
async function restCancelAllOrders(symbol) {
  const result = await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', {
    symbol: toBinanceSymbol(symbol),
  });
  if (result.code && result.code != 200) {
    if (result.code === -2011) return { success: true, msg: '无订单可取消' };
    return { success: false, error: '[' + result.code + '] ' + (result.msg || '') };
  }
  return { success: true, msg: '已取消全部订单' };
}

/** 通过 REST API 获取未成交订单（含Algo条件单） */
async function restGetOpenOrders(symbol) {
  const sym = symbol ? toBinanceSymbol(symbol) : undefined;
  const params = {};
  if (sym) params.symbol = sym;

  // 同时查普通订单和Algo条件单
  const [regular, algo] = await Promise.allSettled([
    binanceRequest('GET', '/fapi/v1/openOrders', {...params}),
    binanceRequest('GET', '/fapi/v1/openAlgoOrders', {...params}),
  ]);

  const regularOrders = regular.status === 'fulfilled' && Array.isArray(regular.value)
    ? regular.value.map(o => ({
        orderId: o.orderId, symbol: o.symbol, side: o.side, type: o.type,
        price: o.price, stopPrice: o.stopPrice, origQty: o.origQty,
        positionSide: o.positionSide, reduceOnly: o.reduceOnly === 'true' || o.reduceOnly === true,
        status: o.status, time: o.time, algoType: null,
      }))
    : [];

  let algoOrders = [];
  if (algo.status === 'fulfilled' && Array.isArray(algo.value)) {
    algoOrders = algo.value.map(o => ({
      orderId: o.algoId, symbol: o.symbol, side: o.side,
      type: o.orderType, price: o.price, stopPrice: o.triggerPrice,
      origQty: o.quantity, positionSide: o.positionSide,
      reduceOnly: true, status: o.algoStatus,
      time: o.createTime || Date.now(), algoType: o.algoType || 'CONDITIONAL',
    }));
  }

  return {
    success: true,
    orders: [...regularOrders, ...algoOrders],
    regular: regularOrders.length,
    algo: algoOrders.length,
  };
}

/** 创建Algo条件单（止盈止损专用，绕过CCXT缺陷） */
async function restCreateAlgoOrder(symbol, side, type, quantity, triggerPrice, options = {}) {
  const params = {
    symbol: toBinanceSymbol(symbol),
    side: side.toUpperCase(),
    type,  // 'STOP' or 'TAKE_PROFIT'
    quantity: String(quantityToPrecision(symbol, quantity)),
    triggerPrice: String(priceToPrecision(triggerPrice)),
    workingType: options.workingType || 'MARK_PRICE',
    algoType: 'CONDITIONAL',
  };
  if (options.positionSide) params.positionSide = options.positionSide;
  if (options.reduceOnly) params.reduceOnly = 'true';
  if (options.price !== undefined && options.price > 0) params.price = String(priceToPrecision(options.price));

  // 重试机制：失败后重试2次，每次间隔300ms
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.log(`[Algo] 🔄 重试 ${symbol} ${type} @${triggerPrice} (第${attempt+1}次)`);
      await new Promise(r => setTimeout(r, 300));
    }
    const result = await binanceRequest('POST', '/fapi/v1/algoOrder', params);
    if (!result.code) {
      return { success: true, algoId: result.algoId, clientAlgoId: result.clientAlgoId };
    }
    lastError = '[' + result.code + '] ' + (result.msg || '');
  }
  return { success: false, error: lastError };
}

/** 取消Algo条件单 */
async function restCancelAlgoOrder(symbol, algoId) {
  const result = await binanceRequest('DELETE', '/fapi/v1/algoOrder', {
    symbol: toBinanceSymbol(symbol),
    algoId: String(algoId),
  });
  if (result.code && result.code != 200) {
    return { success: false, error: '[' + result.code + '] ' + (result.msg || '') };
  }
  return { success: true };
}

// ============ 统一条件单创建（支持多交易所） ============

/**
 * 跨交易所创建条件单（止盈/止损）
 * 支持 Binance(rest)、OKX(CCXT)、Gate(CCXT)
 * @param {string} exchangeId - 交易所标识 binance/okx/gate
 * @param {string} symbol - 交易对
 * @param {string} side - buy/sell（平仓方向）
 * @param {string} type - STOP / TAKE_PROFIT
 * @param {number} quantity - 张数
 * @param {number} triggerPrice - 触发价格
 * @param {object} options - 附加参数 { price, reduceOnly, workingType, positionSide }
 */
async function createConditionalOrder(exchangeId, symbol, side, type, quantity, triggerPrice, options = {}) {
  if (exchangeId === 'binance') {
    // 币安使用 REST Algo API，需传递 positionSide（Hedge Mode 必需）
    // 注意：Hedge Mode 下不要传 reduceOnly，Binance 会拒绝 [-1106]
    return restCreateAlgoOrder(symbol, side, type, quantity, triggerPrice, {
      price: options.price,
      workingType: options.workingType || 'MARK_PRICE',
      positionSide: options.positionSide,
    });
  }
  if (exchangeId === 'gate') {
    return gateCreateAlgoOrder(symbol, side, type, quantity, triggerPrice, {
      price: options.price,
      reduceOnly: options.reduceOnly !== false,
      workingType: options.workingType || 'MARK_PRICE',
    });
  }
  if (exchangeId === 'okx') {
    try {
      const ex = getExchange(exchangeId);
      const orderType = 'market';
      const isStop = type === 'STOP';
      let order;
      if (isStop) {
        order = await ex.createStopLossOrder(symbol, orderType, side, quantity, null, triggerPrice, {
          reduceOnly: options.reduceOnly !== false,
          hedged: true,
        });
      } else {
        order = await ex.createTakeProfitOrder(symbol, orderType, side, quantity, null, triggerPrice, {
          reduceOnly: options.reduceOnly !== false,
          hedged: true,
        });
      }
      return { success: true, orderId: String(order.id), stopPrice: triggerPrice, type };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: `不支持的交易所: ${exchangeId}` };
}

// ============ Gate REST API（通过 CCXT 统一接口） ============

/** 将 CCXT 符号名转为 Gate API 符号 (ETH/USDT:USDT -> 通过 CCXT market id 转) */
function toGateSymbol(symbol) {
  if (!symbol) return symbol;
  try {
    const ex = getExchange('gate');
    if (ex && ex.markets && ex.markets[symbol]) {
      return ex.markets[symbol].id;
    }
  } catch {}
  return symbol.replace(/\/USDT.*$/, '_USDT').replace('/', '_');
}

/** 通过 CCXT 获取 Gate 条件单并归一化为通用格式 */
async function gateGetOpenOrders(symbol) {
  try {
    const ex = getExchange('gate');
    const rawOrders = await ex.fetchOpenOrders(symbol);
    const orders = (rawOrders || []).map(o => ({
      orderId: String(o.id),
      id: String(o.id),
      symbol: o.symbol,
      side: (o.side || '').toLowerCase(),
      type: normalizeGateOrderType(o.type),
      algoType: isGateTriggerOrder(o) ? 'CONDITIONAL' : undefined,
      stopPrice: o.stopPrice || o.price,
      price: o.price,
      origQty: o.amount,
      quantity: o.amount,
      reduceOnly: o.reduceOnly || false,
      status: o.status,
      timestamp: o.timestamp,
    }));
    return { success: true, orders };
  } catch (err) {
    return { success: false, error: err.message, orders: [] };
  }
}

function isGateTriggerOrder(order) {
  if (!order) return false;
  const t = (order.type || '').toLowerCase();
  return ['stop', 'stop-loss', 'take-profit', 'trigger'].includes(t)
    || order.stopPrice !== undefined
    || order.reduceOnly;
}

function normalizeGateOrderType(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('stop')) return 'STOP';
  if (t.includes('take_profit') || t.includes('take-profit') || t === 'take_profit') return 'TAKE_PROFIT';
  if (t === 'limit') return 'LIMIT';
  if (t === 'market') return 'MARKET';
  return t.toUpperCase();
}

/** 通过 CCXT 在 Gate 创建条件单（止损/止盈） */
async function gateCreateAlgoOrder(symbol, side, type, quantity, triggerPrice, options = {}) {
  try {
    const ex = getExchange('gate');
    const isStop = type === 'STOP' || options.type === 'stop';
    const orderType = options.orderType || 'market';
    let order;
    if (isStop) {
      order = await ex.createStopLossOrder(
        symbol, orderType, side, quantity,
        options.price || null,
        triggerPrice,
        { reduceOnly: options.reduceOnly !== false }
      );
    } else {
      order = await ex.createTakeProfitOrder(
        symbol, orderType, side, quantity,
        options.price || null,
        triggerPrice,
        { reduceOnly: options.reduceOnly !== false }
      );
    }
    return {
      success: true,
      orderId: String(order.id),
      stopPrice: order.stopPrice || triggerPrice,
      type,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 通过 CCXT 取消 Gate 条件单 */
async function gateCancelAlgoOrder(symbol, algoId) {
  try {
    const ex = getExchange('gate');
    await ex.cancelOrder(algoId, symbol);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** 通过 CCXT 取消 Gate 所有订单 */
async function gateCancelAllOrders(symbol) {
  try {
    const ex = getExchange('gate');
    await ex.cancelAllOrders(symbol);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============ 状态 ============
let exchanges = {};
let activeExchange = null;
let exchangeConfigs = [];

// ============ 合约配置（三套预设风格）============
export const STYLE_PRESETS = {
  conservative: {
    label: '保守 🟢',
    leverage: 2,
    positionPercent: 5,
    stopLossPercent: 6,
    takeProfitPercent: 3,
    trailActivatePercent: 2,
    trailStepPercent: 1.5,
    maxPositions: 1,
    maxDailyLossPercent: 15,
    minSignalConfirm: 2,
  },
  moderate: {
    label: '稳健 🟡',
    leverage: 5,
    positionPercent: 15,
    stopLossPercent: 7,
    takeProfitPercent: 5,
    trailActivatePercent: 3,
    trailStepPercent: 2,
    maxPositions: 2,
    maxDailyLossPercent: 20,
    minSignalConfirm: 1,
  },
  aggressive: {
    label: '激进 🔴',
    leverage: 5,
    positionPercent: 10,
    stopLossPercent: 3.5,
    takeProfitPercent: 8,
    trailActivatePercent: 3,
    trailStepPercent: 2.5,
    maxPositions: 2,
    maxDailyLossPercent: 15,
    minSignalConfirm: 1,
  },
};

let currentStyle = 'aggressive';

// ============ 持久化 ============
function ensureDataDir() {
  const dir = path.dirname(EXCHANGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadExchangeConfigs() {
  ensureDataDir();
  if (fs.existsSync(EXCHANGE_FILE)) {
    try {
      exchangeConfigs = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf-8'));
      for (const cfg of exchangeConfigs) {
        cfg.apiKey = decrypt(cfg.apiKey) || cfg.apiKey;
        cfg.secret = decrypt(cfg.secret) || cfg.secret;
        if (cfg.password) cfg.password = decrypt(cfg.password) || cfg.password;
      }
    } catch {
      exchangeConfigs = [];
    }
  }
}

function saveExchangeConfigs() {
  ensureDataDir();
  const toSave = exchangeConfigs.map(cfg => ({
    ...cfg,
    apiKey: encrypt(cfg.apiKey),
    secret: encrypt(cfg.secret),
    password: cfg.password ? encrypt(cfg.password) : undefined,
  }));
  fs.writeFileSync(EXCHANGE_FILE, JSON.stringify(toSave, null, 2));
}

// ============ 交易所工厂 ============
const EXCHANGE_CLASSES = {
  binance: ccxt.binance,
  gate: ccxt.gate,
  okx: ccxt.okx,
};

function createExchangeInstance(config) {
  const exchangeClass = EXCHANGE_CLASSES[config.exchangeId];
  if (!exchangeClass) throw new Error(`不支持的交易所: ${config.exchangeId}`);

  const ex = new exchangeClass({
    apiKey: config.apiKey,
    secret: config.secret,
    password: config.password,
    options: {
      defaultType: 'swap',
      adjustForTimeDifference: true,
    },
    enableRateLimit: true,
  });

  if (config.testnet) {
    ex.setSandboxMode(true);
  }

  return ex;
}

// ============ 核心 API ============

export function addExchange(config) {
  const idx = exchangeConfigs.findIndex(c => c.exchangeId === config.exchangeId);
  const newConfig = {
    exchangeId: config.exchangeId,
    label: config.label || config.exchangeId,
    apiKey: config.apiKey,
    secret: config.secret,
    password: config.password || '',
    testnet: config.testnet || false,
    isActive: true,
    addedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    exchangeConfigs[idx] = { ...exchangeConfigs[idx], ...newConfig };
  } else {
    exchangeConfigs.push(newConfig);
  }

  saveExchangeConfigs();
  initExchange(config.exchangeId);
  return { success: true, exchangeId: config.exchangeId };
}

export function removeExchange(exchangeId) {
  exchangeConfigs = exchangeConfigs.filter(c => c.exchangeId !== exchangeId);
  delete exchanges[exchangeId];
  if (activeExchange === exchangeId) activeExchange = null;
  saveExchangeConfigs();
  return { success: true };
}

export function initExchange(exchangeId) {
  const config = exchangeConfigs.find(c => c.exchangeId === exchangeId);
  if (!config) throw new Error(`交易所未配置: ${exchangeId}`);
  try {
    const ex = createExchangeInstance(config);
    exchanges[exchangeId] = { exchange: ex, config };
    if (!activeExchange) activeExchange = exchangeId;
    return exchanges[exchangeId];
  } catch (err) {
    throw new Error(`初始化 ${exchangeId} 失败: ${err.message}`);
  }
}

export function initAllExchanges() {
  loadExchangeConfigs();
  for (const cfg of exchangeConfigs) {
    try {
      initExchange(cfg.exchangeId);
    } catch (err) {
      console.error(`[CEX] ⚠️ 初始化 ${cfg.exchangeId} 失败: ${err.message}`);
    }
  }
  return Object.keys(exchanges);
}

function getExchange(exchangeId) {
  const id = exchangeId || activeExchange || 'gate';
  const entry = exchanges[id];
  if (entry) return entry.exchange;
  // 未初始化时创建临时只读连接（公共数据查询，不覆盖已认证实例）
  if (EXCHANGE_CLASSES[id]) {
    // 仅在无 API Key 时创建只读实例
    const config = exchangeConfigs.find(c => c.exchangeId === id);
    if (!config || !config.apiKey) {
      const ex = new EXCHANGE_CLASSES[id]({
        options: { defaultType: 'swap', adjustForTimeDifference: true },
        enableRateLimit: true,
      });
      exchanges[id] = { exchange: ex, config: { exchangeId: id, testnet: false, isActive: false, label: id } };
      if (!activeExchange) activeExchange = id;
      return ex;
    }
    // 有配置但未初始化，重新初始化
    return initExchange(id).exchange;
  }
  throw new Error(`不支持的交易所: ${id}`);
}

export function setActiveExchange(exchangeId) {
  if (!exchanges[exchangeId]) initExchange(exchangeId);
  activeExchange = exchangeId;
  return { success: true, exchangeId };
}

// ============ 合约交易操作 ============

export async function getBalance(exchangeId) {
  try {
    const ex = getExchange(exchangeId);
    const balance = await ex.fetchBalance();
    return {
      success: true,
      total: balance.total?.USDT || 0,
      free: balance.free?.USDT || 0,
      used: balance.used?.USDT || 0,
    };
  } catch (err) {
    return { success: false, error: err.message, total: 0, free: 0, used: 0 };
  }
}

export async function getPositions(exchangeId, symbol) {
  try {
    const ex = getExchange(exchangeId);
    await ex.loadMarkets();
    let positions = await ex.fetchPositions();
    if (symbol) {
      const normSymbol = normalizeSymbol(symbol);
      positions = positions.filter(p => p && (p.symbol === symbol || p.symbol === normSymbol));
    }
    return {
      success: true,
      positions: (positions || [])
        .filter(p => p && p.contracts && Math.abs(p.contracts) > 0)
        .map(p => ({
          symbol: p.symbol,
          side: p.side,
          contracts: p.contracts,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          liquidationPrice: p.liquidationPrice,
          leverage: p.leverage || (p.notional && p.initialMargin ? Math.round(p.notional / p.initialMargin) : undefined),
          notional: p.notional,
          unrealizedPnl: p.unrealizedPnl,
          percentage: p.percentage,
          initialMargin: p.initialMargin,
          collateral: p.collateral,
        })),
    };
  } catch (err) {
    return { success: false, error: err.message, positions: [] };
  }
}

export function getCurrentStyle() {
  return { style: currentStyle, config: STYLE_PRESETS[currentStyle] };
}

export function setStyle(style) {
  if (!STYLE_PRESETS[style]) {
    return { success: false, error: `不支持的风格: ${style}，可用: ${Object.keys(STYLE_PRESETS).join(', ')}` };
  }
  currentStyle = style;
  return { success: true, style, config: STYLE_PRESETS[style] };
}

export function getStyles() {
  return STYLE_PRESETS;
}

/** 检查交易所是否已配置 API Key */
export function isExchangeConfigured(exchangeId) {
  return exchangeConfigs.some(c => c.exchangeId === exchangeId && c.apiKey);
}

export function calculatePosition(totalCapital) {
  const style = STYLE_PRESETS[currentStyle];
  const positionValue = totalCapital * (style.positionPercent / 100);
  const leveragedValue = positionValue * style.leverage;
  return {
    positionSize: positionValue,
    leveragedValue,
    leverage: style.leverage,
    stopLoss: style.stopLossPercent,
    takeProfit: style.takeProfitPercent,
    positionPercent: style.positionPercent,
  };
}

// 标准化 Binance 合约交易对符号（统一为 :USDT 格式）
function normalizeSymbol(symbol) {
  if (!symbol || symbol.includes(':USDT') || symbol.includes(':USD')) return symbol;
  // ETH/USDT → ETH/USDT:USDT
  if (symbol.endsWith('/USDT')) return symbol + ':USDT';
  if (symbol.endsWith('/BUSD')) return symbol.replace('/BUSD', '/USDT') + ':USDT';
  return symbol;
}

/** OKX合约：传递 hedged=true 让 CCXT 自动设置 posSide */
function okxParams(exchangeId, side, isClose) {
  if (exchangeId !== 'okx') return {};
  // 双向持仓模式，CCXT会根据买卖方向自动设置 posSide: long/short
  return { hedged: true };
}

/** 获取订单附加参数（交易所差异处理） */
function binanceOrderParams(side) {
  // Binance 双向持仓模式需要 positionSide
  const posSide = (side === 'long' || side === 'buy') ? 'LONG' : (side === 'short' || side === 'sell') ? 'SHORT' : null;
  if (!posSide) return {};
  return { positionSide: posSide };
}


// 根据价格自动确定合适的小数位数（适配不同tick size）
function priceToPrecision(price) {
  if (!price || price <= 0) return price;
  // BTC: 0.1 tick -> 1 decimal, ETH: 0.01 tick -> 2 decimals
  if (price > 10000) return parseFloat(price.toFixed(1));  // BTC range
  if (price > 1000) return parseFloat(price.toFixed(2));   // ETH range
  if (price > 100) return parseFloat(price.toFixed(3));    // BNB range
  if (price > 1) return parseFloat(price.toFixed(4));      // altcoins
  return parseFloat(price.toFixed(6));                      // small coins
}

/**
 * 根据交易对截断数量精度（避免Binance [-1111] Precision错误）
 * BTC/USDT:USDT / ETH/USDT:USDT -> 0.001 (3位小数)
 */
function quantityToPrecision(symbol, quantity) {
  if (!quantity || quantity <= 0) return quantity;
  return parseFloat(parseFloat(quantity).toFixed(3));
}


export async function setLeverage(symbol, leverage, exchangeId) {
  symbol = normalizeSymbol(symbol);
  try {
    const ex = getExchange(exchangeId);
    await ex.setLeverage(leverage, symbol);
    return { success: true, symbol, leverage };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function setMarginMode(symbol, mode, exchangeId) {
  try {
    const ex = getExchange(exchangeId);
    await ex.setMarginMode(mode, symbol);
    return { success: true, symbol, marginMode: mode };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function openPosition(symbol, side, contracts, exchangeId, options = {}) {
  symbol = normalizeSymbol(symbol);
  try {
    const ex = getExchange(exchangeId);
    const style = STYLE_PRESETS[currentStyle];
    const lev = options.leverage || style.leverage;

    await ex.setLeverage(lev, symbol);
    if (options.marginMode) {
      try { await ex.setMarginMode(options.marginMode, symbol); } catch {}
    }

    const ticker = await ex.fetchTicker(symbol);
    const markPrice = ticker.last || ticker.markPrice;
    const orderSide = side === 'long' ? 'buy' : 'sell';
    // 根据交易所精度调整数量
    try {
      const market = ex.market(symbol);
      const amountPrecision = market.precision?.amount;
      if (amountPrecision && amountPrecision > 0) {
        contracts = Math.round(contracts / amountPrecision) * amountPrecision;
        const minAmount = market.limits?.amount?.min || 0;
        if (contracts < minAmount && contracts > 0) contracts = minAmount;
        // Gate等交易所至少需要1张
        if (contracts < 1 && amountPrecision >= 1) contracts = 1;
      }
    } catch(e) { console.log('[openPosition] 精度调整失败:', e.message); }

    const order = await ex.createMarketOrder(symbol, orderSide, contracts, undefined, { ...okxParams(exchangeId, side), ...binanceOrderParams(side) });
    const filledPrice = order.price || markPrice;

    // 先清理该币对已有的旧订单（普通单+Algo条件单）
    try { await cancelAllOrders(symbol, exchangeId); } catch {}
    let _cleanedCount = 0;
    try {
      const openResult = await restGetOpenOrders(symbol);
      if (openResult.success) {
        for (const o of openResult.orders) {
          if (o.algoType === 'CONDITIONAL') {
            await restCancelAlgoOrder(symbol, o.orderId).catch(() => {});
            _cleanedCount++;
          }
        }
        if (_cleanedCount > 0) {
          appendCexLog('algo_cleanup', `[${getExchangeLabel(exchangeId)}] 开仓前清理 ${symbol} ${_cleanedCount}个旧条件单`, { count: _cleanedCount });
        }
      }
    } catch (e) {
      console.log('[openPosition] 清理旧订单失败:', e.message);
    }

    // 自动挂止盈止损（使用REST Algo API）
    const slPercent = style.stopLossPercent / 100;
    const tpPercent = style.takeProfitPercent / 100;
    const slPrice = orderSide === 'buy'
      ? priceToPrecision(filledPrice * (1 - slPercent))
      : priceToPrecision(filledPrice * (1 + slPercent));
    const tpPrice = orderSide === 'buy'
      ? priceToPrecision(filledPrice * (1 + tpPercent))
      : priceToPrecision(filledPrice * (1 - tpPercent));
    const reduceSide = orderSide === 'buy' ? 'sell' : 'buy';

    if (options.stopLoss !== false) {
      try {
        const posSide = side === 'long' ? 'LONG' : 'SHORT';
        const result = await createConditionalOrder(exchangeId, symbol, reduceSide, 'STOP', contracts, slPrice, {
          price: slPrice, reduceOnly: true, workingType: 'MARK_PRICE', positionSide: posSide,
        });
        if (result.success) {
          appendCexLog('algo_create', `[${getExchangeLabel(exchangeId)}] 创建止损 ${symbol} $${slPrice} ${contracts}张`, { type: 'STOP', price: slPrice, contracts });
        } else {
          console.log('[openPosition] 止损创建失败:', result.error);
        }
      } catch (e) {
        console.log('[openPosition] 止损创建失败:', e.message);
      }
    }
    if (options.takeProfit !== false) {
      try {
        const posSide = side === 'long' ? 'LONG' : 'SHORT';
        const result = await createConditionalOrder(exchangeId, symbol, reduceSide, 'TAKE_PROFIT', contracts, tpPrice, {
          price: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE', positionSide: posSide,
        });
        if (result.success) {
          appendCexLog('algo_create', `[${getExchangeLabel(exchangeId)}] 创建止盈 ${symbol} $${tpPrice} ${contracts}张`, { type: 'TAKE_PROFIT', price: tpPrice, contracts });
        } else {
          console.log('[openPosition] 止盈创建失败:', result.error);
        }
      } catch (e) {
        console.log('[openPosition] 止盈创建失败:', e.message);
      }
    }

    return {
      success: true, symbol, side, contracts, entryPrice: filledPrice,
      stopLossPrice: slPrice, takeProfitPrice: tpPrice,
      orderId: order.id, style: currentStyle, timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function closePosition(symbol, side, exchangeId, options = {}) {
  symbol = normalizeSymbol(symbol);
  try {
    const ex = getExchange(exchangeId);
    const positions = await ex.fetchPositions([symbol]);
    const pos = positions.find(p => p.symbol === symbol && p.side === side);
    if (!pos || !pos.contracts || Math.abs(pos.contracts) === 0) {
      return { success: false, error: '无此持仓' };
    }

    // 记录开仓信息用于计算盈亏
    const entryPrice = pos.entryPrice;
    const posSide = pos.side;
    const contractSize = ex.market(symbol)?.contractSize || 1;

    const contracts = options.percent
      ? Math.abs(pos.contracts) * (options.percent / 100)
      : Math.abs(pos.contracts);

    // 平仓前先清理该币对的旧止盈止损单（含Algo条件单）
    try { await cancelAllOrders(symbol, exchangeId); } catch {}
    try {
      const openOrders = await restGetOpenOrders(symbol, exchangeId);
      if (openOrders.success) {
        for (const o of openOrders.orders) {
          if (o.algoType === 'CONDITIONAL') {
            await restCancelAlgoOrder(symbol, o.orderId, exchangeId).catch(() => {});
          }
        }
      }
    } catch {}

    const orderSide = side === 'long' ? 'sell' : 'buy';
    const extraParams = { ...okxParams(exchangeId, side), ...binanceOrderParams(side) };
    if (exchangeId !== 'binance') extraParams.reduceOnly = true;
    const order = await ex.createMarketOrder(symbol, orderSide, contracts, undefined, extraParams);

    // 计算实际盈亏（有ticker兜底，应付OKX不返回成交价的case）
    const _closeTicker = order.average || order.price ? null : await ex.fetchTicker(symbol).catch(() => null);
    const closePrice = (order.average || order.price || _closeTicker?.last || 0);
    let realizedPnl = 0, pnlPercent = 0;
    if (closePrice > 0 && entryPrice > 0) {
      if (side === 'long') {
        realizedPnl = (closePrice - entryPrice) * contracts * contractSize;
        pnlPercent = ((closePrice / entryPrice) - 1) * 100;
      } else {
        realizedPnl = (entryPrice - closePrice) * contracts * contractSize;
        pnlPercent = (1 - (closePrice / entryPrice)) * 100;
      }
    }

    return {
      success: true, symbol, side,
      closedContracts: contracts,
      remaining: Math.abs(pos.contracts) - contracts,
      entryPrice,
      closePrice: +closePrice.toFixed(2),
      realizedPnl: +realizedPnl.toFixed(4),
      pnlPercent: +pnlPercent.toFixed(2),
      orderId: order.id, timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getOHLCV(symbol, timeframe = '1h', limit = 100, exchangeId) {
  try {
    const ex = getExchange(exchangeId);
    const ohlcv = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    return {
      success: true, symbol, timeframe,
      data: ohlcv.map(c => ({
        timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      })),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getTicker(symbol, exchangeId) {
  try {
    const ex = getExchange(exchangeId);
    const t = await ex.fetchTicker(symbol);
    return {
      success: true, symbol: t.symbol, last: t.last,
      bid: t.bid, ask: t.ask, high: t.high, low: t.low,
      baseVolume: t.baseVolume, quoteVolume: t.quoteVolume,
      percentage: t.percentage, markPrice: t.markPrice || t.last,
      timestamp: t.timestamp,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function getFundingRate(symbol, exchangeId) {
  try {
    const ex = getExchange(exchangeId);
    const f = await ex.fetchFundingRate(symbol);
    return {
      success: true, symbol: f.symbol, fundingRate: f.fundingRate,
      fundingTimestamp: f.fundingTimestamp, markPrice: f.markPrice,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function getStatus() {
  return {
    activeExchange,
    configuredExchanges: exchangeConfigs.map(c => ({
      exchangeId: c.exchangeId, label: c.label,
      testnet: c.testnet, initialized: !!exchanges[c.exchangeId],
    })),
    currentStyle: getCurrentStyle(),
    availableStyles: Object.keys(STYLE_PRESETS).map(k => ({ id: k, ...STYLE_PRESETS[k] })),
  };
}

export function getSupportedExchanges() {
  return Object.keys(EXCHANGE_CLASSES);
}

/** 交易所ID转中文标签 */
export function getExchangeLabel(exchangeId) {
  const labels = { binance: '币安', gate: 'Gate', okx: 'OKX' };
  return labels[exchangeId] || exchangeId;
}

// ============ 订单管理（止盈止损操作用） ============

/**
 * 获取所有未成交订单
 */
export async function getOpenOrders(symbol, exchangeId) {
  try {
    // 优先使用 REST API（修复CCXT读取止盈止损单失败的问题）
    return await restGetOpenOrders(symbol, exchangeId);
  } catch (err) {
    return { success: false, error: err.message, orders: [] };
  }
}

/**
 * 取消指定交易对的所有订单
 */
export async function cancelAllOrders(symbol, exchangeId) {
  try {
    // 使用 REST API 确保能取消止盈止损单
    return await restCancelAllOrders(symbol, exchangeId);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 创建止损/止盈市价单（reduceOnly）
 * @param {string} symbol - 交易对
 * @param {string} side - 'buy'|'sell'
 * @param {number} contracts - 数量
 * @param {number} stopPrice - 触发价格
 * @param {string} exchangeId - 交易所ID
 * @param {object} options - { type: 'stop'|'take_profit', reduceOnly: true }
 */
export async function createStopOrder(symbol, side, contracts, stopPrice, exchangeId, options = {}) {
  try {
    const ex = getExchange(exchangeId);
    const orderType = options.type === 'take_profit' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
    const order = await ex.createOrder(symbol, orderType, side, contracts, null, {
      ...okxParams(exchangeId, side), ...binanceOrderParams(side),
      stopPrice,
      reduceOnly: options.reduceOnly !== false,
      workingType: 'MARK_PRICE',
    });
    return { success: true, orderId: order.id, stopPrice, type: orderType };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 通过 CCXT 创建止损/止盈限价单（可被API读取/取消，与openPosition创建方式一致）
 */
export async function createStopLimitOrder(symbol, side, contracts, price, stopPrice, exchangeId, options = {}) {
  try {
    const ex = getExchange(exchangeId);
    const orderType = options.type === 'take_profit' ? 'take_profit' : 'stop';
    const order = await ex.createOrder(symbol, orderType, side, contracts, price, {
      ...okxParams(exchangeId, side), ...binanceOrderParams(side),
      stopPrice,
      reduceOnly: options.reduceOnly !== false,
    });
    return { success: true, orderId: order.id, stopPrice, type: orderType };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 更新持仓的止盈止损（先取消旧订单，再创建新订单）
 * @param {string} symbol - 交易对
 * @param {string} side - 'long'|'short'
 * @param {number} stopLossPrice - 止损价（null=不设置）
 * @param {number} takeProfitPrice - 止盈价（null=不设置）
 * @param {number} contracts - 合约数量
 * @param {string} exchangeId - 交易所ID
 */
export async function updateStopOrders(symbol, side, stopLossPrice, takeProfitPrice, contracts, exchangeId) {
  try {
    // 1. 获取当前未成交订单
    const openOrders = await getOpenOrders(symbol, exchangeId);
    if (!openOrders.success) {
      return { success: false, error: openOrders.error };
    }

    // 2. 过滤出我们的 reduceOnly 订单（止损/止盈）
    const ourOrders = openOrders.orders.filter(o => o.reduceOnly);
    const orderSide = side === 'long' ? 'sell' : 'buy';

    // 3. 判断是否需要更新
    let needSLUpdate = false;
    let needTPUpdate = false;

    for (const o of ourOrders) {
      if (o.side === orderSide) {
        if (o.type?.includes('STOP') || o.type?.includes('Stop')) {
          needSLUpdate = true; // 已有止损，后续会判断是否要更新
        }
        if (o.type?.includes('TAKE_PROFIT') || o.type?.includes('Take')) {
          needTPUpdate = true;
        }
      }
    }

    // 4. 取消所有旧订单（替换策略）
    await cancelAllOrders(symbol, exchangeId);

    const results = [];

    // 5. 创建新止损单
    if (stopLossPrice !== null && stopLossPrice > 0) {
      const slResult = await createStopOrder(symbol, orderSide, contracts, stopLossPrice, exchangeId, {
        type: 'stop', reduceOnly: true,
      });
      results.push({ type: 'stop_loss', ...slResult });
    }

    // 6. 创建新止盈单
    if (takeProfitPrice !== null && takeProfitPrice > 0) {
      const tpResult = await createStopOrder(symbol, orderSide, contracts, takeProfitPrice, exchangeId, {
        type: 'take_profit', reduceOnly: true,
      });
      results.push({ type: 'take_profit', ...tpResult });
    }

    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============ REST API 导出 ============
export { restCreateOrder, restCancelOrder, restCancelAllOrders, restGetOpenOrders, restCreateAlgoOrder, restCancelAlgoOrder, toBinanceSymbol, binanceRequest, createConditionalOrder };

// ============ 初始化 ============
loadExchangeConfigs();
console.log('[CEX] 合约交易引擎已加载');
console.log(`[CEX] 已配置交易所: ${exchangeConfigs.length > 0 ? exchangeConfigs.map(c => c.exchangeId).join(', ') : '无'}`);
console.log(`[CEX] 可用风格: ${Object.keys(STYLE_PRESETS).join(', ')}`);