/**
 * screener.js — DexScreener 数据源 + 筛选引擎 (v4)
 *
 * v4 新增：
 * - 多轮确认机制：代币需经过 N 次扫描持续出现才列入候选
 * - 社媒存在评分加分：有 Twitter/Telegram/Website 额外加分
 * - 自适应扫描间隔：无候选中自动拉长节省 API
 * - 链上仿真检测（在 strategy.js 预购阶段执行）
 */

import fetch from 'node-fetch';
import 'dotenv/config';

const SEARCH_BASE = 'https://api.dexscreener.com/latest/dex/search';

const SEARCH_QUERIES = [
  'meme', 'pepe', 'doge', 'shib', 'floki', 'bonk', 'trump', 'ai', 'agent',
  'cat', 'dog', 'frog', 'duck', 'pig', 'hamster', 'fish', 'bird',
];

// SOL 链搜索关键词
const SEARCH_QUERIES_SOL = [
  'meme', 'pepe', 'doge', 'ai', 'agent', 'cat', 'dog', 'trump',
  'pump', 'fun', 'sol', 'raydium', 'orca',
];

// 链配置
const CHAIN_CONFIG = {
  bsc: { chainId: 'bsc', filterDex: ['pancakeswap'], label: 'BSC', dexUrlPrefix: 'bsc' },
  sol: { chainId: 'solana', filterDex: ['raydium', 'meteora', 'orca', 'pumpfun', 'lifinity'], label: 'Solana', dexUrlPrefix: 'solana' },
};

// 当前活跃链（可运行时切换）
let currentChain = process.env.ACTIVE_CHAIN || 'bsc';

// 高频词（热门赛道）扫描频率翻倍
const HIGH_FREQ_QUERIES = ['meme', 'ai', 'pepe', 'doge', 'trump'];

const MIN_LIQUIDITY_USD = parseFloat(process.env.MIN_LIQUIDITY_USD || '5000');
const MAX_AGE_HOURS = parseFloat(process.env.MAX_AGE_HOURS || '48');
const MIN_VOLUME_USD = parseFloat(process.env.MIN_VOLUME_USD || '10000');

const MIN_TXNS_H1 = parseInt(process.env.MIN_TXNS_H1 || '30', 10);
const MIN_BUY_SELL_RATIO_H1 = parseFloat(process.env.MIN_BUY_SELL_RATIO_H1 || '0.3');
const MAX_BUY_SELL_RATIO_H1 = parseFloat(process.env.MAX_BUY_SELL_RATIO_H1 || '10');
const MIN_BUY_SELL_RATIO_M5 = parseFloat(process.env.MIN_BUY_SELL_RATIO_M5 || '0.2');
const MAX_BUY_SELL_RATIO_M5 = parseFloat(process.env.MAX_BUY_SELL_RATIO_M5 || '15');
const MIN_LIQ_MCAP_RATIO = parseFloat(process.env.MIN_LIQ_MCAP_RATIO || '0.02');
const MAX_LIQ_MCAP_RATIO = parseFloat(process.env.MAX_LIQ_MCAP_RATIO || '10');
const MIN_PRICE_USD = parseFloat(process.env.MIN_PRICE_USD || '0.000000001');
const MAX_PRICE_USD = parseFloat(process.env.MAX_PRICE_USD || '1000');

// === v4 新增 ===
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '3', 10);
const SCAN_ADAPTIVE_ENABLED = (process.env.SCAN_ADAPTIVE_ENABLED || 'true') === 'true';
const SCAN_MIN_INTERVAL = parseInt(process.env.SCAN_MIN_INTERVAL || '20', 10);
const SCAN_MAX_INTERVAL = parseInt(process.env.SCAN_MAX_INTERVAL || '120', 10);


// === v5 价格趋势过滤 ===
const MAX_PRICE_DROP_H24 = parseFloat(process.env.MAX_PRICE_DROP_H24 || '-20');
const MAX_PRICE_DROP_H6 = parseFloat(process.env.MAX_PRICE_DROP_H6 || '-15');
// ============ 状态 ============
let candidates = [];
let lastScanTime = null;
let seenTokens = new Set();
let isScanning = false;
let scanTimerId = null;
let scanIntervalMs = (parseInt(process.env.SCAN_INTERVAL_SEC || '30', 10)) * 1000;
let onNewCandidates = null;

// 链状态管理
export function getCurrentChain() { return currentChain; }

export function setCurrentChain(chain) {
  if (!CHAIN_CONFIG[chain]) throw new Error("不支持的链: " + chain);
  currentChain = chain;
  console.log("[Screener] 🔄 切换到 " + CHAIN_CONFIG[chain].label);
}

// === v4 状态 ===
const seenCount = new Map();
const emptyScanCount = { value: 0 };

export function setOnNewCandidates(callback) {
  onNewCandidates = callback;
}

// ============ API ============

async function searchTokens(query) {
  const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`DexScreener search ${res.status}`);
  return res.json();
}

export async function fetchTokenPairs(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    return data.pairs || [];
  } catch { return []; }
}

export async function fetchLatestPair(tokenAddress) {
  const pairs = await fetchTokenPairs(tokenAddress);
  const bscPairs = pairs.filter(p =>
    p.chainId === CHAIN_CONFIG[currentChain].chainId && CHAIN_CONFIG[currentChain].filterDex.includes(p.dexId?.toLowerCase())
  );
  bscPairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));
  return bscPairs[0] || null;
}

function calcRatio(buys, sells) {
  if (sells <= 0 && buys > 0) return 99;
  if (sells <= 0 && buys <= 0) return 0;
  return buys / sells;
}

// ============ 自适应间隔 ============

function adaptScanInterval(foundCandidates) {
  if (!SCAN_ADAPTIVE_ENABLED) return;
  if (foundCandidates === 0) {
    emptyScanCount.value++;
  } else {
    emptyScanCount.value = 0;
  }
  let targetMs = scanIntervalMs;
  if (emptyScanCount.value >= 5) {
    targetMs = Math.min(scanIntervalMs * 1.5, SCAN_MAX_INTERVAL * 1000);
  } else if (emptyScanCount.value >= 3) {
    targetMs = Math.min(scanIntervalMs * 1.2, SCAN_MAX_INTERVAL * 1000);
  } else if (foundCandidates > 0) {
    targetMs = Math.max(scanIntervalMs * 0.8, SCAN_MIN_INTERVAL * 1000);
  }
  if (targetMs !== scanIntervalMs) {
    scanIntervalMs = targetMs;
    if (scanTimerId) {
      clearInterval(scanTimerId);
      scanTimerId = setInterval(() => performScan().catch(() => {}), scanIntervalMs);
    }
    console.log(`[Screener] ⏱ 间隔调整为 ${(scanIntervalMs / 1000).toFixed(0)}s`);
  }
}

// ============ 筛选规则 ============

function filterPair(pair) {
  const chain = pair.chainId;
  const dex = (pair.dexId || '').toLowerCase();
  const baseToken = pair.baseToken || {};
  const addr = baseToken.address;

  if (!addr) return { pass: false, reason: '无代币地址' };
  if (chain === CHAIN_CONFIG[currentChain].chainId && CHAIN_CONFIG[currentChain].filterDex.includes(dex) ? false : true) return { pass: false, reason: '非' + CHAIN_CONFIG[currentChain].label + '链' };

  const priceUSD = parseFloat(pair.priceUsd || 0);
  if (priceUSD <= 0) return { pass: false, reason: '价格无效' };
  if (priceUSD < MIN_PRICE_USD) return { pass: false, reason: `价格过低 ${priceUSD}` };
  if (priceUSD > MAX_PRICE_USD) return { pass: false, reason: `价格过高 ${priceUSD}` };

  const liq = parseFloat(pair.liquidity?.usd || 0);
  if (liq < MIN_LIQUIDITY_USD) return { pass: false, reason: `流动性不足 $${liq.toFixed(0)}` };

  const createdAt = pair.pairCreatedAt;
  if (createdAt) {
    const ageHours = (Date.now() - createdAt) / 3600000;
    if (ageHours > MAX_AGE_HOURS) return { pass: false, reason: `创建超${MAX_AGE_HOURS}h` };
  }

  const vol = parseFloat(pair.volume?.h24 || 0);
  if (vol < MIN_VOLUME_USD) return { pass: false, reason: `交易量不足 $${vol.toFixed(0)}` };

  const ch5m = parseFloat(pair.priceChange?.m5 || 0);
  // v5: H24和H6价格趋势过滤（阴跌币不碰）
  const chH24 = parseFloat(pair.priceChange?.h24 || 0);
  if (chH24 < MAX_PRICE_DROP_H24) return { pass: false, reason: `24h暴跌 ${chH24}% < ${MAX_PRICE_DROP_H24}%` };
  const chH6 = parseFloat(pair.priceChange?.h6 || 0);
  if (chH6 < MAX_PRICE_DROP_H6) return { pass: false, reason: `6h暴跌 ${chH6}% < ${MAX_PRICE_DROP_H6}%` };
  if (ch5m < -50) return { pass: false, reason: `5m暴跌 ${ch5m}%` };

  const txnsH1 = pair.txns?.h1 || { buys: 0, sells: 0 };
  const totalTxnsH1 = txnsH1.buys + txnsH1.sells;
  const minTxnsRequired = (liq < 10000) ? 50 : MIN_TXNS_H1;
  if (totalTxnsH1 < minTxnsRequired) return { pass: false, reason: `交易笔数不足 ${totalTxnsH1}/${minTxnsRequired}${liq<10000?'(低流要求50)':''}` };

  const txnsM5 = pair.txns?.m5 || { buys: 0, sells: 0 };
  const ratioM5 = calcRatio(txnsM5.buys, txnsM5.sells);
  // 短期买卖比独立过滤 — 刷量机器人信号
  if (ratioM5 > 20) return { pass: false, reason: `5m买卖比${ratioM5.toFixed(1)}>20,疑似刷量` };
  if (txnsM5.buys > 0 && txnsM5.sells > 0) {
    if (ratioM5 > MAX_BUY_SELL_RATIO_M5) return { pass: false, reason: `5m买卖比异常 ${ratioM5.toFixed(1)}` };
    if (ratioM5 < MIN_BUY_SELL_RATIO_M5) return { pass: false, reason: `5m抛压过大 ${ratioM5.toFixed(1)}` };
  }

  const ratioH1 = calcRatio(txnsH1.buys, txnsH1.sells);
  if (txnsH1.buys > 3 && txnsH1.sells > 3) {
    if (ratioH1 > MAX_BUY_SELL_RATIO_H1) return { pass: false, reason: `1h买卖比异常 ${ratioH1.toFixed(1)}` };
    if (ratioH1 < MIN_BUY_SELL_RATIO_H1) return { pass: false, reason: `1h抛压过大 ${ratioH1.toFixed(1)}` };
  }

  const mcap = parseFloat(pair.marketCap || 0);
  if (mcap > 0) {
    const liqMcapRatio = liq / mcap;
    if (liqMcapRatio < MIN_LIQ_MCAP_RATIO) return { pass: false, reason: `Liq/Mcap过低 ${liqMcapRatio.toFixed(4)}` };
    if (liqMcapRatio > MAX_LIQ_MCAP_RATIO) return { pass: false, reason: `Liq/Mcap过高 ${liqMcapRatio.toFixed(2)}` };
  }

  const txns24h = pair.txns?.h24 || { buys: 0, sells: 0 };
  if (txns24h.sells > 0 && txns24h.buys > 0) {
    const ratio24h = txns24h.buys / txns24h.sells;
    if (ratio24h > 12) {
      const priceCh24h = parseFloat(pair.priceChange?.h24 || 0);
      if (priceCh24h < 50) return { pass: false, reason: `疑似高税费 buy/sell=${ratio24h.toFixed(1)}` };
    }
  }

  // === 蜜罐增强检测 (v6) ===
  // 1h维度: 如果1h买远超卖但价格不涨，高概率蜜罐（卖不出去所以买盘集中）
  const txnsH1v6 = pair.txns?.h1 || { buys: 0, sells: 0 };
  if (txnsH1v6.buys > 50 && txnsH1v6.sells > 0) {
    const ratioH1v6 = txnsH1v6.buys / txnsH1v6.sells;
    const chH1 = parseFloat(pair.priceChange?.h1 || 0);
    if (ratioH1v6 > 10 && chH1 < 20) {
      return { pass: false, reason: `1h买/卖比${ratioH1v6.toFixed(1)}价不涨,疑似蜜罐` };
    }
  }

  return { pass: true, reason: '通过' };
}

// ============ 评分 (v4) ============

function buildCandidate(pair) {
  const base = pair.baseToken || {};
  const liq = parseFloat(pair.liquidity?.usd || 0);
  const vol24h = parseFloat(pair.volume?.h24 || 0);
  const mcap = parseFloat(pair.marketCap || 0);
  const fdv = parseFloat(pair.fdv || 0);
  const createdAt = pair.pairCreatedAt || 0;
  const ageHours = createdAt ? (Date.now() - createdAt) / 3600000 : 0;
  const priceUSD = parseFloat(pair.priceUsd || 0);
  const priceChange = {
    m5: parseFloat(pair.priceChange?.m5 || 0),
    h1: parseFloat(pair.priceChange?.h1 || 0),
    h6: parseFloat(pair.priceChange?.h6 || 0),
    h24: parseFloat(pair.priceChange?.h24 || 0),
  };

  const txns = {
    m5: pair.txns?.m5 || { buys: 0, sells: 0 },
    h1: pair.txns?.h1 || { buys: 0, sells: 0 },
    h24: pair.txns?.h24 || { buys: 0, sells: 0 },
  };

  const ratioM5 = calcRatio(txns.m5.buys, txns.m5.sells);
  const ratioH1 = calcRatio(txns.h1.buys, txns.h1.sells);
  const ratio24h = calcRatio(txns.h24.buys, txns.h24.sells);

  let score = 0;

  // 1. 流动性 (+25)
  if (liq >= 100000) score += 25;
  else if (liq >= 50000) score += 23;
  else if (liq >= 30000) score += 20;
  else if (liq >= 20000) score += 17;
  else if (liq >= 10000) score += 13;
  else if (liq >= 5000) score += 7;

  // 2. 量流比 (+20)
  const volRatio = vol24h / (liq || 1);
  if (volRatio >= 10) score += 20;
  else if (volRatio >= 5) score += 18;
  else if (volRatio >= 3) score += 15;
  else if (volRatio >= 2) score += 12;
  else if (volRatio >= 1) score += 8;
  else if (volRatio >= 0.3) score += 3;

  // 3. 币龄 (+15)
  if (ageHours < 0.25) score += 0;          // <15min: 蜜罐高发期,数据太少,不给加分
  else if (ageHours < 1) score += 10;       // 15min~1h: 有初步数据,高风险高回报
  else if (ageHours < 6) score += 15;       // 1~6h: 黄金窗口🏆 数据可信+上涨空间大
  else if (ageHours < 12) score += 10;     // 6~12h: 较安全但最佳时机可能已过
  else if (ageHours < 24) score += 5;      // 12~24h: 土狗末期
  else if (ageHours < 48) score += 2;      // 24~48h: 捡漏

  // 4. 5m买卖比 (+7)
  if (ratioM5 >= 1.5 && ratioM5 <= 5) score += 7;
  else if (ratioM5 >= 1 && ratioM5 < 1.5) score += 4;
  else if (ratioM5 > 5 && ratioM5 <= 15) score += 3;
  else if (ratioM5 >= 0.5 && ratioM5 < 1) score += 1;

  // 5. 1h买卖比 (+8)
  if (ratioH1 >= 1.5 && ratioH1 <= 5) score += 8;
  else if (ratioH1 >= 1 && ratioH1 < 1.5) score += 5;
  else if (ratioH1 > 5 && ratioH1 <= 15) score += 3;
  else if (ratioH1 >= 0.5 && ratioH1 < 1) score += 1;

  // 6. Liq/Mcap (+5)
  if (mcap > 0) {
    const liqMcapRatio = liq / mcap;
    if (liqMcapRatio >= 0.1 && liqMcapRatio <= 0.8) score += 5;
    else if (liqMcapRatio >= 0.05 && liqMcapRatio < 0.1) score += 3;
    else if (liqMcapRatio > 0.8 && liqMcapRatio <= 3) score += 2;
  }

  // 7. 交易质量 (+5)
  const totalTxns24h = txns.h24.buys + txns.h24.sells;
  if (totalTxns24h > 500) score += 5;
  else if (totalTxns24h > 200) score += 4;
  else if (totalTxns24h > 100) score += 3;
  else if (totalTxns24h > 50) score += 1;

  // 8. V4: 社媒加分 (+8)
  const info = pair.info || {};
  const socials = info.socials || [];
  const websites = info.websites || [];
  let hasTwitter = false, hasTelegram = false, hasWebsite = false;
  for (const s of socials) {
    if ((s.type || '').toLowerCase() === 'twitter') hasTwitter = true;
    if ((s.type || '').toLowerCase() === 'telegram') hasTelegram = true;
  }
  // 9. 成交量激增加分（不看价格方向，看资金流）
  const volM5 = txns.m5.buys + txns.m5.sells;
  const volH1 = txns.h1.buys + txns.h1.sells;
  const avgVolPer5m = volH1 / 12; // 1h平均每5m成交量
  if (avgVolPer5m > 0 && volM5 > avgVolPer5m * 3) score += 4;
  else if (avgVolPer5m > 0 && volM5 > avgVolPer5m * 5) score += 6;
  
  // 9b. H6趋势（中周期涨跌）
  const ch6h = priceChange.h6;
  if (ch6h < -20) score -= 12;
  else if (ch6h < -15) score -= 8;
  else if (ch6h < -10) score -= 5;
  else if (ch6h < -8) score -= 4;
  
  // 9c. H24趋势（长周期涨跌）
  const ch24h = priceChange.h24;
  if (ch24h < -40) score -= 15;
  else if (ch24h < -25) score -= 10;
  else if (ch24h < -15) score -= 5;
  else if (ch24h > 50) score += 3;

  score = Math.max(0, Math.min(100, score));

  return {
    tokenAddress: base.address || '',
    tokenSymbol: base.symbol || '?',
    tokenName: base.name || '?',
    liquidityUSD: liq,
    volume24h: vol24h,
    marketCap: mcap,
    fdv, ageHours, createdAt, priceUSD, priceChange, txns,
    buySellRatio: ratio24h,
    buySellRatioM5: ratioM5,
    buySellRatioH1: ratioH1,
    buySellRatio24h: ratio24h,
    liqMcapRatio: mcap > 0 ? liq / mcap : 0,
    volRatio, totalTxns24h, totalTxnsH1: txns.h1.buys + txns.h1.sells,
    socialPresence: { twitter: hasTwitter, telegram: hasTelegram, website: hasWebsite },
    score,
    dexUrl: `https://dexscreener.com/${CHAIN_CONFIG[currentChain].dexUrlPrefix}/${base.address}`,
    chain: currentChain,
    pairAddress: pair.pairAddress || '',
    discoveredAt: new Date().toISOString(),
  };
}

// ============ 扫描逻辑 ============

async function performScan() {
  if (isScanning) return;
  isScanning = true;
  const startTime = Date.now();

  try {
    console.log(`[Screener] 🔄 扫描开始: ${new Date().toLocaleString()}`);

    const allPairs = new Map();
    const queries = currentChain === 'sol' ? SEARCH_QUERIES_SOL : SEARCH_QUERIES;
    for (const query of queries) {
      try {
        const data = await searchTokens(query);
        const pairs = data.pairs || [];
        for (const p of pairs) {
          const addr = p.baseToken?.address;
          if (!addr) continue;
          if (p.chainId !== CHAIN_CONFIG[currentChain].chainId || !CHAIN_CONFIG[currentChain].filterDex.includes(p.dexId?.toLowerCase())) continue;
          const key = addr.toLowerCase();
          const existing = allPairs.get(key);
          const newLiq = parseFloat(p.liquidity?.usd || 0);
          if (!existing || newLiq > parseFloat(existing.liquidity?.usd || 0)) {
            allPairs.set(key, p);
          }
        }
      } catch { /* 静默 */ }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Screener] 收集到 ${allPairs.size} 个 ${CHAIN_CONFIG[currentChain].label} 代币 (${elapsed}s) 多轮:${MIN_CONFIRMATIONS}x`);

    const sortedPairs = [...allPairs.values()].sort((a, b) =>
      (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0)
    );

    // 先统计所有通过筛选的
    const newCandidates = [];

    for (const pair of sortedPairs) {
      const addr = pair.baseToken.address.toLowerCase();
      if (seenTokens.has(addr)) continue;

      const result = filterPair(pair);
      if (!result.pass) continue;

      // 多轮确认
      if (MIN_CONFIRMATIONS > 1) {
        const cnt = (seenCount.get(addr) || 0) + 1;
        seenCount.set(addr, cnt);
        if (cnt < MIN_CONFIRMATIONS) {
          console.log(`  ⏳ ${pair.baseToken.symbol}: 第${cnt}/${MIN_CONFIRMATIONS}轮`);
          continue;
        }
      }

      seenTokens.add(addr);
      const candidate = buildCandidate(pair);
      newCandidates.push(candidate);
      console.log(`  ✅ ${candidate.tokenSymbol} | $${candidate.liquidityUSD} | ${candidate.ageHours.toFixed(1)}h | 评分:${candidate.score}${candidate.socialPresence.twitter?' 🐦':''}${candidate.socialPresence.telegram?' 📱':''}${candidate.totalTxnsH1?' txs:'+candidate.totalTxnsH1:''}`);
    }

    newCandidates.sort((a, b) => b.score - a.score);

    // 前3名
    newCandidates.slice(0, 3).forEach(c => {
      console.log(`  🏆 ${c.tokenSymbol} | 评分:${c.score} | 流:$${c.liquidityUSD} | ${c.ageHours.toFixed(1)}h`);
    });

    console.log(`[Screener] 新通过 ${newCandidates.length} 个`);

    if (newCandidates.length > 0) {
      candidates = [...newCandidates, ...candidates].slice(0, 100);
      lastScanTime = new Date();
      if (onNewCandidates) onNewCandidates(newCandidates, candidates);
    }

    // 自适应间隔
    adaptScanInterval(newCandidates.length);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Screener] ✅ 扫描完成 (${totalTime}s) 间隔:${(scanIntervalMs / 1000).toFixed(0)}s`);
  } catch (err) {
    console.error(`[Screener] 异常: ${err.message}`);
  } finally {
    isScanning = false;
  }
}

// ============ 生命周期 ============

export function startScanning() {
  if (scanTimerId) return;
  console.log(`[Screener] 🚀 启动 v4（间隔 ${scanIntervalMs / 1000}s, 多轮:${MIN_CONFIRMATIONS}x, 自适应:${SCAN_ADAPTIVE_ENABLED})`);
  performScan().catch(() => {});
  scanTimerId = setInterval(() => performScan().catch(() => {}), scanIntervalMs);
}

export function stopScanning() {
  if (scanTimerId) { clearInterval(scanTimerId); scanTimerId = null; }
  console.log('[Screener] 已停止');
}

export function getCandidates() { return candidates; }
export function getLastScanTime() { return lastScanTime; }

export async function forceScan() {
  await performScan();
  return candidates;
}

export function updateScanInterval(seconds) {
  scanIntervalMs = seconds * 1000;
  if (scanTimerId) {
    clearInterval(scanTimerId);
    scanTimerId = setInterval(() => performScan().catch(() => {}), scanIntervalMs);
  }
}

// ============ 代币分析工具（给前端手动查询用）============

/**
 * 对指定代币地址进行完整分析（抓取 → 过滤 → 评分）
 * @param {string} tokenAddress - 代币合约地址
 * @returns {object} 分析报告
 */
export async function analyzeToken(tokenAddress) {
  try {
    const pair = await fetchLatestPair(tokenAddress);
    if (!pair) return { error: '未找到 ' + CHAIN_CONFIG[currentChain].label + ' DEX 交易对' };

    // 运行筛选
    const filterResult = filterPair(pair);
    if (!filterResult.pass) {
      // 即便不通过也返回评分信息，让用户看到原因
      const candidate = buildCandidate(pair);
      return {
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.tokenSymbol,
        tokenName: candidate.tokenName,
        filtered: true,
        filterReason: filterResult.reason,
        filterPassed: false,
        score: candidate.score,
        priceUSD: candidate.priceUSD,
        liquidityUSD: candidate.liquidityUSD,
        volume24h: candidate.volume24h,
        marketCap: candidate.marketCap,
        ageHours: candidate.ageHours,
        buySellRatioM5: candidate.buySellRatioM5,
        buySellRatioH1: candidate.buySellRatioH1,
        buySellRatio24h: candidate.buySellRatio24h,
        totalTxnsH1: candidate.totalTxnsH1,
        socialPresence: candidate.socialPresence,
        scoreBreakdown: {
          liquidity: candidate.score >= 25 ? 25 : (candidate.score >= 23 ? 23 : (candidate.score >= 20 ? 20 : (candidate.score >= 17 ? 17 : (candidate.score >= 13 ? 13 : (candidate.score >= 7 ? 7 : 0))))),
          volLiquidityRatio: '见总分',
          tokenAge: candidate.ageHours < 1 ? 15 : (candidate.ageHours < 3 ? 12 : (candidate.ageHours < 6 ? 9 : (candidate.ageHours < 12 ? 6 : (candidate.ageHours < 24 ? 3 : 1)))),
        },
      };
    }

    // 构建完整评分候选
    const candidate = buildCandidate(pair);
    
    // 额外获取链上信息
    const pairAddress = pair.pairAddress || '';
    const dexUrl = `https://dexscreener.com/bsc/${tokenAddress}`;

    return {
      tokenAddress: candidate.tokenAddress,
      tokenSymbol: candidate.tokenSymbol,
      tokenName: candidate.tokenName,
      filtered: false,
      filterPassed: true,
      score: candidate.score,
      priceUSD: candidate.priceUSD,
      priceChange: candidate.priceChange,
      liquidityUSD: candidate.liquidityUSD,
      volume24h: candidate.volume24h,
      marketCap: candidate.marketCap,
      ageHours: candidate.ageHours,
      createdAt: candidate.createdAt,
      buySellRatioM5: candidate.buySellRatioM5,
      buySellRatioH1: candidate.buySellRatioH1,
      buySellRatio24h: candidate.buySellRatio24h,
      totalTxnsH1: candidate.totalTxnsH1,
      totalTxns24h: candidate.totalTxns24h,
      liqMcapRatio: candidate.liqMcapRatio,
      volRatio: candidate.volRatio,
      socialPresence: candidate.socialPresence,
      dexUrl,
      pairAddress,
    };
  } catch (err) {
    return { error: `分析失败: ${err.message}` };
  }
}