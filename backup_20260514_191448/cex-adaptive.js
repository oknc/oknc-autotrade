/**
 * cex-adaptive.js — 自适应进化引擎 (v1)
 *
 * 功能：
 * 1. MarketRegimeDetector — ADX + 波动率识别市场状态
 * 2. AdaptiveSizer — 基于绩效的仓位管理
 * 3. AdaptiveStops — ATR 动态止盈止损
 * 4. StrategyWeighter — 趋势/均值回归权重分配
 * 5. TradeJournal — 交易记录与绩效分析
 */

// ============ 市场状态检测 ============

export function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return { adx: 25, plusDI: 20, minusDI: 20 };
  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < highs.length; i++) {
    const h = highs[i] - highs[i - 1];
    const l = lows[i - 1] - lows[i];
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    plusDM.push(h > l && h > 0 ? h : 0);
    minusDM.push(l > h && l > 0 ? l : 0);
  }

  const atr = calcEMA(tr, period);
  const avgPlus = calcEMA(plusDM, period);
  const avgMinus = calcEMA(minusDM, period);
  if (!atr || atr === 0) return { adx: 25, plusDI: 20, minusDI: 20 };

  const plusDI = (avgPlus / atr) * 100;
  const minusDI = (avgMinus / atr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  const dxValues = [];
  for (let i = 0; i < tr.length; i++) {
    const pDI = i < tr.length - period ? 20 : plusDI;
    const mDI = i < tr.length - period ? 20 : minusDI;
    dxValues.push(Math.abs(pDI - mDI) / (pDI + mDI) * 100 || 0);
  }
  const adx = calcEMA(dxValues, period) || 25;
  return { adx, plusDI, minusDI };
}

function calcEMA(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return { atr: 0, atrPercent: 1 };
  const tr = [];
  for (let i = 1; i < Math.min(highs.length, 50); i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atr = calcEMA(tr, period) || tr.reduce((a, b) => a + b, 0) / tr.length;
  const avgPrice = closes.slice(-10).reduce((a, b) => a + b, 0) / Math.min(closes.length, 10);
  return { atr, atrPercent: avgPrice > 0 ? (atr / avgPrice) * 100 : 1 };
}

export function detectMarketRegime(highs, lows, closes) {
  const { adx, plusDI, minusDI } = calcADX(highs, lows, closes);
  const { atrPercent } = calcATR(highs, lows, closes);
  if (atrPercent > 3) return 'volatile';
  if (adx > 30) return 'trending';
  if (adx < 15) return 'ranging';
  return 'transitioning';
}

export function getSignalWeights(highs, lows, closes) {
  const regime = detectMarketRegime(highs, lows, closes);
  switch (regime) {
    case 'trending': return { trendWeight: 0.9, meanRevWeight: 0.1, regime };
    case 'ranging': return { trendWeight: 0.3, meanRevWeight: 0.7, regime };
    case 'volatile': return { trendWeight: 0.5, meanRevWeight: 0.5, regime };
    default: return { trendWeight: 0.6, meanRevWeight: 0.4, regime };
  }
}

// ============ 自适应仓位管理 ============

let tradeHistory = [];

export function recordTrade(trade) {
  tradeHistory.push({
    timestamp: trade.timestamp || Date.now(),
    symbol: trade.symbol,
    side: trade.side,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    contracts: trade.contracts,
    pnl: trade.pnl || 0,
    pnlPercent: trade.pnlPercent || 0,
    reason: trade.reason || '',
    style: trade.style || '',
    marketRegime: trade.marketRegime || '',
    confidence: trade.confidence || 0,
    duration: trade.duration || 0,
  });
  if (tradeHistory.length > 200) tradeHistory = tradeHistory.slice(-200);
}

export function getTradeStats(window = 20) {
  const recent = tradeHistory.slice(-window);
  if (recent.length === 0) {
    return { winRate: 0.5, avgWin: 0, avgLoss: 0, profitFactor: 1, tradeCount: 0, streak: 0, totalPnl: 0 };
  }
  const wins = recent.filter(t => t.pnl > 0);
  const losses = recent.filter(t => t.pnl <= 0);
  const winRate = wins.length / recent.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length || 1)) : 1;
  let streak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].pnl > 0 && streak >= 0) streak++;
    else if (recent[i].pnl <= 0 && streak <= 0) streak--;
    else break;
  }
  return { winRate, avgWin, avgLoss, profitFactor, tradeCount: recent.length, streak, totalPnl: recent.reduce((s, t) => s + t.pnl, 0) };
}

export function kellyPositionSize(stats) {
  if (stats.tradeCount < 3) return { fraction: 0.15, reason: '数据不足，保守仓位' };
  const avgLossAbs = Math.abs(stats.avgLoss);
  if (avgLossAbs === 0) return { fraction: 0.3, reason: '零亏损，用30%' };
  const b = stats.avgWin / avgLossAbs;
  const kelly = (b * stats.winRate - (1 - stats.winRate)) / b;
  const fraction = Math.max(0.02, Math.min(0.4, kelly)) * 0.5;
  return { fraction, reason: `凯利${kelly.toFixed(2)}→半凯利${fraction.toFixed(3)}` };
}

export function streakAdjustment(baseFraction, streak) {
  if (streak >= 3) {
    const bonus = Math.min(streak * 0.02, 0.15);
    return { fraction: baseFraction + bonus, reason: `连胜${streak}，加仓${(bonus*100).toFixed(0)}%` };
  } else if (streak <= -2) {
    const reduction = Math.min(Math.abs(streak) * 0.04, 0.5);
    return { fraction: baseFraction * (1 - reduction), reason: `连败${Math.abs(streak)}，降仓${(reduction*100).toFixed(0)}%` };
  }
  return { fraction: baseFraction, reason: '正常' };
}

export function calculateAdaptivePosition(totalBalance, price, leverage, contracts, stats, marketRegime, positionPercent = 30) {
  const { fraction: kellyFrac } = kellyPositionSize(stats);
  const { fraction, reason } = streakAdjustment(kellyFrac, stats.streak);
  let regimeAdj = 1;
  if (marketRegime === 'volatile') regimeAdj = 0.6;
  else if (marketRegime === 'trending') regimeAdj = 1.2;
  else if (marketRegime === 'ranging') regimeAdj = 0.8;
  // positionPercent 作为硬上限（风格参数生效）
  const maxFraction = Math.min(positionPercent / 100, 0.4);
  const finalFraction = Math.min(fraction * regimeAdj, maxFraction);
  const positionValue = totalBalance * leverage * finalFraction;
  const contractQty = Math.max(contracts, parseFloat((positionValue / price).toFixed(6)));
  return { fraction: finalFraction, contracts: contractQty, reason: `凯利${(kellyFrac*100).toFixed(1)}%→${(fraction*100).toFixed(1)}%(${reason})→${marketRegime}调整${regimeAdj.toFixed(1)}x→上限${positionPercent}%`, positionValue };
}

// ============ ATR 动态止盈止损 ============

export function calculateAdaptiveStops(entryPrice, currentPrice, side, atr, atrPercent, styleConfig) {
  const isLong = side === 'long';
  const baseMultiplier = styleConfig.stopLossPercent / 3 || 1;
  let atrMultiplier;
  if (atrPercent > 3) atrMultiplier = baseMultiplier * 1.5;
  else if (atrPercent > 1.5) atrMultiplier = baseMultiplier;
  else atrMultiplier = Math.max(baseMultiplier * 0.8, 2.5);  // 低波动时不低于2.5x
  const atrStop = atr * atrMultiplier;
  const slPrice = isLong
    ? Math.max(currentPrice - atrStop, entryPrice * 0.9)
    : Math.min(currentPrice + atrStop, entryPrice * 1.1);
  const riskReward = styleConfig.takeProfitPercent / styleConfig.stopLossPercent || 2;
  const tpDistance = atrStop * riskReward;
  const tpPrice = isLong ? currentPrice + tpDistance : currentPrice - tpDistance;
  const trailActivate = styleConfig.trailActivatePercent * (1 + (atrPercent - 1) * 0.2);
  const trailStep = styleConfig.trailStepPercent * (1 + (atrPercent - 1) * 0.1);
  return {
    slPrice: parseFloat(slPrice.toFixed(2)),
    tpPrice: parseFloat(tpPrice.toFixed(2)),
    trailActivatePercent: parseFloat(trailActivate.toFixed(1)),
    trailStepPercent: parseFloat(trailStep.toFixed(1)),
    atrMultiplier, riskReward,
  };
}

/**
 * 动态杠杆计算 — 根据波动率和市场状态自适应调整
 * @param {number} baseLeverage - 风格预设杠杆
 * @param {number} atrPercent - ATR百分比
 * @param {string} marketRegime - 市场状态
 * @returns {number} 调整后的杠杆倍数
 */
export function calculateDynamicLeverage(baseLeverage, atrPercent, marketRegime) {
  let adj = 1;
  if (marketRegime === 'volatile') adj = 0.6;
  else if (marketRegime === 'trending') adj = 1.3;
  else if (marketRegime === 'ranging') adj = 0.8;
  if (atrPercent > 3) adj *= 0.7;
  else if (atrPercent > 2) adj *= 0.85;
  else if (atrPercent < 0.5) adj *= 1.2;
  return Math.max(1, Math.round(baseLeverage * adj));
}

export function getAdaptiveStatus() {
  const stats = getTradeStats();
  return { tradeHistoryCount: tradeHistory.length, stats };
}

export function resetTradeHistory() { tradeHistory = []; }

// ============ 夏普比率追踪 ============

// 每个币种的PnL序列，用于计算夏普比率
// { 'BTC/USDT:USDT': [0.5, -0.3, 1.2, ...] } — 每笔平仓的真实PnL百分比
let symbolReturns = {};

/**
 * 记录一笔平仓的收益率
 * @param {string} symbol 
 * @param {number} pnlPercent — 百分比形式（如 1.5 表示 +1.5%）
 */
export function recordReturn(symbol, pnlPercent) {
  if (!symbolReturns[symbol]) symbolReturns[symbol] = [];
  symbolReturns[symbol].push(pnlPercent);
  // 只保留最近50笔
  if (symbolReturns[symbol].length > 50) {
    symbolReturns[symbol].shift();
  }
}

/**
 * 计算某个币种的夏普比率
 * 夏普 = (平均收益率 - 无风险利率) / 收益率标准差
 * 无风险利率约等于 0（加密货币市场）
 * @param {string} symbol 
 * @param {number} [annualScale=365] — 按日换算年化（默认365天）
 * @returns {{ sharpe: number, avgReturn: number, stdDev: number, count: number }}
 */
export function calcSharpeRatio(symbol, annualScale = 365) {
  const returns = symbolReturns[symbol];
  if (!returns || returns.length < 3) {
    return { sharpe: 0, avgReturn: 0, stdDev: 0, count: returns?.length || 0, reason: '数据不足(<3笔)' };
  }
  
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return { sharpe: 0, avgReturn, stdDev, count: returns.length, reason: '零波动' };
  
  // 日频夏普，然后年化
  const dailySharpe = avgReturn / stdDev;
  const sharpe = dailySharpe * Math.sqrt(annualScale);
  
  return {
    sharpe: parseFloat(sharpe.toFixed(2)),
    avgReturn: parseFloat(avgReturn.toFixed(2)),
    stdDev: parseFloat(stdDev.toFixed(2)),
    count: returns.length,
    reason: sharpe > 1 ? '优秀' : sharpe > 0.5 ? '良好' : sharpe > 0 ? '一般' : '需优化',
  };
}

/**
 * 获取所有币种的夏普比率
 * @returns {Object} { 'BTC/USDT:USDT': { sharpe, ... }, ... }
 */
export function getAllSharpeRatios() {
  const result = {};
  for (const sym of Object.keys(symbolReturns)) {
    result[sym] = calcSharpeRatio(sym);
  }
  return result;
}

/**
 * 根据夏普比率判断是否继续交易该币种
 * @param {string} symbol 
 * @param {number} [minSharpe=-0.5] — 低于此值建议暂停交易
 * @returns {{ canTrade: boolean, sharpe: number, reason: string }}
 */
export function shouldTradeSymbol(symbol, minSharpe = -0.5) {
  const stats = calcSharpeRatio(symbol);
  if (stats.count < 3) return { canTrade: true, sharpe: stats.sharpe, reason: '数据不足，允许交易' };
  if (stats.sharpe < minSharpe) {
    return { canTrade: false, sharpe: stats.sharpe, reason: `夏普${stats.sharpe}<${minSharpe}，建议暂停` };
  }
  return { canTrade: true, sharpe: stats.sharpe, reason: stats.reason };
}

export function getSymbolReturns() { return symbolReturns; }
export function resetSymbolReturns() { symbolReturns = {}; }