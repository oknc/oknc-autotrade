/**
 * strategy.js — 策略引擎 + 持仓管理 + 止盈止损 (v3)
 *
 * v3 新增：
 * - 链上仿真交易检测（蜜罐/高税费）
 * - 动态买入金额（评分越高买入越多）
 * - 分批建仓（高分币分 2-3 次买入）
 * - 预购深度验证（价格偏离 + 流动性校验）
 */

import { initEngine, getTargetToken, setTargetToken, getBalances,
         executeBuy, executeSell, executeClear, reinitEngine, getTokenPrice,
         simulateBuy, simulateSell, checkTokenTax } from './engine.js';
import { getActivePrivateKey, hasWallets } from './wallet-manager.js';
import { fetchLatestPair } from './screener.js';
import { runDeepCheck } from './screener-deep.js';
import { deepSecurityCheck } from './bscscan.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIONS_FILE = path.join(__dirname, 'data', 'positions.json');
const DECISIONS_FILE = path.join(__dirname, 'data', 'decisions.json');

// ============ 配置 ============
const LOSS_CUT_PERCENT = parseFloat(process.env.LOSS_CUT_PERCENT || '-25');
const TAKE_PROFIT_PERCENT = parseFloat(process.env.TAKE_PROFIT_PERCENT || '100');
const TRAILING_STOP_PERCENT = parseFloat(process.env.TRAILING_STOP_PERCENT || '15');
const BUY_MIN_BNB = parseFloat(process.env.BUY_MIN_BNB || '0.002');
const BUY_MAX_BNB = parseFloat(process.env.BUY_MAX_BNB || '0.005');
const SELL_MIN_PERCENT = parseFloat(process.env.SELL_MIN_PERCENT || '25');
const SELL_MAX_PERCENT = parseFloat(process.env.SELL_MAX_PERCENT || '50');
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '5', 10);
const MIN_SCORE = parseFloat(process.env.MIN_SCORE || '50');
const PRICE_DIVERGENCE_LIMIT = parseFloat(process.env.PRICE_DIVERGENCE_LIMIT || '0.20');

// === v3 新增 ===
const BUY_ENABLE_SIMULATION = (process.env.BUY_ENABLE_SIMULATION || 'true') === 'true';
const BUY_MAX_TAX_ALLOWED = parseFloat(process.env.BUY_MAX_TAX_ALLOWED || '15');
const SELL_MAX_TAX_ALLOWED = parseFloat(process.env.SELL_MAX_TAX_ALLOWED || '15');
const SELL_ENABLE_SIMULATION = (process.env.SELL_ENABLE_SIMULATION || 'true') === 'true'; // 允许的最大买税(%)
const BATCH_BUY_ENABLED = (process.env.BATCH_BUY_ENABLED || 'true') === 'true';
const BATCH_BUY_MIN_SCORE = parseFloat(process.env.BATCH_BUY_MIN_SCORE || '75'); // 分批买入最低评分
const BATCH_BUY_SPLIT = parseInt(process.env.BATCH_BUY_SPLIT || '2', 10);        // 分批次数
const BATCH_BUY_INTERVAL_MS = parseInt(process.env.BATCH_BUY_INTERVAL_MS || '10000', 10); // 分批间隔(ms)
const BSCSCAN_DEEP_CHECK = (process.env.BSCSCAN_DEEP_CHECK || 'true') === 'true';
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '10000', 10);

// ============ 评分分级策略 ============
function getScoreStrategy(score) {
  if (score >= 80) {
    return {
      buyAmount: Math.min(BUY_MAX_BNB, 0.005),
      stopLoss: -20,
      takeProfit: 150,
      trailingStop: 12,
      batchSplit: 2,
    };
  } else if (score >= 65) {
    return {
      buyAmount: Math.min(BUY_MAX_BNB, 0.003),
      stopLoss: -20,
      takeProfit: 80,
      trailingStop: 12,
      batchSplit: 2,
    };
  } else {
    return {
      buyAmount: Math.min(BUY_MAX_BNB, 0.002),
      stopLoss: -18,
      takeProfit: 60,
      trailingStop: 10,
      batchSplit: 1,
    };
  }
}

// ============ 状态 ============
let positions = [];
let decisions = [];
let isMonitoring = false;
let monitorTimerId = null;
let strategyRunning = false;
let buyQueue = [];
let monitorIntervalMs = MONITOR_INTERVAL_MS;
let heldTokens = [];
let lastSellTime = 0;        // 上次卖出时间戳（冷却用）
const SELL_COOLDOWN_MS = 5 * 60 * 1000;  // 卖出冷却5分钟
let pendingDelayedBuys = {};  // 高分延迟建仓队列

// === 风控计数器 ===
const MAX_SELL_FAILURES = 3;  // 同一持仓连续卖出失败上限
let dailyLossBNB = 0;        // 当日累计亏损 BNB
const MAX_DAILY_LOSS_BNB = parseFloat(process.env.MAX_DAILY_LOSS_BNB || '0.02'); // 单日最大亏损

let onPositionChange = null;
export function setOnPositionChange(callback) { onPositionChange = callback; }

// ============ 预购深度验证 ============

async function deepValidateCandidate(candidate) {
  try {
    const latest = await fetchLatestPair(candidate.tokenAddress);
    if (!latest) return { pass: true, reason: '无法验证，允许通过' };

    const newPrice = parseFloat(latest.priceUsd || 0);
    const newLiq = parseFloat(latest.liquidity?.usd || 0);
    const newVol = parseFloat(latest.volume?.h24 || 0);

    if (candidate.priceUSD > 0 && newPrice > 0) {
      const divergence = Math.abs(newPrice - candidate.priceUSD) / candidate.priceUSD;
      if (divergence > PRICE_DIVERGENCE_LIMIT) {
        return { pass: false, reason: `价格偏离 ${(divergence * 100).toFixed(0)}% > ${PRICE_DIVERGENCE_LIMIT * 100}%` };
      }
    }

    const minLiq = parseFloat(process.env.MIN_LIQUIDITY_USD || '5000');
    if (newLiq < minLiq * 0.8) {
      return { pass: false, reason: `流动性不足 $${newLiq.toFixed(0)}` };
    }

    return { pass: true, reason: '深度验证通过', updatedCandidate: { ...candidate, priceUSD: newPrice, liquidityUSD: newLiq, volume24h: newVol } };
  } catch (err) {
    console.warn(`[Strategy] 深度验证异常: ${err.message}`);
    return { pass: true, reason: '验证异常，允许通过' };
  }
}

// ============ V3: 链上仿真检测（买入+卖出）============

async function simulationCheck(tokenAddress, tokenSymbol) {
  if (!BUY_ENABLE_SIMULATION) return { pass: true, reason: '仿真检测已关闭' };

  try {
    console.log(`[Strategy] 🔬 ${tokenSymbol}: 正在仿真交易 (买入+卖出)...`);
    // === 第一步：买入仿真 ===
    const buyResult = await simulateBuy(tokenAddress, 0.003); // 模拟 0.003 BNB

    if (buyResult.isHoneypot) {
      console.log(`[Strategy] ❌ ${tokenSymbol}: 买入蜜罐检测失败 - ${buyResult.error || `买税 ${buyResult.buyTaxPct?.toFixed(1)}%`}`);
      return { pass: false, reason: `买入蜜罐/高税费 ${buyResult.buyTaxPct?.toFixed(1)}%` };
    }

    if (buyResult.buyTaxPct > BUY_MAX_TAX_ALLOWED) {
      console.log(`[Strategy] ❌ ${tokenSymbol}: 买税 ${buyResult.buyTaxPct.toFixed(1)}% > 允许 ${BUY_MAX_TAX_ALLOWED}%`);
      return { pass: false, reason: `买税过高 ${buyResult.buyTaxPct.toFixed(1)}%` };
    }

    console.log(`[Strategy] ✅ ${tokenSymbol}: 买入仿真通过 (买税: ${buyResult.buyTaxPct?.toFixed(1)}%)`);

    // === 第二步：卖出仿真（检测卖是蜜罐）===
    if (SELL_ENABLE_SIMULATION) {
      console.log(`[Strategy] 🔄 ${tokenSymbol}: 正在仿真卖出...`);
      const sellResult = await simulateSell(tokenAddress, 0.003);

      if (sellResult.isHoneypot) {
        console.log(`[Strategy] ❌ ${tokenSymbol}: 卖出蜜罐检测失败 - ${sellResult.error || `卖税 ${sellResult.sellTaxPct?.toFixed(1)}%`}`);
        return { pass: false, reason: `卖出蜜罐/高税费 ${sellResult.sellTaxPct?.toFixed(1)}%` };
      }

      if (sellResult.sellTaxPct > SELL_MAX_TAX_ALLOWED) {
        console.log(`[Strategy] ❌ ${tokenSymbol}: 卖税 ${sellResult.sellTaxPct.toFixed(1)}% > 允许 ${SELL_MAX_TAX_ALLOWED}%`);
        return { pass: false, reason: `卖税过高 ${sellResult.sellTaxPct.toFixed(1)}%` };
      }

      console.log(`[Strategy] ✅ ${tokenSymbol}: 卖出仿真通过 (卖税: ${sellResult.sellTaxPct?.toFixed(1)}%)`);
    }

    // === 第三步：买入后价格检测 ===
    try {
      const latestPair = await fetchLatestPair(tokenAddress);
      if (latestPair && latestPair.priceUsd && buyResult.buyPriceUSD) {
        const postPrice = parseFloat(latestPair.priceUsd);
        const priceDrop = (buyResult.buyPriceUSD - postPrice) / buyResult.buyPriceUSD * 100;
        if (priceDrop > 15) {
          console.log(`[Strategy] ❌ ${tokenSymbol}: 买入后暴跌 ${priceDrop.toFixed(1)}%`);
          return { pass: false, reason: `买入后暴跌 ${priceDrop.toFixed(1)}%` };
        }
      }
    } catch {}
    return { pass: true, reason: `仿真通过`, buyTaxPct: buyResult.buyTaxPct };
  } catch (err) {
    console.warn(`[Strategy] ⚠️ ${tokenSymbol}: 仿真异常: ${err.message}`);
    return { pass: true, reason: '仿真异常，允许通过' };
  }
}
// ============ V3: 动态买入金额 ============

function calcBuyAmount(score) {
  const strategy = getScoreStrategy(score);
  return strategy.buyAmount;
}

// ============ V3: 分批建仓 ============

async function executeBatchBuy(candidate, totalAmount, tokenSymbol, splits = 1) {
  if (splits <= 1) {
    // 不满足分批条件，一次买入
    await setTargetToken(candidate.tokenAddress);
    return await executeBuy(totalAmount);
  }

  // 分批买入
  splits = Math.min(splits, 3); // 最多分 3 次
  const perAmount = Math.round((totalAmount / splits) * 10000) / 10000;
  let totalResult = { amountOut: 0, txHash: '' };
  let outSum = 0;
  let firstHash = '';

  for (let i = 0; i < splits; i++) {
    try {
      console.log(`[Strategy] 📦 ${tokenSymbol} 分批 ${i + 1}/${splits}: ${perAmount} BNB`);
      await setTargetToken(candidate.tokenAddress);
      const result = await executeBuy(perAmount);
      outSum += parseFloat(result.amountOut || 0);
      if (!firstHash) firstHash = result.txHash || '';
      totalResult = result;

      if (i < splits - 1) {
        await new Promise(r => setTimeout(r, BATCH_BUY_INTERVAL_MS));
      }
    } catch (err) {
      console.error(`[Strategy] ❌ ${tokenSymbol} 分批 ${i + 1}/${splits} 失败: ${err.message}`);
      break;
    }
  }

  return {
    amountOut: outSum,
    txHash: firstHash,
    batchSplits: splits,
    batchCompleted: splits,
    actualPriceUSD: totalResult.actualPriceUSD,
  };
}

// ============ 持仓管理 ============

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf-8'));
  } catch { positions = []; }
}

function savePositions() {
  try {
    const dir = path.dirname(POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
  } catch (err) { console.error(`[Strategy] 持仓保存失败: ${err.message}`); }
}

export function addPosition(entry) {
  const pos = {
    id: `${entry.tokenAddress}_${Date.now()}`,
    tokenAddress: entry.tokenAddress,
    tokenSymbol: entry.tokenSymbol,
    buyAmountBNB: entry.buyAmountBNB,
    buyAmountToken: entry.buyAmountToken,
    buyPriceUSD: entry.buyPriceUSD || 0,
    buyTime: new Date().toISOString(),
    currentPriceUSD: entry.buyPriceUSD || 0,
    pnlPercent: 0,
    highestPriceUSD: entry.buyPriceUSD || 0,
    trailingStopEnabled: true,
    stopLossPercent: entry.stopLossPercent ?? LOSS_CUT_PERCENT,
    takeProfitPercent: entry.takeProfitPercent ?? TAKE_PROFIT_PERCENT,
    trailingStopPercent: entry.trailingStopPercent ?? TRAILING_STOP_PERCENT,
    status: 'active',
    txHash: entry.txHash || '',
    notes: entry.notes || '',
    batchSplits: entry.batchSplits || 1,
  };
  positions.unshift(pos);
  savePositions();
  notifyPositionChange();
  logDecision({ type: 'buy', tokenAddress: entry.tokenAddress, tokenSymbol: entry.tokenSymbol, detail: `买入 ${entry.buyAmountBNB} BNB，获得 ${entry.buyAmountToken} 个代币` });
  return pos;
}

export function updatePositionPrice(positionId, currentPriceUSD, tokenBalance) {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) return;
  pos.currentPriceUSD = currentPriceUSD;
  if (pos.buyPriceUSD > 0) pos.pnlPercent = ((currentPriceUSD - pos.buyPriceUSD) / pos.buyPriceUSD) * 100;
  if (currentPriceUSD > pos.highestPriceUSD) pos.highestPriceUSD = currentPriceUSD;
  if (tokenBalance !== undefined) pos.buyAmountToken = tokenBalance;
}

export async function sellPosition(positionId, percent = 100) {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) throw new Error(`持仓不存在: ${positionId}`);
  if (pos.status !== 'active') throw new Error(`持仓状态不是 active: ${pos.status}`);
  await setTargetToken(pos.tokenAddress);
  try {
    pos.status = 'stopping';
    savePositions();
    notifyPositionChange();
    const sellAmount = pos.buyAmountToken * (percent / 100);
    const balances = await getBalances();
    if (balances.token <= 0) {
      pos.status = 'sold'; pos.notes = '余额已为0'; savePositions(); notifyPositionChange();
      return { type: 'sell', skipped: true, reason: '余额为0' };
    }
    const actualSell = Math.min(sellAmount, balances.token);
    const result = await executeSell(actualSell);
    pos.status = 'sold'; pos.sellTime = new Date().toISOString(); lastSellTime = Date.now();
    pos.sellAmountBNB = result.amountOut;
    // 每日亏损累计
    const loss = pos.buyAmountBNB - (result.amountOut || 0);
    if (loss > 0) {
      dailyLossBNB += loss;
      console.log(`[Strategy] 💸 ${pos.tokenSymbol}: 亏损 ${loss.toFixed(6)} BNB (当日累计 ${dailyLossBNB.toFixed(4)}/${MAX_DAILY_LOSS_BNB})`);
      if (dailyLossBNB >= MAX_DAILY_LOSS_BNB) {
        console.log(`[Strategy] 🛑 当日累计亏损 ${dailyLossBNB.toFixed(4)} BNB >= ${MAX_DAILY_LOSS_BNB}，停止交易!`);
        stopStrategy();
      }
    }
    pos.sellPriceUSD = (pos.buyPriceUSD > 0 && pos.buyAmountToken > 0) ? (result.amountOut / (pos.buyAmountBNB || 1)) * pos.buyPriceUSD : 0;
    pos.notes = `已卖出 ${percent}%`; savePositions(); notifyPositionChange();
    logDecision({ type: 'sell', tokenAddress: pos.tokenAddress, tokenSymbol: pos.tokenSymbol, detail: `卖出 ${actualSell} 代币，获得 ${result.amountOut} BNB` });
    return result;
  } catch (err) {
    pos.status = 'active';
    pos.sellFailCount = (pos.sellFailCount || 0) + 1;
    savePositions(); notifyPositionChange();
    console.log(`[Strategy] ⚠️ ${pos.tokenSymbol}: 卖出失败第${pos.sellFailCount}次`);
    if (pos.sellFailCount >= MAX_SELL_FAILURES) {
      pos.status = 'failed';
      pos.notes = `连续${pos.sellFailCount}次卖出失败，已标记为不可交易`;
      console.log(`[Strategy] ❌ ${pos.tokenSymbol}: 连续${pos.sellFailCount}次卖出失败，永久标记!`);
      savePositions(); notifyPositionChange();
    }
    throw err;
  }
}

export async function liquidateAll() {
  const results = [];
  for (const pos of positions.filter(p => p.status === 'active')) {
    try { const result = await sellPosition(pos.id, 100); results.push({ tokenAddress: pos.tokenAddress, success: true, result }); }
    catch (err) { results.push({ tokenAddress: pos.tokenAddress, success: false, error: err.message }); }
  }
  return results;
}

// ============ 止盈止损 ============

function checkStopLossTakeProfit(pos) {
  if (pos.status !== 'active' || pos.buyPriceUSD <= 0) return null;
  const pnl = pos.pnlPercent;
  if (pnl <= pos.stopLossPercent) { logDecision({ type: 'stop_loss', tokenAddress: pos.tokenAddress, tokenSymbol: pos.tokenSymbol, detail: `止损触发! PnL ${pnl.toFixed(1)}%` }); return { action: 'sell', reason: `止损 ${pnl.toFixed(1)}%` }; }
  if (pnl >= pos.takeProfitPercent) { logDecision({ type: 'take_profit', tokenAddress: pos.tokenAddress, tokenSymbol: pos.tokenSymbol, detail: `止盈触发! PnL ${pnl.toFixed(1)}%` }); return { action: 'sell', reason: `止盈 ${pnl.toFixed(1)}%` }; }
  if (pos.trailingStopEnabled && pos.highestPriceUSD > pos.buyPriceUSD) {
    const drawdown = ((pos.highestPriceUSD - pos.currentPriceUSD) / pos.highestPriceUSD) * 100;
    if (drawdown >= pos.trailingStopPercent) { logDecision({ type: 'trailing_stop', tokenAddress: pos.tokenAddress, tokenSymbol: pos.tokenSymbol, detail: `回落 ${drawdown.toFixed(1)}% 触发 trailing stop` }); return { action: 'sell', reason: `trailing stop 回落 ${drawdown.toFixed(1)}%` }; }
  }
  return null;
}

async function monitorPositions() {
  if (!strategyRunning || !isMonitoring) return;
  try {
    for (const pos of positions) {
      if (pos.status !== 'active') continue;

      // 跳过卖出失败过多的持仓
      if ((pos.sellFailCount || 0) >= MAX_SELL_FAILURES) {
        pos.status = 'failed';
        pos.notes = `连续${pos.sellFailCount}次卖出失败`;
        console.log(`[Strategy] ❌ ${pos.tokenSymbol}: 标记为不可交易（跳过监控）`);
        savePositions(); notifyPositionChange();
        continue;
      }

      // 同一持仓卖出失败后冷却5分钟再重试
      if (pos.lastSellAttempt && (Date.now() - pos.lastSellAttempt) < 60000) {
        const remaining = Math.ceil((60000 - (Date.now() - pos.lastSellAttempt)) / 1000);
        if (remaining > 0 && remaining % 10 === 0) {
          console.log(`[Strategy] ⏳ ${pos.tokenSymbol}: 卖出冷却中 ${remaining}s`);
        }
        continue;
      }

      try {
        await setTargetToken(pos.tokenAddress);
        const balances = await getBalances();
        const livePrice = await getTokenPrice(pos.tokenAddress);
        const priceChange = livePrice || pos.buyPriceUSD;
        if (balances.token <= 0 && pos.status === 'active') { pos.status = 'sold'; pos.notes = '链上余额为0'; savePositions(); notifyPositionChange(); continue; }
        updatePositionPrice(pos.id, priceChange, balances.token);
        const check = checkStopLossTakeProfit(pos);
        if (check) {
          console.log(`[Strategy] ⚠️ ${pos.tokenSymbol}: ${check.reason}`);
          pos.lastSellAttempt = Date.now();
          await sellPosition(pos.id, 100);
        }
      } catch (err) {
        // 卖出失败已在 sellPosition 中处理（fail counter + auto mark）
        console.warn(`[Strategy] ⏸️ ${pos.tokenSymbol}: 卖出失败，跳过本轮`);
      }
    }
    savePositions();
  } catch (err) { console.error(`[Strategy] 监控异常: ${err.message}`); }
}

// ============ 买入决策 (v3) ============

export async function evaluateAndBuy(candidates, maxToBuy = 1) {
  if (!strategyRunning) return [];
  if (!candidates || candidates.length === 0) return [];

  const activeCount = positions.filter(p => p.status === 'active').length;
  if (activeCount >= MAX_POSITIONS) {
    console.log(`[Strategy] ⏸️ 已达最大持仓数 ${MAX_POSITIONS}/${MAX_POSITIONS}`);
    return [];
  }

  const results = [];
  const heldAddresses = new Set(positions.filter(p => p.status === 'active').map(p => p.tokenAddress.toLowerCase()));
  const newCandidates = candidates.filter(c => !heldAddresses.has(c.tokenAddress.toLowerCase()));
  if (newCandidates.length === 0) return [];

  newCandidates.sort((a, b) => b.score - a.score);
  const toBuy = newCandidates.slice(0, maxToBuy);

  for (const candidate of toBuy) {
    if (candidate.score < MIN_SCORE) {
      console.log(`[Strategy] ❌ ${candidate.tokenSymbol} 评分 ${candidate.score} < ${MIN_SCORE}`);
      continue;
    }

    // 卖出冷却检测
    const timeSinceLastSell = Date.now() - lastSellTime;
    if (lastSellTime > 0 && timeSinceLastSell < SELL_COOLDOWN_MS) {
      const remaining = Math.ceil((SELL_COOLDOWN_MS - timeSinceLastSell) / 1000);
      console.log(`[Strategy] ⏸️ ${candidate.tokenSymbol}: 卖出冷却中，剩余 ${remaining}s`);
      continue;
    }

    // 高分高流延迟建仓（评分>85且流动性>$100k，等待10分钟）
    if (candidate.score > 85 && candidate.liquidityUSD > 100000) {
      const addr = candidate.tokenAddress;
      const existing = pendingDelayedBuys[addr];
      const now = Date.now();
      if (!existing) {
        pendingDelayedBuys[addr] = { firstSeen: now, candidate };
        console.log(`[Strategy] ⏳ ${candidate.tokenSymbol}: 高分高流延迟建仓（10分钟冷却），已记录`);
        continue;
      }
      const elapsed = now - existing.firstSeen;
      if (elapsed < 10 * 60 * 1000) {
        const remaining = Math.ceil((10 * 60 * 1000 - elapsed) / 1000);
        console.log(`[Strategy] ⏳ ${candidate.tokenSymbol}: 延迟冷却中，剩余 ${remaining}s`);
        continue;
      }
      // 冷却完毕，清除并继续
      delete pendingDelayedBuys[addr];
      console.log(`[Strategy] ✅ ${candidate.tokenSymbol}: 延迟冷却完毕，开始买入`);
    }

    // 1. 深度验证（价格偏离 + 流动性）
    console.log(`[Strategy] 🔍 ${candidate.tokenSymbol}: 深度验证中...`);
    const validation = await deepValidateCandidate(candidate);
    if (!validation.pass) {
      console.log(`[Strategy] ❌ ${candidate.tokenSymbol}: 深度验证失败 - ${validation.reason}`);
      logDecision({ type: 'validation_fail', tokenAddress: candidate.tokenAddress, tokenSymbol: candidate.tokenSymbol, detail: validation.reason });
      continue;
    }
    const buyCandidate = validation.updatedCandidate || candidate;

    // 1.5: BscScan 深度检测（如果API Key已配置）
    const pairAddr = candidate.pairAddress || '';
    if (process.env.BSCSCAN_API_KEY) {
      console.log('[Strategy] 🔬 BscScan深度检测...');
      const dcResult = await runDeepCheck(buyCandidate.tokenAddress, pairAddr);
      if (!dcResult.allPass) {
        console.log('[Strategy] ❌ BscScan检测未通过: ' + dcResult.reason);
        logDecision({ type: 'deepcheck_fail', tokenAddress: buyCandidate.tokenAddress, tokenSymbol: buyCandidate.tokenSymbol, detail: dcResult.reason });
        continue;
      }
    }
    // 2. V3: 链上仿真检测（蜜罐）
    const simResult = await simulationCheck(buyCandidate.tokenAddress, buyCandidate.tokenSymbol);
    if (!simResult.pass) {
      console.log(`[Strategy] ❌ ${buyCandidate.tokenSymbol}: 仿真检测失败 - ${simResult.reason}`);
      logDecision({ type: 'simulation_fail', tokenAddress: buyCandidate.tokenAddress, tokenSymbol: buyCandidate.tokenSymbol, detail: simResult.reason });
      continue;
    }
    // 3.5. BscScan 深度安全检测（创建者溯源 + LP锁）
    if (BSCSCAN_DEEP_CHECK) {
      console.log(`[Strategy] 🛡️ ${buyCandidate.tokenSymbol}: BscScan 深度安全检测中...`);
      const security = await deepSecurityCheck(
        buyCandidate.tokenAddress,
        buyCandidate.dexUrl ? buyCandidate.dexUrl.replace("https://dexscreener.com/bsc/", "") : ""
      );
      if (security.available) {
        console.log(`  👤 创建者: ${security.creator.address ? security.creator.address.slice(0,10)+"..." : "N/A"} 风险:${security.creator.risk} 交易:${security.creator.txCount}`);
        console.log(`  🔒 LP锁: ${security.lpLock.locked ? "✅ 已锁定" : "⚠️ 未检测到锁定"} 锁定数:${security.lpLock.lockCount}`);
        if (security.creator.risk === "high") {
          console.log(`[Strategy] ❌ ${buyCandidate.tokenSymbol}: 创建者风险过高 - ${security.creator.note}`);
          logDecision({ type: "security_fail", tokenAddress: buyCandidate.tokenAddress, tokenSymbol: buyCandidate.tokenSymbol, detail: `创建者风险: ${security.creator.note}` });
          continue;
        }
      } else {
        console.log(`[Strategy] ⚠️ ${buyCandidate.tokenSymbol}: BscScan 检测不可用 - ${security.error}`);
      }
    }

    // 3. 再次检查持仓上限
    const currentActive = positions.filter(p => p.status === 'active').length;
    if (currentActive >= MAX_POSITIONS) {
      console.log(`[Strategy] ⏸️ ${buyCandidate.tokenSymbol}: 已到持仓上限`);
      break;
    }

    try {
      // 4. 评分分级策略
      const scoreStrategy = getScoreStrategy(buyCandidate.score);
      const totalAmount = scoreStrategy.buyAmount;
      console.log(`[Strategy] 🎯 ${buyCandidate.tokenSymbol} | 评分:${buyCandidate.score} | 买入:${totalAmount} BNB | 价:$${buyCandidate.priceUSD} | 分级:止损${scoreStrategy.stopLoss}%/止盈${scoreStrategy.takeProfit}%/分批${scoreStrategy.batchSplit}次`);

      // 5. 评分分级分批建仓
      const result = await executeBatchBuy(buyCandidate, totalAmount, buyCandidate.tokenSymbol, scoreStrategy.batchSplit);
      const batchSplits = result.batchSplits || 1;

      addPosition({
        tokenAddress: buyCandidate.tokenAddress,
        tokenSymbol: buyCandidate.tokenSymbol,
        buyAmountBNB: totalAmount,
        buyAmountToken: result.amountOut || 0,
        buyPriceUSD: result.actualPriceUSD || buyCandidate.priceUSD,
        txHash: result.txHash || '',
        notes: batchSplits > 1 ? `分批${batchSplits}次买入 (${scoreStrategy.takeProfit}%止盈/${scoreStrategy.stopLoss}%止损)` : '',
        batchSplits,
        stopLossPercent: scoreStrategy.stopLoss,
        takeProfitPercent: scoreStrategy.takeProfit,
        trailingStopPercent: scoreStrategy.trailingStop,
      });

      results.push({ success: true, candidate: buyCandidate, result });
      console.log(`[Strategy] ✅ ${buyCandidate.tokenSymbol} 买入成功!${batchSplits > 1 ? ` (分批${batchSplits}次)` : ''}`);
    } catch (err) {
      console.error(`[Strategy] ❌ ${buyCandidate.tokenSymbol} 买入失败: ${err.message}`);
      results.push({ success: false, candidate: buyCandidate, error: err.message });
    }
  }
  return results;
}

export async function manualBuy(candidate, amountBNB) {
  if (!candidate) throw new Error('未指定代币');
  const buyAmount = amountBNB || calcBuyAmount(candidate.score || 50);
  await setTargetToken(candidate.tokenAddress);
  const result = await executeBuy(buyAmount);
  addPosition({
    tokenAddress: candidate.tokenAddress,
    tokenSymbol: candidate.tokenSymbol,
    buyAmountBNB: buyAmount,
    buyAmountToken: result.amountOut || 0,
    buyPriceUSD: result.actualPriceUSD || candidate.priceUSD,
    txHash: result.txHash || '',
  });
  return result;
}

// ============ 决策日志 ============

function logDecision(entry) {
  decisions.unshift({ ...entry, time: new Date().toISOString() });
  if (decisions.length > 1000) decisions = decisions.slice(0, 1000);
  saveDecisions();
}

function saveDecisions() {
  try {
    const dir = path.dirname(DECISIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DECISIONS_FILE, JSON.stringify(decisions, null, 2));
  } catch { /* ignore */ }
}

function loadDecisions() {
  try { if (fs.existsSync(DECISIONS_FILE)) decisions = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf-8')); } catch { decisions = []; }
}

function randomInRange(min, max) { return Math.random() * (max - min) + min; }

function notifyPositionChange() { if (onPositionChange) onPositionChange(positions); }

// ============ 生命周期 ============

export async function startStrategy() {
  if (strategyRunning) return;
  loadPositions();
  loadDecisions();
  try {
    if (hasWallets()) { const pk = getActivePrivateKey(); if (pk) { await reinitEngine(pk); console.log(`[Strategy] 💼 钱包: ${pk.slice(0, 10)}...`); } else throw new Error('无法获取私钥'); }
    else { await initEngine(); }
  } catch (err) { console.error(`[Strategy] 初始化失败: ${err.message}`); throw err; }
  strategyRunning = true; isMonitoring = true;
  console.log(`[Strategy] ✅ v3 分级已启动 | 持仓:${positions.filter(p => p.status === 'active').length}/${MAX_POSITIONS} | 仿真:${BUY_ENABLE_SIMULATION} | 分批:${BATCH_BUY_ENABLED}`);
  monitorPositions().catch(() => {});
  monitorTimerId = setInterval(() => monitorPositions().catch(() => {}), monitorIntervalMs);
  notifyPositionChange();
}

export function stopStrategy() {
  strategyRunning = false; isMonitoring = false;
  if (monitorTimerId) { clearInterval(monitorTimerId); monitorTimerId = null; }
  console.log('[Strategy] ⏹️ 已停止');
}

export function getPositions() { return positions; }
export function getDecisions(count = 50, offset = 0) { return { items: decisions.slice(offset, offset + count), total: decisions.length }; }
export function getStrategyStatus() {
  return {
    running: strategyRunning, monitoring: isMonitoring,
    activePositions: positions.filter(p => p.status === 'active').length,
    maxPositions: MAX_POSITIONS, totalPositions: positions.length,
    minScore: MIN_SCORE, buyRange: `${BUY_MIN_BNB}-${BUY_MAX_BNB} BNB`,
    simulationEnabled: BUY_ENABLE_SIMULATION,
    batchBuyEnabled: BATCH_BUY_ENABLED,
    gradingTiers: [
      { minScore: 80, stopLoss: -20, takeProfit: 150, batchSplit: 2, maxBuy: 0.005 },
      { minScore: 65, stopLoss: -20, takeProfit: 80, batchSplit: 2, maxBuy: 0.003 },
      { minScore: 50, stopLoss: -18, takeProfit: 60, batchSplit: 1, maxBuy: 0.002 },
    ],
    sellCooldown: '5m',
    delayedBuyEnabled: true, delayedBuyCooldown: '10m',
  };
}

export function updatePositionConfig(positionId, config) {
  const pos = positions.find(p => p.id === positionId);
  if (!pos) throw new Error(`持仓不存在: ${positionId}`);
  if (config.stopLossPercent !== undefined) pos.stopLossPercent = config.stopLossPercent;
  if (config.takeProfitPercent !== undefined) pos.takeProfitPercent = config.takeProfitPercent;
  if (config.trailingStopPercent !== undefined) pos.trailingStopPercent = config.trailingStopPercent;
  if (config.trailingStopEnabled !== undefined) pos.trailingStopEnabled = config.trailingStopEnabled;
  savePositions(); notifyPositionChange();
  return pos;
}
