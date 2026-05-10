/**
 * cex-strategy.js — 合约策略引擎 (v1)
 *
 * 双信号源: 趋势跟踪 + 均值回归
 * 三套风格: 保守/稳健/激进 (复用 STYLE_PRESETS)
 * 信号综合裁决 → 开/平/调
 */
import * as cexData from './cex-data.js';
import * as cexEngine from './cex-engine.js';
import * as riskManager from './risk-manager.js';
import * as adaptive from './cex-adaptive.js';
import { appendCexLog } from './cex-logger.js';
import * as cexIntel from './cex-intel.js';

// ============ 策略状态 ============
let isRunning = false;
let isEvaluating = false; // 评估锁，防并发重复开仓
let strategyTimer = null;
let checkTimer = null;
let activeSymbols = ['ETH/USDT'];
let symbolExchange = {};      // { 'ETH/USDT': 'binance'|'gate' } — 每个交易对所属交易所
let currentSignals = {};      // { 'ETH/USDT': { trend, meanReversion, combined, decision } }
let positionHistory = [];     // 策略开平记录
let autoOpenedPositions = new Set(); // 跟踪策略自动开仓的symbol
let strategyMode = 'dual';   // 'dual' = 双币(BTC+ETH), 'single' = 单币
let primarySymbol = 'BTC/USDT:USDT'; // 单币模式下的主交易对
let unsubscribeFns = [];      // WebSocket 取消订阅函数

/** 获取交易对对应的交易所ID（默认 binance） */
function getExchangeId(symbol) {
  return symbolExchange[symbol] || 'binance';
}

/** 设置交易对对应的交易所 */
export function setSymbolExchange(symbol, exchangeId) {
  symbolExchange[symbol] = exchangeId;
  console.log(`[Strategy] 🔄 ${symbol} 交易所设为 ${exchangeId}`);
}

/** 获取所有交易对的交易所映射 */
export function getSymbolExchangeMap() {
  return { ...symbolExchange };
}

// 策略参数（每5分钟评估一次）
const EVALUATE_INTERVAL_MS = 5 * 60 * 1000;
let trailIntervalMs = 30000;  // 追踪止盈检查间隔（毫秒），默认30秒

// 技术指标窗口
const EMA_FAST = 9;
const EMA_SLOW = 21;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_STD = 2;

// ============ 技术指标计算 ============

/**
 * EMA 计算
 */
function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * RSI 计算
 */
function calcRSI(data, period = RSI_PERIOD) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * MACD 计算
 */
function calcMACD(data) {
  if (data.length < MACD_SLOW + MACD_SIGNAL) return null;
  const ema12 = calcEMA(data, MACD_FAST);
  const ema26 = calcEMA(data, MACD_SLOW);
  if (ema12 === null || ema26 === null) return null;
  const macdLine = ema12 - ema26;

  // 计算 signal line (EMA of MACD line)
  // 简化: 用最近 MACD_SIGNAL 个差值估算
  const macdValues = [];
  for (let i = data.length - MACD_SIGNAL; i < data.length; i++) {
    const e12 = calcEMA(data.slice(0, i + 1), MACD_FAST);
    const e26 = calcEMA(data.slice(0, i + 1), MACD_SLOW);
    if (e12 !== null && e26 !== null) {
      macdValues.push(e12 - e26);
    }
  }
  const signalLine = macdValues.length > 0
    ? macdValues.reduce((a, b) => a + b, 0) / macdValues.length
    : macdLine;
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

/**
 * 布林带计算
 */
function calcBollingerBands(data, period = BB_PERIOD, std = BB_STD) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + sd * std,
    lower: mean - sd * std,
    bandwidth: (2 * sd * std) / mean,
  };
}

// ============ 信号生成 ============

/**
 * 高级别K线趋势过滤（1小时/4小时）
 * 防止逆大趋势开仓
 */
function getHigherTFtrend(symbol) {
  // 尝试1小时K线
  let klines = cexData.getKlines(symbol, '1h', 30);
  if (!klines || klines.length < 20) {
    klines = cexData.getKlines(symbol, '15m', 80);
    if (!klines || klines.length < 20) return 'neutral';
  }
  
  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];
  
  // EMA12 / EMA26 (小时级别比15分钟可靠得多)
  const emaFast = calcEMA(closes, 12);
  const emaSlow = calcEMA(closes, 26);
  if (emaFast === null || emaSlow === null) return 'neutral';
  
  // 价格在两条EMA之上且金叉 = 多头趋势
  if (currentPrice > emaFast && currentPrice > emaSlow && emaFast > emaSlow) return 'long';
  // 价格在两条EMA之下且死叉 = 空头趋势
  if (currentPrice < emaFast && currentPrice < emaSlow && emaFast < emaSlow) return 'short';
  
  // 模糊状态：偏向当前价格相对两条EMA的位置
  if (currentPrice > emaSlow) return 'weak_long';
  if (currentPrice < emaSlow) return 'weak_short';
  return 'neutral';
}

/**
 * 趋势跟踪信号
 * 返回: { direction: 'long'|'short'|'neutral', confidence: 0-100, reason: string }
 */
function generateTrendSignal(symbol) {
  const klines = cexData.getKlines(symbol, '15m', 50);
  if (klines.length < EMA_SLOW) {
    return { direction: 'neutral', confidence: 0, reason: '数据不足' };
  }

  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];
  const emaFast = calcEMA(closes, EMA_FAST);
  const emaSlow = calcEMA(closes, EMA_SLOW);
  const macd = calcMACD(closes);

  if (emaFast === null || emaSlow === null) {
    return { direction: 'neutral', confidence: 0, reason: '指标不足' };
  }

  let score = 0;
  let reasons = [];

  // EMA 金叉/死叉
  if (emaFast > emaSlow) {
    score += 30;
    reasons.push('EMA金叉');
  } else {
    score -= 30;
    reasons.push('EMA死叉');
  }

  // 价格相对 EMA 位置
  const emaMid = (emaFast + emaSlow) / 2;
  if (currentPrice > emaMid * 1.02) { score += 15; reasons.push('价格>EMA2%'); }
  else if (currentPrice < emaMid * 0.98) { score -= 15; reasons.push('价格<EMA2%'); }

  // MACD
  if (macd) {
    if (macd.histogram > 0) { score += 20; reasons.push('MACD多头'); }
    else { score -= 20; reasons.push('MACD空头'); }
    if (macd.macdLine > macd.signalLine) { score += 10; reasons.push('MACD线上穿'); }
    else { score -= 10; reasons.push('MACD线下穿'); }
  }

  // 趋势强度（ADX 简化: 用价格变动幅度）
  const range = Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20));
  const avgPrice = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const trendStrength = (range / avgPrice) * 100;
  if (trendStrength > 5) { score = score > 0 ? score + 10 : score - 10; reasons.push('强趋势'); }

  const absScore = Math.abs(score);
  const direction = score > 20 ? 'long' : score < -20 ? 'short' : 'neutral';

  return {
    direction,
    confidence: Math.min(absScore, 80),
    reason: reasons.join(', '),
    score,
  };
}

/**
 * 均值回归信号
 * 返回: { direction: 'long'|'short'|'neutral', confidence: 0-100, reason: string }
 */
function generateMeanReversionSignal(symbol) {
  const klines = cexData.getKlines(symbol, '15m', 50);
  if (klines.length < RSI_PERIOD + 5) {
    return { direction: 'neutral', confidence: 0, reason: '数据不足' };
  }

  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];

  // RSI
  const rsi = calcRSI(closes);
  const bb = calcBollingerBands(closes);

  let score = 0;
  let reasons = [];

  // RSI 信号
  if (rsi < 30) { score += 40; reasons.push(`RSI超卖(${rsi.toFixed(0)})`); }
  else if (rsi < 40) { score += 20; reasons.push(`RSI偏低(${rsi.toFixed(0)})`); }
  else if (rsi > 70) { score -= 40; reasons.push(`RSI超买(${rsi.toFixed(0)})`); }
  else if (rsi > 60) { score -= 20; reasons.push(`RSI偏高(${rsi.toFixed(0)})`); }

  // 布林带信号
  if (bb) {
    if (currentPrice <= bb.lower * 1.01) {
      score += 30;
      reasons.push('触下轨');
    } else if (currentPrice >= bb.upper * 0.99) {
      score -= 30;
      reasons.push('触上轨');
    }

    // 布林带宽度（缩口 = 变盘信号）
    if (bb.bandwidth < 0.05) {
      reasons.push('布林缩口待变盘');
    }
  }

  // 成交量验证
  const recentVol = klines.slice(-5).reduce((a, k) => a + k.volume, 0) / 5;
  const prevVol = klines.slice(-10, -5).reduce((a, k) => a + k.volume, 0) / 5;
  if (prevVol > 0 && recentVol > prevVol * 2) {
    score = score > 0 ? score + 10 : score - 10;
    reasons.push('放量');
  }

  const direction = score > 25 ? 'long' : score < -25 ? 'short' : 'neutral';

  return {
    direction,
    confidence: Math.min(Math.abs(score), 70),
    reason: reasons.join(', '),
    score,
  };
}

// ============ 综合裁决 ============

/**
 * 根据风格合并两个信号
 */
function combineSignals(trend, meanRev, style, symbol) {
  const styleConfig = cexEngine.STYLE_PRESETS[style];
  const minConfirm = styleConfig.minSignalConfirm;
  const intelFactors = cexIntel.getAdjustmentFactors();
  const adjustedMinConfirm = minConfirm + intelFactors.signalConfirmAdjust;

  if (trend.direction === 'neutral' && meanRev.direction === 'neutral') {
    return { direction: 'neutral', confidence: 0, reason: '无信号', action: 'hold' };
  }

  // 检查是否一致
  const bothLong = trend.direction === 'long' && meanRev.direction === 'long';
  const bothShort = trend.direction === 'short' && meanRev.direction === 'short';
  const bothNeutral = trend.direction === 'neutral' || meanRev.direction === 'neutral';

  let direction = 'neutral';
  let confidence = 0;
  let reasons = [];
  let action = 'hold';

  if (bothLong) {
    direction = 'long';
    confidence = Math.min(trend.confidence + meanRev.confidence, 100);
    reasons = [`趋势:${trend.reason}`, `均值:${meanRev.reason}`];
    const htf = getHigherTFtrend(symbol);
    if (htf === 'short' || htf === 'weak_short') {
      confidence = Math.floor(confidence * 0.4);
      reasons.push(`⚠️逆1h趋势(${htf})降权`);
    } else if (htf === 'long') {
      reasons.push(`✅顺1h趋势`);
    }
    action = confidence >= 30 ? 'open_long' : 'hold';
  } else if (bothShort) {
    direction = 'short';
    confidence = Math.min(trend.confidence + meanRev.confidence, 100);
    reasons = [`趋势:${trend.reason}`, `均值:${meanRev.reason}`];
    const htf = getHigherTFtrend(symbol);
    if (htf === 'long' || htf === 'weak_long') {
      confidence = Math.floor(confidence * 0.4);
      reasons.push(`⚠️逆1h趋势(${htf})降权`);
    } else if (htf === 'short') {
      reasons.push(`✅顺1h趋势`);
    }
    action = confidence >= 30 ? 'open_short' : 'hold';
  } else if (adjustedMinConfirm === 0) {
    // 激进模式: 任一信号就行动，但需经过高级别趋势过滤
    const stronger = trend.confidence >= meanRev.confidence ? trend : meanRev;
    if (stronger.direction !== 'neutral') {
      direction = stronger.direction;
      confidence = stronger.confidence;
      reasons = [`单一信号:${stronger.reason}`];
      // 高级别趋势过滤
      const htf = getHigherTFtrend(symbol);
      const isAgainst = (direction === 'long' && (htf === 'short' || htf === 'weak_short'))
                     || (direction === 'short' && (htf === 'long' || htf === 'weak_long'));
      if (isAgainst) {
        confidence = Math.floor(confidence * 0.4);
        reasons.push(`⚠️逆1h趋势(${htf})降权`);
      } else if ((direction === 'long' && htf === 'long') || (direction === 'short' && htf === 'short')) {
        reasons.push(`✅顺1h趋势`);
      }
      action = confidence >= 25 ? (direction === 'long' ? 'open_long' : 'open_short') : 'hold';
    }
  } else if (adjustedMinConfirm === 1) {
    // 稳健模式: 优先趋势，无趋势时用均值 + 高级别趋势过滤
    if (trend.direction !== 'neutral' && trend.confidence >= 40) {
      direction = trend.direction;
      confidence = trend.confidence;
      reasons = [`趋势为主:${trend.reason}`];
      const htf = getHigherTFtrend(symbol);
      const isAgainst = (direction === 'long' && (htf === 'short' || htf === 'weak_short'))
                     || (direction === 'short' && (htf === 'long' || htf === 'weak_long'));
      if (isAgainst) { confidence = Math.floor(confidence * 0.4); reasons.push(`⚠️逆1h趋势降权`); }
      action = confidence >= 30 ? (direction === 'long' ? 'open_long' : 'open_short') : 'hold';
    } else if (meanRev.direction !== 'neutral' && meanRev.confidence >= 50) {
      direction = meanRev.direction;
      confidence = meanRev.confidence;
      reasons = [`均值回归:${meanRev.reason}`];
      const htf = getHigherTFtrend(symbol);
      const isAgainst = (direction === 'long' && (htf === 'short' || htf === 'weak_short'))
                     || (direction === 'short' && (htf === 'long' || htf === 'weak_long'));
      if (isAgainst) { confidence = Math.floor(confidence * 0.5); reasons.push(`⚠️逆1h趋势降权`); }
      action = confidence >= 30 ? (direction === 'long' ? 'open_long' : 'open_short') : 'hold';
    }
  }

  return { direction, confidence, reason: reasons.join(' | '), action, trend, meanRev };
}

// ============ 策略执行 ============

/**
 * 执行一次策略评估
 */
async function evaluateStrategy() {
  if (!isRunning) return;
  if (isEvaluating) return;
  isEvaluating = true;

  const style = cexEngine.getCurrentStyle();
  const styleName = style.style;

  for (const symbol of activeSymbols) {
    try {
      // 获取当前持仓
      const posResult = await cexEngine.getPositions(getExchangeId(symbol), symbol);
      const positions = posResult.positions || [];
      // 标准化比较: ETH/USDT vs ETH/USDT:USDT
      const currentPosition = positions.find(p => 
        p.symbol === symbol || p.symbol === symbol + ':USDT'
      );

      // ====== 市场状态感知 ======
      let marketRegime = 'unknown';
      let signalWeights = { trendWeight: 0.5, meanRevWeight: 0.5 };
      try {
        const klines = cexData.getKlines(symbol, '15m', 50);
        if (klines && klines.length > 15) {
          const highs = klines.map(k => k.high);
          const lows = klines.map(k => k.low);
          const closes = klines.map(k => k.close);
          signalWeights = adaptive.getSignalWeights(highs, lows, closes);
          marketRegime = signalWeights.regime;
        }
      } catch(e) {}
      // 市场状态3次确认队列
      if (!regimeQueues[symbol]) regimeQueues[symbol] = [];
      regimeQueues[symbol].push(marketRegime);
      if (regimeQueues[symbol].length > 3) regimeQueues[symbol].shift();
      const regimeConfirmed = regimeQueues[symbol].length >= 3
        && regimeQueues[symbol].every(r => r === regimeQueues[symbol][0]);
      const intelFactors = cexIntel.getAdjustmentFactors();
      console.log(`[Adapt] 🌐 ${symbol}: ${marketRegime} ${regimeConfirmed ? '✅已确认' : '⏳待确认'} (队列:${regimeQueues[symbol].join(',')}, 趋势${(signalWeights.trendWeight*100).toFixed(0)}%/均值${(signalWeights.meanRevWeight*100).toFixed(0)}%)`);

      // 生成信号
      const trendSignal = generateTrendSignal(symbol);
      const meanRevSignal = generateMeanReversionSignal(symbol);
      // 加权信号: 根据市场状态调整权重
      const weightedScore = (trendSignal.score || 0) * signalWeights.trendWeight + (meanRevSignal.score || 0) * signalWeights.meanRevWeight;
      const weightedConfidence = Math.min(Math.abs(weightedScore), 70);
      const weightedDirection = weightedScore > 20 ? 'long' : weightedScore < -20 ? 'short' : 'neutral';
      const weightedCombined = {
        direction: weightedDirection,
        confidence: weightedConfidence,
        reason: `加权[趋势${(signalWeights.trendWeight*100).toFixed(0)}%+均值${(signalWeights.meanRevWeight*100).toFixed(0)}%]`,
        action: weightedDirection === 'long' ? 'open_long' : weightedDirection === 'short' ? 'open_short' : 'hold',
        trend: trendSignal,
        meanRev: meanRevSignal,
        regime: marketRegime,
      };
      const combined = combineSignals(trendSignal, meanRevSignal, styleName, symbol);

      currentSignals[symbol] = {
        timestamp: Date.now(),
        trend: trendSignal,
        meanReversion: meanRevSignal,
        combined,
        hasPosition: !!currentPosition,
        positionSide: currentPosition?.side || null,
      };

      // 如果有持仓，检查是否需要平仓（信号反转）
      if (currentPosition) {
        const posSide = currentPosition.side;
        if ((posSide === 'long' && combined.direction === 'short') ||
            (posSide === 'short' && combined.direction === 'long')) {
          // 市场状态确认队列: 如果状态刚切换但未确认(队列不到3次)，暂缓平仓
          const inQueue = regimeQueues[symbol] || [];
          const currentRegime = signalWeights.regime || 'unknown';
          const justFlipped = inQueue.length >= 2 && inQueue[0] !== currentRegime;
          const regimeStable = inQueue.length < 3 || inQueue.every(r => r === inQueue[0]);
          if (justFlipped && !regimeStable) {
            console.log(`[Strategy] ⏳ ${symbol}: 信号反转但市场状态切换未确认(队列:${inQueue.join(',')}), 等待确认`);
          } else {
                    // Signal flip buffer: require 2 consecutive same-direction flips
          if (!signalFlipCount[symbol]) signalFlipCount[symbol] = { long: 0, short: 0 };
          const flipDir = combined.direction;
          const currentFlip = signalFlipCount[symbol];
          if (currentFlip[flipDir] < 1) {
            currentFlip.long = 0;
            currentFlip.short = 0;
            currentFlip[flipDir] = 1;
            console.log(`[Strategy] ${symbol}: 信号翻转至${flipDir}(第1次), 等待下次确认`);
          } else {
            // 只平自动开仓的单，跳过手动开仓
            if (!autoOpenedPositions.has(symbol)) {
              console.log(`[Strategy] ⏭ ${symbol}: 信号翻转但为手动仓，跳过`);
              continue;
            }
            console.log(`[Strategy] ${symbol}: 信号翻转至${flipDir}(已确认), 平${posSide}仓`);
            currentFlip.long = 0;
            currentFlip.short = 0;
const closeResult = await cexEngine.closePosition(symbol, posSide);
          if (closeResult.success && closeResult.realizedPnl !== undefined) {
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 策略平${posSide === 'long' ? '多' : '空'} ${symbol} ${(currentPosition?.contracts || '?').toString().padEnd(6)}张 @${closeResult.closePrice}`, {
              realizedPnl: closeResult.realizedPnl,
              pnlPercent: closeResult.pnlPercent,
              entryPrice: closeResult.entryPrice,
              contracts: currentPosition?.contracts,
            });
            if (closeResult.pnlPercent !== undefined) adaptive.recordReturn(symbol, closeResult.pnlPercent);
            await riskManager.onPositionClosed(symbol, posSide, closeResult.realizedPnl, closeResult.pnlPercent, getExchangeId(symbol));
          } else {
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 策略平${posSide === 'long' ? '多' : '空'} ${symbol} ${(currentPosition?.contracts || '?').toString().padEnd(6)}张 (信号反转)`, { contracts: currentPosition?.contracts });
          }
          positionHistory.push({
            timestamp: Date.now(),
            symbol,
            action: `close_${posSide}`,
            reason: `信号反转: ${combined.reason}`,
            style: styleName,
          });
          }
        }
      }
      }

      // 风控检查
      const riskStatus = await riskManager.getRiskStatus();
      if (!riskStatus.canTrade) {
        console.log(`[Strategy] ⛔ ${symbol}: 风控拦截 (${riskStatus.dailyPnlPercent.toFixed(1)}%)`);
        continue;
      }

      // 夏普比率检查
      const sharpeCheck = adaptive.shouldTradeSymbol ? adaptive.shouldTradeSymbol(symbol) : { canTrade: true };
      if (!sharpeCheck.canTrade) {
        console.log(`[Strategy] ⛔ ${symbol}: 夏普拦截 (${sharpeCheck.sharpe}) — ${sharpeCheck.reason}`);
        continue;
      }

      // 震荡市不开仓（避免磨损）
      if (!currentPosition && combined.action.startsWith('open_') && marketRegime === 'ranging') {
        console.log(`[Strategy] ⏸ ${symbol}: 震荡市(${marketRegime})不开仓，避免磨损`);
        continue;
      }

      // 检查冷却期 + 已有同币持仓
      if (!currentPosition && combined.action.startsWith('open_')) {
        // 止损冷却期内不开仓
        const lastSl = lastStopLossTime[symbol] || 0;
        if ((Date.now() - lastSl) < STOP_LOSS_COOLDOWN_MS) {
          console.log(`[Strategy] ⏸ ${symbol}: 止损冷却中 (${Math.round((STOP_LOSS_COOLDOWN_MS - (Date.now() - lastSl))/1000)}s 剩余)，跳过`);
          continue;
        }
        try {
          const allPosResult = await cexEngine.getPositions();
          const allPositions = allPosResult.positions || [];
          // 检查当前交易对是否已有仓位（任何方向）
          const hasSameSymbolPos = allPositions.some(p => {
            const psym = (p.symbol || '').replace(':USDT', '');
            const ssym = symbol.replace(':USDT', '');
            return psym === ssym && p.contracts && Math.abs(p.contracts) > 0;
          });
          if (hasSameSymbolPos) {
            console.log(`[Strategy] ⏸ ${symbol}: 已有同币持仓，跳过`);
            continue;
          }
        } catch(e) {}
        const side = combined.action === 'open_long' ? 'long' : 'short';
        // ====== 自适应仓位管理 ======
        const bal = await cexEngine.getBalance();
        // ② 使用可用余额（已有持仓时扣除已用保证金）
        const totalCap = bal.free || bal.total || 30;
        // 双币模式：每个币种分一半资金，单币模式：全给主币
        const modeSplit = (strategyMode === 'dual' && activeSymbols.length > 1) ? 0.5 : 1.0;
        const cappedCap = totalCap * modeSplit;
        const ticker = await cexEngine.getTicker(symbol);
        const price = ticker.last || ticker.markPrice;
        const posCalc = cexEngine.calculatePosition(totalCap);
        // ④ 动态杠杆：根据ATR和市场状态调整
        let dynLeverage = posCalc.leverage || 5;
        try {
          const klines = cexData.getKlines(symbol, '15m', 50);
          if (klines && klines.length > 15) {
            const highs = klines.map(k => k.high);
            const lows = klines.map(k => k.low);
            const closes = klines.map(k => k.close);
            const atr = adaptive.calcATR(highs, lows, closes);
            if (atr && atr.atrPercent > 0) {
              dynLeverage = adaptive.calculateDynamicLeverage(posCalc.leverage || 5, atr.atrPercent, marketRegime);
              console.log(`[Strategy] ⚙️ ${symbol}: 动态杠杆 ${posCalc.leverage}x→${dynLeverage}x (ATR:${atr.atrPercent.toFixed(1)}%, ${marketRegime})`);
            }
          }
        } catch(e) {}

        const stats = adaptive.getTradeStats(20);
        const minForSymbol = { 'ETH/USDT': 0.01, 'BTC/USDT:USDT': 0.001 }[symbol] || 0.001;

        // ① 传入 positionPercent 作为硬上限
        const styleCfgForPos = cexEngine.getCurrentStyle();
        const posPercent = styleCfgForPos.config?.positionPercent || 15;
        const adaptivePos = adaptive.calculateAdaptivePosition(cappedCap, price, dynLeverage, minForSymbol, stats, marketRegime, posPercent);
        let contracts = adaptivePos.contracts;
        // 情报调整: 根据市场情绪微调仓位和杠杆
        if (intelFactors && intelFactors.sentimentScore !== 0) {
          const origContracts = contracts;
          contracts = parseFloat((contracts * intelFactors.positionMultiplier).toFixed(6));
          const origLev = dynLeverage;
          dynLeverage = parseFloat(Math.max(1, (dynLeverage * intelFactors.leverageMultiplier)).toFixed(1));
          console.log(`[Intel] ${symbol}: 情报调整 仓位${(intelFactors.positionMultiplier*100-100).toFixed(0) > 0 ? '+' : ''}${(intelFactors.positionMultiplier*100-100).toFixed(0)}%(${origContracts}->${contracts}) 杠杆${(intelFactors.leverageMultiplier*100-100).toFixed(0) > 0 ? '+' : ''}${(intelFactors.leverageMultiplier*100-100).toFixed(0)}%(${origLev}->${dynLeverage}x) [${intelFactors.sentiment}]`);
        }
        const minCost = 5;

        const positionValue = contracts * price;
        const neededMarginValue = positionValue / dynLeverage;
        if (positionValue < minCost) {
          console.log(`[Strategy] ⏸ ${symbol}: 头寸价值${positionValue.toFixed(2)} < 最小${minCost}, 跳过`);
          continue;
        }
        if (neededMarginValue > cappedCap) {
          console.log(`[Strategy] ⏸ ${symbol}: 需保证金$${neededMarginValue.toFixed(2)} > 可用$${cappedCap.toFixed(2)}, 跳过`);
          continue;
        }

        // ====== 开仓决策清单（交易员视角） ======
        console.log(`[Trader] 📋 ===== 开仓决策清单 ${symbol} =====`);
        console.log(`[Trader] 📊 信号: ${combined.direction} (趋势${trendSignal.confidence}%+均值${meanRevSignal.confidence}%)`);
        console.log(`[Trader] 📊 市场状态: ${marketRegime} ${regimeConfirmed ? '✅已确认' : '⏳待确认'}`);
        console.log(`[Trader] 📊 风控: ${riskStatus.dailyPnlPercent.toFixed(1)}% ${riskStatus.canTrade ? '✅通过' : '⛔拦截'}`);
        console.log(`[Trader] 📊 夏普: ${sharpeCheck.sharpe} (${sharpeCheck.reason})`);
        console.log(`[Trader] 📊 资金: $${cappedCap.toFixed(2)} | 方向: ${side} | 张数: ${contracts} | 杠杆: ${dynLeverage}x`);
        console.log(`[Trader] 📊 仓位价值: $${positionValue.toFixed(2)} | 保证金: $${neededMarginValue.toFixed(2)}`);
        console.log(`[Trader] 📊 情报调整: 仓位${((intelFactors?.positionMultiplier||1)*100-100).toFixed(0) > 0 ? '+' : ''}${((intelFactors?.positionMultiplier||1)*100-100).toFixed(0)}% | 杠杆${((intelFactors?.leverageMultiplier||1)*100-100).toFixed(0) > 0 ? '+' : ''}${((intelFactors?.leverageMultiplier||1)*100-100).toFixed(0)}%`);
        console.log(`[Trader] 📊 ATD策略: ${adaptivePos.reason}`);
        console.log(`[Trader] 📊 高级别趋势: ${getHigherTFtrend ? getHigherTFtrend(symbol) : 'N/A'}`);
        console.log(`[Trader] 🚀 执行开仓: ${symbol} ${side} ${contracts}张 @${dynLeverage}x`);

        console.log(`[Strategy] 🚀 ${symbol}: 开${side}仓 ${contracts} (${positionValue.toFixed(2)}U @ ${styleName}) ${adaptivePos.reason}`);
        const result = await cexEngine.openPosition(symbol, side, contracts, getExchangeId(symbol), {
          marginMode: 'isolated',
        });

        if (result.success) {
          autoOpenedPositions.add(symbol);
          try { await riskManager.onPositionOpened(symbol, side, result.margin || (contracts * price / dynLeverage)); } catch(e) { console.log('[Strategy] ⚠️ onPositionOpened异常:', e.message); }
          appendCexLog('auto_open', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 策略开${side === 'long' ? '多' : '空'} ${symbol} ${contracts}张 ${posCalc.leverage||'?'}x @ ${result.entryPrice || '?'}`);
          positionHistory.push({
            timestamp: result.timestamp,
            symbol,
            action: `open_${side}`,
            contracts,
            entryPrice: result.entryPrice,
            stopLoss: result.stopLossPrice,
            takeProfit: result.takeProfitPrice,
            reason: combined.reason,
            style: styleName,
            confidence: combined.confidence,
          });
          if (signalFlipCount[symbol]) {
            signalFlipCount[symbol].long = 0;
            signalFlipCount[symbol].short = 0;
          }
        } else {
          appendCexLog('auto_open_fail', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 策略开仓失败 ${symbol}: ${result.error}`);
          console.log(`[Strategy] ❌ 开仓失败: ${result.error}`);
        }
      }

    } catch (err) {
      console.error(`[Strategy] ⚠️ ${symbol} 评估异常: ${err.message}\n${err.stack}`);
    }
  }
  isEvaluating = false;
}

// ============ 价格监控（盘中调整止盈止损） ============

// ============ 追踪止盈状态 ============
// { 'ETH/USDT:USDT': { slPrice: 2200, tpPrice: 2600, trailActivated: false, bestStop: 0 } }
let trailingState = {};

// 市场状态确认队列 — 连续3次相同才确认状态切换，过滤假信号
let regimeQueues = {}; // { 'BTC/USDT:USDT': ['trending','trending','ranging'] }

// 止损冷却期（每个币种止损后N分钟内不开新仓）
const STOP_LOSS_COOLDOWN_MS = 15 * 60 * 1000; // 15分钟
let lastStopLossTime = {};
/** Signal flip buffer - requires 2 consecutive flips to close */
let signalFlipCount = {}; // { 'BTC/USDT:USDT': timestamp }

/**
 * 追踪止盈执行 — 每30秒检查一次，逐步锁定利润
 * 生命周期：
 *   开仓 → 初始止盈止损（由 openPosition 设置）
 *   ↓ 盈利达 trailActivatePercent
 *   追踪激活 → 取消旧止损 → 设置新止损（保本+追踪步长）
 *   ↓ 价格继续上涨
 *   止损不断上移 → 锁定更多利润
 *   ↓ 价格回撤触发止损
 *   仓位平掉 → 跟踪状态清除
 */
async function checkPositions() {
  if (!isRunning) return;
  await riskManager.riskCheck();

  try {
    const posResult = await cexEngine.getPositions();
    const positions = posResult.positions || [];
    const trackedSymbols = new Set();

    for (const pos of positions) {
      if (!pos.entryPrice || !pos.markPrice) continue;

      const symbol = pos.symbol;
      const pnlPercent = pos.percentage || 0;
      const contracts = Math.abs(pos.contracts || 0);
      const style = cexEngine.getCurrentStyle();
      const styleCfg = style.config;
      const isLong = pos.side === 'long';

      trackedSymbols.add(symbol);

      // 自动恢复追踪状态：服务重启后 autoOpenedPositions 为空，
      // 通过检查交易所上是否有算法单来判断是否自动仓
      if (!autoOpenedPositions.has(symbol)) {
        try {
          const existingOrders = await cexEngine.restGetOpenOrders(symbol, getExchangeId(symbol));
          if (existingOrders.success && existingOrders.orders && existingOrders.orders.length > 0) {
            const closeSide = pos.side === 'long' ? 'sell' : 'buy';
            const hasAlgo = existingOrders.orders.some(o =>
              o.algoType === 'CONDITIONAL' && o.side.toLowerCase() === closeSide &&
              (o.type === 'STOP' || o.type === 'TAKE_PROFIT')
            );
            if (hasAlgo) {
              console.log(`[Trail] 🔄 ${symbol}: 恢复自动仓(检测到算法单)`);
              autoOpenedPositions.add(symbol);
            } else {
              console.log(`[Trail] ⏭ ${symbol}: 无匹配算法单，视为手动仓跳过`);
              continue;
            }
          } else {
            console.log(`[Trail] ⏭ ${symbol}: 无算法单(空或查询失败)，视为手动仓跳过`);
            continue;
          }
        } catch (e) {
          console.log(`[Trail] ⏭ ${symbol}: 算法单检查异常(${e.message})，视为手动仓跳过`);
          continue;
        }
      }

      // 初始化追踪状态（如果没有的话）
      if (!trailingState[symbol]) {
        // ====== ATR 动态止盈止损（自适应） ======
        let atr = { atr: 0, atrPercent: 1 };
        let marketRegime = 'unknown';
        try {
          const klines = cexData.getKlines(symbol, '15m', 50);
          if (klines && klines.length > 15) {
            const highs = klines.map(k => k.high);
            const lows = klines.map(k => k.low);
            const closes = klines.map(k => k.close);
            atr = adaptive.calcATR(highs, lows, closes);
            marketRegime = adaptive.detectMarketRegime(highs, lows, closes);
          }
        } catch (e) {}

        let slPrice, tpPrice, trailActivatePercent, trailStepPercent;
        let stopType = 'fixed';

        if (atr.atr > 0 && atr.atrPercent > 0.1) {
          const stops = adaptive.calculateAdaptiveStops(
            pos.entryPrice, pos.entryPrice, pos.side, atr.atr, atr.atrPercent, styleCfg
          );
          slPrice = stops.slPrice;
          tpPrice = stops.tpPrice;
          trailActivatePercent = stops.trailActivatePercent;
          trailStepPercent = stops.trailStepPercent;
          stopType = 'atr';
        } else {
          slPrice = isLong
            ? pos.entryPrice * (1 - styleCfg.stopLossPercent / 100)
            : pos.entryPrice * (1 + styleCfg.stopLossPercent / 100);
          tpPrice = isLong
            ? pos.entryPrice * (1 + styleCfg.takeProfitPercent / 100)
            : pos.entryPrice * (1 - styleCfg.takeProfitPercent / 100);
          trailActivatePercent = styleCfg.trailActivatePercent;
          trailStepPercent = styleCfg.trailStepPercent;
        }

        // 分段止盈参数
        const partialTpRatio = 0.7; // 第一段止盈占满TP的比例
        const partialTpPrice = isLong
          ? pos.entryPrice * (1 + styleCfg.takeProfitPercent / 100 * partialTpRatio)
          : pos.entryPrice * (1 - styleCfg.takeProfitPercent / 100 * partialTpRatio);

        trailingState[symbol] = {
          slPrice: parseFloat(slPrice.toFixed(2)),
          tpPrice: parseFloat(tpPrice.toFixed(2)),
          partialTpPrice: parseFloat(partialTpPrice.toFixed(2)),
          partialTpTriggered: false,
          trailActivated: false,
          trailActivatePercent,
          trailStepPercent,
          bestStop: isLong
            ? parseFloat(slPrice.toFixed(2))
            : parseFloat(tpPrice.toFixed(2)),
          lastUpdated: Date.now(),
          marketRegime,
          atrPercent: atr.atrPercent,
          initialContracts: contracts,
        };
        console.log(`[Trail] 📋 ${symbol}: ${stopType === 'atr' ? 'ATR' : '固定'}止损 $${slPrice.toFixed(2)}, 止盈 $${tpPrice.toFixed(2)} (${marketRegime}, ATR:${atr.atrPercent.toFixed(1)}%)`);
        // 🔧 修复：检查交易所上是否真的有对应的SL/TP条件单，缺失则补建
        // openPosition() 创建可能因精度错误失败，或服务重启后条件单已消失
        try {
          const existingOrders = await cexEngine.restGetOpenOrders(symbol, getExchangeId(symbol));
          let hasAlgoSl = false, hasAlgoTp = false;
          const closeSide = pos.side === 'long' ? 'sell' : 'buy';
          if (existingOrders.success) {
            for (const o of existingOrders.orders) {
              if (o.algoType !== 'CONDITIONAL' || o.side.toLowerCase() !== closeSide) continue;
              if (o.type === 'STOP') hasAlgoSl = true;
              if (o.type === 'TAKE_PROFIT') hasAlgoTp = true;
            }
          }
          if (!hasAlgoSl) {
            console.log(`[Trail] 🔧 ${symbol}: 缺止损单，补建 $${slPrice.toFixed(2)}`);
            const r = await cexEngine.restCreateAlgoOrder(symbol, closeSide, 'STOP', contracts, slPrice, {
              price: slPrice, reduceOnly: true, workingType: 'MARK_PRICE',
            }, getExchangeId(symbol));
            if (r.success) {
              appendCexLog('algo_create', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 补建止损 ${symbol} $${slPrice}`, { type: 'STOP', price: slPrice });
            } else {
              console.log(`[Trail] ⚠️ ${symbol}: 止损补建失败: ${r.error}`);
            }
          }
          if (!hasAlgoTp) {
            console.log(`[Trail] 🔧 ${symbol}: 缺止盈单，补建 $${tpPrice.toFixed(2)}`);
            const r = await cexEngine.restCreateAlgoOrder(symbol, closeSide, 'TAKE_PROFIT', contracts, tpPrice, {
              price: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE',
            }, getExchangeId(symbol));
            if (r.success) {
              appendCexLog('algo_create', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 补建止盈 ${symbol} $${tpPrice}`, { type: 'TAKE_PROFIT', price: tpPrice });
            } else {
              console.log(`[Trail] ⚠️ ${symbol}: 止盈补建失败: ${r.error}`);
            }
          }
        } catch (e) {
          console.log(`[Trail] ⚠️ ${symbol}: 补建检查异常: ${e.message}`);
        }
      }

      const state = trailingState[symbol];

      // ====== 阶段一：检查是否达到追踪触发点（ATR自适应） ======
      const styleTrigger = state.trailActivatePercent || styleCfg.trailActivatePercent;
      const atrPct = state.atrPercent || 1;
      // ATR自适应: max(ATR * 3, 3%)，但不超过固定值的80%
      const adaptiveTrigger = Math.max(atrPct * 3, 3);
      const triggerPercent = Math.min(adaptiveTrigger, styleTrigger * 0.8);
      if (!state.trailActivated && pnlPercent >= triggerPercent) {
        state.trailActivated = true;
        console.log(`[Trail] 🎯 ${symbol}: 盈利${pnlPercent.toFixed(1)}% ≥ ${triggerPercent.toFixed(1)}% (ATR:${atrPct.toFixed(1)}%动态), 激活追踪！`);
      }

      // ====== 阶段二：追踪止盈计算 ======
      if (state.trailActivated) {
        // 追踪步长（优先用ATR自适应值）
        const trailStepPercent = state.trailStepPercent || styleCfg.trailStepPercent;
        const trailStep = pos.markPrice * (trailStepPercent / 100);

        // 新的止损位: 当前价 +/- 追踪步长（toFixed(2)防浮点抖动）
        const newTrailStopRaw = isLong
          ? pos.markPrice - trailStep
          : pos.markPrice + trailStep;
        const newTrailStop = parseFloat(newTrailStopRaw.toFixed(2));

        // 硬底保护: 追踪止损不能越过 entry×0.97(多)/entry×1.03(空)，防止计算异常
        const hardFloor = isLong
          ? pos.entryPrice * 0.97
          : pos.entryPrice * 1.03;
        const boundedStop = isLong
          ? Math.max(newTrailStop, hardFloor)
          : Math.min(newTrailStop, hardFloor);
        const boundedTrailStop = parseFloat(boundedStop.toFixed(2));
        if (boundedTrailStop !== newTrailStop) {
          console.log(`[Trail] 🛡️ ${symbol}: 追踪止损触碰硬底保护 $${newTrailStop.toFixed(2)}→$${boundedTrailStop.toFixed(2)} (floor:$${hardFloor.toFixed(2)}) — 强制平仓!`);
          try {
            const closeResult = await cexEngine.closePosition(symbol, pos.side);
            if (closeResult.success) {
              console.log(`[Trail] 🛑 ${symbol}: 硬底保护触发强制平仓成功 PnL:$${closeResult.realizedPnl}`);
              if (closeResult.pnlPercent !== undefined) adaptive.recordReturn(symbol, closeResult.pnlPercent);
              appendCexLog('strategy_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 硬底保护强平 ${symbol} ${contracts.toString().padEnd(6)}张 PnL:${closeResult.realizedPnl?.toFixed(2)||'?'}`, { type: 'hard_floor_forced', realizedPnl: closeResult.realizedPnl, closePrice: closeResult.closePrice, pnlPercent: closeResult.pnlPercent, contracts });
            } else {
              console.log(`[Trail] ❌ ${symbol}: 硬底保护强制平仓失败: ${closeResult.error}`);
            }
          } catch (err) {
            console.log(`[Trail] ❌ ${symbol}: 硬底保护强制平仓异常: ${err.message}`);
          }
          return; // 已平仓，退出当前循环
        }
        const finalTrailStop = boundedTrailStop;

        // 只有新止损位明显优于最佳止损位时才更新（做多需要更高，做空需要更低）
        // 使用toFixed(2)后的精确值比较，避免浮点噪声触发无意义重建
        const shouldUpdateSL = isLong
          ? finalTrailStop > state.bestStop
          : finalTrailStop < state.bestStop;

        // 🔧 修复: TP锚定到开仓价 - 追踪激活后TP只降不升
        // 追踪止盈通过移动止损锁利, 不应把TP推远
        const tpPercent = state.trailStepPercent ? (state.trailStepPercent * 3) : styleCfg.takeProfitPercent;
        const baseTP = parseFloat((isLong
          ? pos.entryPrice * (1 + tpPercent / 100)
          : pos.entryPrice * (1 - tpPercent / 100)).toFixed(2));
        // 追踪激活后TP只降不升: 取当前TP和计算TP中更保守的值
        // 多头: min(当前TP, 计算TP) 防止TP被推高
        // 空头: max(当前TP, 计算TP) 防止TP被推低
        const newTP = isLong
          ? Math.min(baseTP, state.tpPrice)
          : Math.max(baseTP, state.tpPrice);
        const shouldUpdateTP = isLong
          ? newTP < state.tpPrice
          : newTP > state.tpPrice;
        // 如果TP价格没变，跳过无意义的取消+重建
        const tpPriceChanged = shouldUpdateTP;

        if (shouldUpdateSL || shouldUpdateTP) {
          // 更新最佳止损记录
          if (shouldUpdateSL) {
            state.bestStop = finalTrailStop;
          }

          const newSL = shouldUpdateSL ? parseFloat(finalTrailStop.toFixed(2)) : null;
          const newTP2 = shouldUpdateTP ? parseFloat(newTP.toFixed(2)) : null;

          // 提交止盈止损到币安（使用REST Algo API，规避CCXT缺陷）
          const closeSideForOrder = pos.side === 'long' ? 'sell' : 'buy';
          const contractsForOrder = Math.abs(pos.contracts);

          // 获取当前Algo条件单ID（可能有重复，全部收集）
          let algoSlIds = [], algoTpIds = [];
          try {
            const openResult = await cexEngine.restGetOpenOrders(symbol, getExchangeId(symbol));
            if (openResult.success) {
              for (const o of openResult.orders) {
                if (o.algoType !== 'CONDITIONAL' || o.side.toLowerCase() !== closeSideForOrder) continue;
                if (o.type === 'STOP') algoSlIds.push(o.orderId);
                if (o.type === 'TAKE_PROFIT') algoTpIds.push(o.orderId);
              }
            }
          } catch (e) { /* 忽略查询错误 */ }

          // 更新止损Algo单（取消所有旧止损单，再创建新单）
          if (newSL) {
            if (algoSlIds.length > 0) {
              appendCexLog('algo_cleanup', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 追踪止损清理 ${symbol} ${algoSlIds.length}个旧止损单`, { count: algoSlIds.length });
            }
            for (const id of algoSlIds) {
              try { await cexEngine.restCancelAlgoOrder(symbol, id, getExchangeId(symbol)); } catch (e) { /* 可能已成交 */ }
            }
            try {
              const result = await cexEngine.restCreateAlgoOrder(symbol, closeSideForOrder, 'STOP', contractsForOrder, newSL, {
                price: newSL, reduceOnly: true, workingType: 'MARK_PRICE',
              }, getExchangeId(symbol));
              if (result.success) {
                const lockedPercent = trailStepPercent || styleCfg.trailStepPercent;
                appendCexLog('algo_update', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 追踪止损更新 ${symbol} $${state.slPrice.toFixed(2)}→$${newSL.toFixed(2)}`, { price: newSL });
                console.log(`[Trail] 🔒 ${symbol}: 止损 $${state.slPrice.toFixed(2)}→$${newSL.toFixed(2)} (锁定 ${(pnlPercent - lockedPercent).toFixed(1)}%+)`);
                state.slPrice = newSL;
              }
            } catch (e) { /* 可能已平仓 */ }
          }

          // 更新止盈Algo单（取消所有旧止盈单，再创建新单）
          if (newTP2) {
            if (algoTpIds.length > 0) {
              appendCexLog('algo_cleanup', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 追踪止盈清理 ${symbol} ${algoTpIds.length}个旧止盈单`, { count: algoTpIds.length });
            }
            for (const id of algoTpIds) {
              try { await cexEngine.restCancelAlgoOrder(symbol, id, getExchangeId(symbol)); } catch (e) { /* 可能已成交 */ }
            }
            try {
              const result = await cexEngine.restCreateAlgoOrder(symbol, closeSideForOrder, 'TAKE_PROFIT', contractsForOrder, newTP2, {
                price: newTP2, reduceOnly: true, workingType: 'MARK_PRICE',
              }, getExchangeId(symbol));
              if (result.success) {
                appendCexLog('algo_update', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 追踪止盈更新 ${symbol} $${state.tpPrice.toFixed(2)}→$${newTP2.toFixed(2)}`, { price: newTP2 });
                console.log(`[Trail] 🎯 ${symbol}: 止盈 $${state.tpPrice.toFixed(2)}→$${newTP2.toFixed(2)}`);
                state.tpPrice = newTP2;
              }
            } catch (e) { /* 可能已平仓 */ }
          }
          state.lastUpdated = Date.now();
        }
      } else {
        // 还没到追踪触发点，不操作
        // 但如果初始止损因某种原因没设上，补设一个
      }

      // ====== 阶段三：检查是否触发止损或止盈 ======
      const currentPrice = pos.markPrice;

      // 分段止盈检查（第一段止盈 → 平50%）
      if (!state.partialTpTriggered && state.partialTpPrice > 0) {
        const partialHit = isLong ? currentPrice >= state.partialTpPrice : currentPrice <= state.partialTpPrice;
        if (partialHit) {
          console.log(`[Trail] ✂️ ${symbol}: 触发分段止盈! 现价 $${currentPrice.toFixed(2)}, 平50%仓位`);
          const closeResult = await cexEngine.closePosition(symbol, pos.side, getExchangeId(symbol), { percent: 50 });
          if (closeResult.success) {
            state.partialTpTriggered = true;
            // 已平50%，取消旧Algo单，剩余仓位SL移到成本价
            let _partialCleaned = 0;
            try {
              const openOrders = await cexEngine.restGetOpenOrders(symbol, getExchangeId(symbol));
              if (openOrders.success) {
                for (const o of openOrders.orders) {
                  if (o.algoType === 'CONDITIONAL' && o.side.toLowerCase() === (isLong ? 'sell' : 'buy')) {
                    await cexEngine.restCancelAlgoOrder(symbol, o.orderId, getExchangeId(symbol)).catch(() => {});
                    _partialCleaned++;
                  }
                }
                if (_partialCleaned > 0) {
                  appendCexLog('algo_cleanup', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 分段止盈清理 ${symbol} ${_partialCleaned}个旧条件单`, { count: _partialCleaned });
                }
              }
            } catch(e) {
              console.log('[Trail] 分段止盈清理旧单失败:', e.message);
            }
            // 新止损设到成本价（保本）
            const reducedContracts = contracts * 0.5;
            const closeSide = pos.side === 'long' ? 'sell' : 'buy';
            const entrySl = isLong ? pos.entryPrice * 0.995 : pos.entryPrice * 1.005;
            try {
              await cexEngine.restCreateAlgoOrder(symbol, closeSide, 'STOP', reducedContracts, parseFloat(entrySl.toFixed(2)), {
                price: parseFloat(entrySl.toFixed(2)), reduceOnly: true, workingType: 'MARK_PRICE',
              }, getExchangeId(symbol));
            } catch(e) {}
            // 剩余仓位继续按原TP追踪
            state.slPrice = parseFloat(entrySl.toFixed(2));
            state.bestStop = parseFloat(entrySl.toFixed(2));
            state.trailActivated = true; // 强制激活追踪
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 分段止盈50% ${symbol} ${(contracts * 0.5).toString().padEnd(6)}张 @${currentPrice.toFixed(2)}`, {
              triggerType: 'partial_take_profit',
              remainingPercent: 50,
              contracts: contracts * 0.5,
            });
            console.log(`[Trail] 🔒 ${symbol}: 分段止盈完成，剩余50%仓位SL保本 $${entrySl.toFixed(2)}`);
          }
        }
      }

      if (isLong) {
        if (state.slPrice > 0 && currentPrice <= state.slPrice) {
          console.log(`[Trail] 🛑 ${symbol}: 触发止损! 现价 $${currentPrice.toFixed(2)} ≤ 止损 $${state.slPrice.toFixed(2)}`);
          lastStopLossTime[symbol] = Date.now();
          console.log(`[Trail] ⏳ ${symbol}: 止损冷却 ${STOP_LOSS_COOLDOWN_MS/60000}分钟`);
          const closeResult = await cexEngine.closePosition(symbol, pos.side, getExchangeId(symbol));
          if (closeResult.success && closeResult.realizedPnl !== undefined) {
            if (closeResult.pnlPercent !== undefined) adaptive.recordReturn(symbol, closeResult.pnlPercent);
            await riskManager.onPositionClosed(symbol, pos.side, closeResult.realizedPnl, closeResult.pnlPercent, getExchangeId(symbol));
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 止损平${pos.side === 'long' ? '多' : '空'} ${symbol} ${contracts.toString().padEnd(6)}张 @${closeResult.closePrice}`, {
              realizedPnl: closeResult.realizedPnl,
              pnlPercent: closeResult.pnlPercent,
              triggerType: 'stop_loss',
              contracts,
            });
          }
          continue;
        }
        if (state.tpPrice > 0 && currentPrice >= state.tpPrice) {
          console.log(`[Trail] ✅ ${symbol}: 触发止盈! 现价 $${currentPrice.toFixed(2)} ≥ 止盈 $${state.tpPrice.toFixed(2)}`);
          const closeResult = await cexEngine.closePosition(symbol, pos.side, getExchangeId(symbol));
          if (closeResult.success && closeResult.realizedPnl !== undefined) {
            if (closeResult.pnlPercent !== undefined) adaptive.recordReturn(symbol, closeResult.pnlPercent);
            await riskManager.onPositionClosed(symbol, pos.side, closeResult.realizedPnl, closeResult.pnlPercent, getExchangeId(symbol));
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 止盈平${pos.side === 'long' ? '多' : '空'} ${symbol} ${contracts.toString().padEnd(6)}张 @${closeResult.closePrice}`, {
              realizedPnl: closeResult.realizedPnl,
              pnlPercent: closeResult.pnlPercent,
              triggerType: 'take_profit',
              contracts,
            });
            // 趋势重入：止盈后如果趋势仍强且未触发熔断，直接追
            try {
              const riskStatus = await riskManager.getRiskStatus();
              // 检查冷却期
              const lastSl = lastStopLossTime[symbol] || 0;
              const inCooldown = (Date.now() - lastSl) < STOP_LOSS_COOLDOWN_MS;
              if (riskStatus.canTrade && state.marketRegime === 'trending' && !inCooldown) {
                console.log(`[Trail] 🚀 ${symbol}: 趋势仍强(${state.marketRegime}),尝试重入`);
                const evalSignal = currentSignals[symbol];
                // 要求趋势评分 > 40（避免弱信号重复开仓）
                if (evalSignal && evalSignal.trend && evalSignal.trend.direction === pos.side && (evalSignal.trend.confidence || 0) > 40) {
                  const reentryContracts = Math.abs(contracts * 0.5);
                  const minForSymbol = { 'ETH/USDT': 0.01, 'BTC/USDT:USDT': 0.001 }[symbol] || 0.001;
                  if (reentryContracts >= minForSymbol) {
                    const result = await cexEngine.openPosition(symbol, pos.side, reentryContracts, getExchangeId(symbol), {
                      marginMode: 'isolated',
                    });
                    if (result.success) {
                      console.log(`[Trail] 🔄 ${symbol}: 趋势重入成功! ${reentryContracts}张`);
                      appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 趋势重入${pos.side === 'long' ? '多' : '空'} ${symbol} ${reentryContracts}张`, {
                        triggerType: 'momentum_reentry',
                        contracts: reentryContracts,
                      });
                    }
                  }
                }
              }
            } catch(e) {
              console.log(`[Trail] ⚠️ 趋势重入检查异常: ${e.message}`);
            }
          }
          continue;
        }
      } else {
        if (state.slPrice > 0 && currentPrice >= state.slPrice) {
          console.log(`[Trail] 🛑 ${symbol}: 触发止损! 现价 $${currentPrice.toFixed(2)} ≥ 止损 $${state.slPrice.toFixed(2)}`);
          lastStopLossTime[symbol] = Date.now();
          console.log(`[Trail] ⏳ ${symbol}: 止损冷却 ${STOP_LOSS_COOLDOWN_MS/60000}分钟`);
          const closeResult = await cexEngine.closePosition(symbol, pos.side, getExchangeId(symbol));
          if (closeResult.success && closeResult.realizedPnl !== undefined) {
            await riskManager.onPositionClosed(symbol, pos.side, closeResult.realizedPnl, closeResult.pnlPercent, getExchangeId(symbol));
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 止损平${pos.side === 'long' ? '多' : '空'} ${symbol} ${contracts.toString().padEnd(6)}张 @${closeResult.closePrice}`, {
              realizedPnl: closeResult.realizedPnl,
              pnlPercent: closeResult.pnlPercent,
              triggerType: 'stop_loss',
              contracts,
            });
          }
          continue;
        }
        if (state.tpPrice > 0 && currentPrice <= state.tpPrice) {
          console.log(`[Trail] ✅ ${symbol}: 触发止盈! 现价 $${currentPrice.toFixed(2)} ≤ 止盈 $${state.tpPrice.toFixed(2)}`);
          const closeResult = await cexEngine.closePosition(symbol, pos.side, getExchangeId(symbol));
          if (closeResult.success && closeResult.realizedPnl !== undefined) {
            await riskManager.onPositionClosed(symbol, pos.side, closeResult.realizedPnl, closeResult.pnlPercent, getExchangeId(symbol));
            appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 止盈平${pos.side === 'long' ? '多' : '空'} ${symbol} ${contracts.toString().padEnd(6)}张 @${closeResult.closePrice}`, {
              realizedPnl: closeResult.realizedPnl,
              pnlPercent: closeResult.pnlPercent,
              triggerType: 'take_profit',
              contracts,
            });
            // 趋势重入：止盈后如果趋势仍强且未触发熔断，直接追
            try {
              const riskStatus = await riskManager.getRiskStatus();
              const lastSl = lastStopLossTime[symbol] || 0;
              const inCooldown = (Date.now() - lastSl) < STOP_LOSS_COOLDOWN_MS;
              if (riskStatus.canTrade && state.marketRegime === 'trending' && !inCooldown) {
                console.log(`[Trail] 🚀 ${symbol}: 趋势仍强(${state.marketRegime}),尝试重入（空）`);
                const evalSignal = currentSignals[symbol];
                if (evalSignal && evalSignal.trend && evalSignal.trend.direction === pos.side && (evalSignal.trend.confidence || 0) > 40) {
                  const reentryContracts = Math.abs(contracts * 0.5);
                  const minForSymbol = { 'ETH/USDT': 0.01, 'BTC/USDT:USDT': 0.001 }[symbol] || 0.001;
                  if (reentryContracts >= minForSymbol) {
                    const result = await cexEngine.openPosition(symbol, pos.side, reentryContracts, getExchangeId(symbol), {
                      marginMode: 'isolated',
                    });
                    if (result.success) {
                      console.log(`[Trail] 🔄 ${symbol}: 趋势重入成功! ${reentryContracts}张`);
                      appendCexLog('auto_close', `[${cexEngine.getExchangeLabel(getExchangeId(symbol))}] 趋势重入${pos.side === 'long' ? '多' : '空'} ${symbol} ${reentryContracts}张`, {
                        triggerType: 'momentum_reentry',
                        contracts: reentryContracts,
                      });
                    }
                  }
                }
              }
            } catch(e) {
              console.log(`[Trail] ⚠️ 趋势重入检查异常: ${e.message}`);
            }
          }
          continue;
        }
      }
    }

    // ====== 清理已平仓的跟踪状态 ======
    for (const sym of Object.keys(trailingState)) {
      if (!trackedSymbols.has(sym)) {
        console.log(`[Trail] 🧹 ${sym}: 仓位已平，清除追踪状态`);
        delete trailingState[sym];
      }
    }

  } catch (err) {
    console.error(`[Trail] ⚠️ 追踪检查异常: ${err.message}`);
  }
}

// ============ 生命周期 ============

/**
 * 设置策略模式（双币/单币）
 */
export function setStrategyMode(mode) {
  if (mode !== 'dual' && mode !== 'single') {
    return { success: false, error: '模式仅支持 dual 或 single' };
  }
  strategyMode = mode;
  console.log(`[Strategy] 🔄 策略模式切换为: ${mode === 'dual' ? '双币(BTC+ETH)' : '单币'}`);
  return { success: true, mode };
}

/**
 * 获取当前策略模式
 */
export function getStrategyMode() {
  return { mode: strategyMode, primarySymbol };
}

/**
 * 设置单币模式下的主交易对
 */
export function setPrimarySymbol(symbol) {
  primarySymbol = symbol;
  console.log(`[Strategy] 🎯 单币模式主交易对设为: ${symbol}`);
}

/**
 * 获取当前策略要交易的实际交易对列表（根据模式）
 */
function getActiveSymbolsByMode() {
  if (strategyMode === 'single') {
    return [primarySymbol];
  }
  return ['BTC/USDT:USDT', 'ETH/USDT:USDT'];
}

/**
 * 设置策略模式（双币/单币）
 */
export async function startStrategy(symbols = ['ETH/USDT']) {
  if (isRunning) return { success: false, error: '策略已在运行' };

  // 根据策略模式确定实际交易对
  if (symbols && symbols.length > 0) {
    activeSymbols = symbols;
    // 如果有主交易对传入且为单币模式，同步主币
    if (strategyMode === 'single' && symbols.length === 1) {
      primarySymbol = symbols[0];
    }
  } else {
    activeSymbols = getActiveSymbolsByMode();
  }
  isRunning = true;

  // 按交易所分离交易对
  const binanceSymbols = symbols.filter(s => getExchangeId(s) === 'binance');
  const gateSymbols = symbols.filter(s => getExchangeId(s) === 'gate');

  // 启动 Binance 行情
  if (binanceSymbols.length > 0) {
    const wsSymbols = binanceSymbols.map(s =>
      s.replace(/\/USDT.*$/, 'USDT').replace('/', '').toLowerCase()
    );
    cexData.startDataStream(wsSymbols);
  }

  // 启动 Gate 行情轮询
  if (gateSymbols.length > 0) {
    for (const sym of gateSymbols) {
      cexData.addSymbol(sym, 'gate');
    }
    console.log(`[Strategy] 📡 Gate 数据轮询已添加: ${gateSymbols.join(', ')}`);
  }

  // 预加载历史K线
  for (const sym of binanceSymbols) {
    await cexData.prefetchKlines(sym, ['15m', '1h'], 100);
    await cexData.prefetchKlines(sym, ['5m'], 50);
  }
  for (const sym of gateSymbols) {
    await cexData.prefetchGateKlines(sym, ['15m', '1h'], 100);
    await cexData.prefetchGateKlines(sym, ['5m'], 50);
  }

  // 首次立即评估
  await evaluateStrategy();

  // 定时评估（每5分钟信号判断）
  strategyTimer = setInterval(async () => {
    await evaluateStrategy();
  }, EVALUATE_INTERVAL_MS);

  // 定期检查持仓（间隔可调，默认30秒）
  checkTimer = setInterval(async () => {
    await checkPositions();
  }, trailIntervalMs);

  console.log(`[Strategy] 🎯 策略引擎已启动 (${symbols.join(', ')})`);
  return { success: true, symbols: activeSymbols };
}

/**
 * 停止策略引擎
 */
export function stopStrategy() {
  isRunning = false;
  if (strategyTimer) {
    clearInterval(strategyTimer);
    strategyTimer = null;
  }
  cexData.stopDataStream();

  // 清理订阅
  for (const fn of unsubscribeFns) {
    try { fn(); } catch {}
  }
  unsubscribeFns = [];

  console.log('[Strategy] 🛑 策略引擎已停止');
  return { success: true };
}


/**
 * 设置追踪止盈检查间隔（毫秒）
 */
export function setTrailInterval(ms) {
  const newMs = Math.max(1000, Math.min(120000, parseInt(ms) || 30000));
  trailIntervalMs = newMs;
  // 如果策略正在运行，重启检查定时器
  if (isRunning && checkTimer) {
    clearInterval(checkTimer);
    checkTimer = setInterval(async () => {
      await checkPositions();
    }, trailIntervalMs);
    console.log(`[Strategy] ⏱ 追踪间隔改为 ${trailIntervalMs / 1000}s`);
  }
  return { success: true, intervalMs: trailIntervalMs };
}

export function getTrailInterval() {
  return { intervalMs: trailIntervalMs, intervalSec: trailIntervalMs / 1000 };
}

/**
 * 获取策略状态
 */
export function getStrategyStatus() {
  return {
    running: isRunning,
    activeSymbols,
    currentSignals,
    historyCount: positionHistory.length,
    recentHistory: positionHistory.slice(-10),
    dataStatus: cexData.getDataStatus(),
  };
}

/**
 * 获取当前信号的摘要
 */
export function getSignalsSummary() {
  const summary = {};
  for (const [sym, sig] of Object.entries(currentSignals)) {
    summary[sym] = {
      timestamp: new Date(sig.timestamp).toLocaleTimeString(),
      trend: `${sig.trend.direction} (${sig.trend.confidence})`,
      meanRev: `${sig.meanReversion.direction} (${sig.meanReversion.confidence})`,
      combined: `${sig.combined.direction} (${sig.combined.confidence})`,
      action: sig.combined.action,
      hasPosition: sig.hasPosition,
    };
  }
  return summary;
}

/** * 获取追踪止盈状态（供前端展示） */export function getTrailingState() {  const result = {};  for (const [sym, state] of Object.entries(trailingState)) {    result[sym] = {      slPrice: state.slPrice,      tpPrice: state.tpPrice,      trailActivated: state.trailActivated,      trailActivatePercent: state.trailActivatePercent,      trailStepPercent: state.trailStepPercent,      bestStop: state.bestStop,      marketRegime: state.marketRegime,      atrPercent: state.atrPercent,      lastUpdated: state.lastUpdated,    };  }  return result;}
console.log('[Strategy] 🧠 策略引擎已加载');