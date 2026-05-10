/**
 * risk-manager.js — 合约风控引擎 (v2.1)
 *
 * 集中管理所有风控规则，给策略引擎提供决策校验
 * 日亏损限额（仅计算合约实际平仓PnL，不含土狗/转账导致的余额变动）
 * 仓位上限 · 追踪止盈 · 熔断 · 日期自动切换
 */
import * as cexEngine from './cex-engine.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RISK_FILE = path.join(__dirname, 'data', 'risk-daily.json');

// ============ 日亏损追踪 ============
let dailyStats = {
  date: null,           // YYYY-MM-DD
  startBalance: 0,      // 日期初余额（仅参考）
  currentBalance: 0,    // 当前余额（仅参考）
  realizedPnl: 0,       // 累计实际平仓PnL（合约交易真实盈亏）
  dailyPnl: 0,          // 日盈亏 $ = realizedPnl
  dailyPnlPercent: 0,   // 日盈亏 % = realizedPnl / startBalance
  tradeCount: 0,        // 日交易笔数
  maxDrawdown: 0,       // 最大回撤 %
  peakBalance: 0,       // 日最高余额
  isFrozen: false,       // 是否熔断
  frozenReason: '',      // 熔断原因
  positionsClosed: 0,    // 日内平仓数
  wins: 0,              // 盈利笔数（全部交易所合计）
  losses: 0,            // 亏损笔数（全部交易所合计）
  exchangeStats: {},     // 按交易所统计: { binance: {wins:0, losses:0}, gate: {...}, okx: {...} }
};

// 熔断状态（持久化到内存）
let circuitBreakerActive = false;
let circuitBreakerReason = '';
let circuitBreakerUntil = 0; // timestamp

// ============ 持久化 ============
function ensureDataDir() {
  const dir = path.dirname(RISK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadDailyStats() {
  ensureDataDir();
  if (fs.existsSync(RISK_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(RISK_FILE, 'utf-8'));
      if (saved.date === getTodayStr()) {
        dailyStats = { ...dailyStats, ...saved };
        // 兼容旧数据：旧文件没有 realizedPnl，用旧 dailyPnl 回填
        if (dailyStats.realizedPnl === 0 && dailyStats.positionsClosed > 0) {
          dailyStats.realizedPnl = dailyStats.dailyPnl;
        }
        // 以 realizedPnl 为准重新计算日盈亏
        recalcDailyPnl();
      }
    } catch {}
  }
}

function saveDailyStats() {
  ensureDataDir();
  fs.writeFileSync(RISK_FILE, JSON.stringify(dailyStats, null, 2));
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 从实际 realizedPnl 重新计算日盈亏
 * 不依赖余额变化——转账/土狗亏损不会影响合约风控
 */
function recalcDailyPnl() {
  dailyStats.dailyPnl = dailyStats.realizedPnl;
  dailyStats.dailyPnlPercent = dailyStats.startBalance > 0
    ? (dailyStats.realizedPnl / dailyStats.startBalance) * 100
    : 0;
}

// ============ 初始化 ============
export async function initRiskManager() {
  loadDailyStats();

  if (dailyStats.date !== getTodayStr()) {
    await resetDaily();
  }

  // 获取初始余额
  try {
    const bal = await cexEngine.getBalance();
    if (bal.success && !dailyStats.startBalance) {
      dailyStats.startBalance = bal.total;
      dailyStats.peakBalance = bal.total;
      dailyStats.currentBalance = bal.total;
    }
  } catch {}

  saveDailyStats();
  console.log('[Risk] 🛡️ 风控引擎已初始化');
  return getStatus();
}

async function resetDaily() {
  const bal = await cexEngine.getBalance();
  dailyStats = {
    date: getTodayStr(),
    startBalance: bal.success ? bal.total : dailyStats.currentBalance || 30,
    currentBalance: bal.success ? bal.total : dailyStats.currentBalance || 30,
    realizedPnl: 0,
    dailyPnl: 0,
    dailyPnlPercent: 0,
    tradeCount: 0,
    maxDrawdown: 0,
    peakBalance: bal.success ? bal.total : dailyStats.peakBalance || 30,
    isFrozen: false,
    frozenReason: '',
    positionsClosed: 0,
    wins: 0,
    losses: 0,
    exchangeStats: {},
  };
  circuitBreakerActive = false;
  circuitBreakerReason = '';
  circuitBreakerUntil = 0;
  saveDailyStats();
}

// ============ 核心风控检查 ============

export async function canOpenPosition(symbol, side, margin) {
  // 1. 熔断检查
  if (circuitBreakerActive) {
    if (Date.now() < circuitBreakerUntil) {
      return { allowed: false, reason: `熔断中: ${circuitBreakerReason}` };
    }
    circuitBreakerActive = false;
  }

  // 2. 日亏损熔断（基于实际合约平仓PnL）
  if (dailyStats.isFrozen) {
    return { allowed: false, reason: `日亏损限额触发: ${dailyStats.frozenReason}` };
  }

  // 3. 更新余额（仅用于保证金检查，不影响日亏损计算）
  await updateBalance();

  // 4. 日亏损百分比检查（基于 realizedPnl）
  const style = cexEngine.getCurrentStyle();
  const styleCfg = style.config;
  const maxDailyLossPct = styleCfg.maxDailyLossPercent || 10;

  if (dailyStats.dailyPnlPercent <= -maxDailyLossPct) {
    dailyStats.isFrozen = true;
    dailyStats.frozenReason = `合约日亏损达${dailyStats.dailyPnlPercent.toFixed(1)}% > ${maxDailyLossPct}%限额`;
    saveDailyStats();
    return { allowed: false, reason: dailyStats.frozenReason };
  }

  // 5. 最大持仓数检查
  try {
    const posResult = await cexEngine.getPositions();
    if (posResult.success) {
      const activeCount = posResult.positions.length;
      if (activeCount >= styleCfg.maxPositions) {
        return { allowed: false, reason: `已达最大持仓数 ${styleCfg.maxPositions}` };
      }
    }
  } catch {}

  // 6. 保证金是否充足
  if (dailyStats.currentBalance < margin * 3) {
    return { allowed: false, reason: `保证金不足: 需${margin.toFixed(2)}U, 余额${dailyStats.currentBalance.toFixed(2)}U` };
  }

  return { allowed: true, reason: 'ok' };
}

/**
 * 记录开仓事件
 */
export async function onPositionOpened(symbol, side, margin) {
  dailyStats.tradeCount++;
  saveDailyStats();
  console.log(`[Risk] 📝 开仓记录: ${symbol} ${side} $${margin.toFixed(2)}`);
}

/**
 * 记录平仓事件（含盈亏）
 * 累加 realizedPnl，以此计算日亏损——土狗亏损/转账不影响合约风控
 */
export async function onPositionClosed(symbol, side, realizedPnl, pnlPercent, exchangeId) {
  dailyStats.positionsClosed++;
  dailyStats.realizedPnl += realizedPnl;
  recalcDailyPnl();

  if (realizedPnl >= 0) {
    dailyStats.wins++;
  } else {
    dailyStats.losses++;
  }

  // 按交易所统计
  if (exchangeId) {
    if (!dailyStats.exchangeStats[exchangeId]) {
      dailyStats.exchangeStats[exchangeId] = { wins: 0, losses: 0 };
    }
    if (realizedPnl >= 0) {
      dailyStats.exchangeStats[exchangeId].wins++;
    } else {
      dailyStats.exchangeStats[exchangeId].losses++;
    }
  }

  await updateBalance();
  saveDailyStats();
  console.log(`[Risk] 📝 平仓记录: ${symbol} ${side} PnL:${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)} | 累计日盈亏: $${dailyStats.realizedPnl.toFixed(4)}`);
}

/**
 * 更新余额和最大回撤
 * 注意：余额仅用于保证金检查，不用于日亏损计算
 */
async function updateBalance() {
  try {
    const bal = await cexEngine.getBalance();
    if (bal.success) {
      dailyStats.currentBalance = bal.total;

      if (bal.total > dailyStats.peakBalance) {
        dailyStats.peakBalance = bal.total;
      }

      const drawdown = dailyStats.peakBalance > 0
        ? ((dailyStats.peakBalance - bal.total) / dailyStats.peakBalance) * 100
        : 0;
      if (drawdown > dailyStats.maxDrawdown) {
        dailyStats.maxDrawdown = drawdown;
      }
    }
  } catch {}
}

// ============ 熔断机制 ============

export function triggerCircuitBreaker(reason, cooldownMs = 15 * 60 * 1000, closeAll = true) {
  circuitBreakerActive = true;
  circuitBreakerReason = reason;
  circuitBreakerUntil = Date.now() + cooldownMs;
  console.log(`[Risk] 🚨 熔断触发: ${reason} (${cooldownMs / 60000}分钟)`);

  if (closeAll) {
    closeAllPositions().then(r => {
      console.log(`[Risk] 🔗 熔断联动平仓完成: ${r.closed}个仓位`);
    }).catch(e => {
      console.error(`[Risk] 🔗 熔断联动平仓异常: ${e.message}`);
    });
  }

  return { circuitBreakerActive, reason, until: new Date(circuitBreakerUntil).toISOString() };
}

export function resetCircuitBreaker() {
  circuitBreakerActive = false;
  circuitBreakerReason = '';
  circuitBreakerUntil = 0;
  dailyStats.isFrozen = false;
  dailyStats.frozenReason = '';
  saveDailyStats();
  console.log('[Risk] ✅ 熔断已手动解除');
}

export function checkLiquidationRisk(position) {
  if (!position || !position.liquidationPrice || !position.markPrice) {
    return { safe: true, distancePercent: 999 };
  }

  const distance = Math.abs(position.markPrice - position.liquidationPrice);
  const distancePercent = position.markPrice > 0
    ? (distance / position.markPrice) * 100
    : 999;

  if (distancePercent < 8) {
    return { safe: false, distancePercent, level: distancePercent < 3 ? 'critical' : distancePercent < 5 ? 'danger' : 'warning' };
  }

  return { safe: true, distancePercent };
}

export async function autoReducePosition(position, percent = 50) {
  if (!position || !position.symbol || !position.side || !position.contracts || Math.abs(position.contracts) <= 0) {
    return { success: false, error: '无效持仓' };
  }
  const contracts = Math.abs(position.contracts);
  const closeQty = contracts * (percent / 100);
  console.log(`[Risk] ✂️ 自动减仓: ${position.symbol} ${position.side} ${closeQty.toFixed(4)} (${percent}%)`);
  const result = await cexEngine.closePosition(position.symbol, position.side, 'binance', { percent });
  if (result.success) {
    console.log(`[Risk] ✅ 减仓成功: ${position.symbol} 剩余 ${(contracts - closeQty).toFixed(4)}`);
  } else {
    console.log(`[Risk] ❌ 减仓失败: ${result.error}`);
  }
  return result;
}

export async function closeAllPositions() {
  try {
    const posResult = await cexEngine.getPositions('binance');
    if (!posResult.success || !posResult.positions || posResult.positions.length === 0) {
      console.log('[Risk] ℹ️ 无持仓需平仓');
      return { success: true, closed: 0 };
    }
    const results = [];
    for (const pos of posResult.positions) {
      console.log(`[Risk] 🛑 联动平仓: ${pos.symbol} ${pos.side} ${Math.abs(pos.contracts).toFixed(4)}张`);
      const r = await cexEngine.closePosition(pos.symbol, pos.side, 'binance', { percent: 100 });
      results.push({ symbol: pos.symbol, side: pos.side, result: r });
      if (!r.success) {
        console.log(`[Risk] ❌ 联动平仓失败 ${pos.symbol}: ${r.error}`);
      } else {
        console.log(`[Risk] ✅ 联动平仓成功 ${pos.symbol} PnL:${r.realizedPnl?.toFixed(4)||'?'}`);
      }
    }
    return { success: true, closed: results.length, results };
  } catch (err) {
    console.error(`[Risk] ❌ 联动平仓异常: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * 定期风控检查
 * 日亏损检测基于 realizedPnl（合约实际平仓盈亏），不受土狗亏损/转账影响
 */
export async function riskCheck() {
  try {
    // 检测日期切换
    if (dailyStats.date !== getTodayStr()) {
      console.log(`[Risk] 📅 检测到日期切换: ${dailyStats.date} → ${getTodayStr()}，重置日统计数据`);
      await resetDaily();
      await updateBalance();
      return;
    }

    // 更新余额（仅用于保证金检查）
    await updateBalance();

    // 检查所有持仓的清算风险
    const posResult = await cexEngine.getPositions();
    if (posResult.success) {
      for (const pos of posResult.positions) {
        const risk = checkLiquidationRisk(pos);
        if (!risk.safe) {
          console.log(`[Risk] ⚠️ ${pos.symbol} 强平距离仅 ${risk.distancePercent.toFixed(1)}% (${risk.level})`);

          if (risk.level === 'critical') {
            console.log(`[Risk] 🔴 ${pos.symbol}: 清算临界! 全平+熔断`);
            await autoReducePosition(pos, 100);
            triggerCircuitBreaker(`${pos.symbol} 强平距离 ${risk.distancePercent.toFixed(1)}%`);
          } else if (risk.level === 'danger') {
            console.log(`[Risk] 🟠 ${pos.symbol}: 清算风险! 全平`);
            await autoReducePosition(pos, 100);
          } else if (risk.level === 'warning') {
            console.log(`[Risk] 🟡 ${pos.symbol}: 减半仓预警`);
            await autoReducePosition(pos, 50);
          }
        }
      }
    }

    // 检查日亏损（基于 realizedPnl，非余额变动）
    const style = cexEngine.getCurrentStyle();
    const maxLossPct = style.config.maxDailyLossPercent || 10;
    if (dailyStats.dailyPnlPercent <= -maxLossPct && !dailyStats.isFrozen) {
      dailyStats.isFrozen = true;
      dailyStats.frozenReason = `合约日亏损 ${dailyStats.dailyPnlPercent.toFixed(1)}% 超限`;
      saveDailyStats();
      console.log(`[Risk] 🚨 日亏损熔断: ${dailyStats.frozenReason}`);
    }

  } catch (err) {
    console.error(`[Risk] ⚠️ 风控检查异常: ${err.message}`);
  }
}

// ============ 状态查询 ============

export function getStatus(exchangeId) {
  // 按交易所筛选
  let wins = dailyStats.wins, losses = dailyStats.losses;
  if (exchangeId && dailyStats.exchangeStats[exchangeId]) {
    wins = dailyStats.exchangeStats[exchangeId].wins;
    losses = dailyStats.exchangeStats[exchangeId].losses;
  } else if (exchangeId) {
    wins = 0; losses = 0;
  }
  const totalClosed = wins + losses;
  return {
    date: dailyStats.date,
    startBalance: dailyStats.startBalance,
    currentBalance: dailyStats.currentBalance,
    realizedPnl: dailyStats.realizedPnl,
    dailyPnl: dailyStats.dailyPnl,
    dailyPnlPercent: dailyStats.dailyPnlPercent,
    peakBalance: dailyStats.peakBalance,
    maxDrawdown: dailyStats.maxDrawdown,
    tradeCount: dailyStats.tradeCount,
    wins: wins,
    losses: losses,
    winRate: totalClosed > 0
      ? ((wins / totalClosed) * 100).toFixed(1) + '%'
      : '0%',
    isFrozen: dailyStats.isFrozen,
    frozenReason: dailyStats.frozenReason,
    circuitBreaker: {
      active: circuitBreakerActive,
      reason: circuitBreakerReason,
      until: circuitBreakerUntil ? new Date(circuitBreakerUntil).toISOString() : null,
    },
    currentStyle: cexEngine.getCurrentStyle(),
  };
}

export async function getRiskStatus() {
  await updateBalance();
  return {
    canTrade: !circuitBreakerActive && !dailyStats.isFrozen,
    dailyPnlPercent: dailyStats.dailyPnlPercent,
    dailyPnl: dailyStats.dailyPnl,
    realizedPnl: dailyStats.realizedPnl,
    circuitBreakerActive,
    isFrozen: dailyStats.isFrozen,
  };
}

// ============ 初始化 ============
console.log('[Risk] 🛡️ 风控引擎已加载 (v2.1 — 日亏损仅含合约实际PnL)');
