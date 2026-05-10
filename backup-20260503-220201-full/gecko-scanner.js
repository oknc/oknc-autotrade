/**
 * gecko-scanner.js — GeckoTerminal 新池子扫描
 *
 * GeckoTerminal 提供免费公开 API，实时返回新创建的流动性池
 * 补充 DexScreener 关键词搜索无法发现 BSC 新币的短板
 */
import fetch from 'node-fetch';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'bsc';
const WBNB_LOWER = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

// 追踪已处理过的池子地址（避免重复）
const seenPools = new Set();

/**
 * 从 GeckoTerminal 获取最新 PancakeSwap V2 池子的代币地址
 * @returns {Promise<Array<{tokenAddress: string, poolAddress: string}>>}
 */
export async function getNewGeckoPairs() {
  try {
    const url = `${GECKO_BASE}/networks/${NETWORK}/new_pools?page=1`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    });
    if (!res.ok) {
      console.log(`[GeckoScanner] ⚠️ API ${res.status}`);
      return [];
    }

    const data = await res.json();
    const pools = data.data || [];
    if (pools.length === 0) return [];

    // 过滤 PancakeSwap V2 + 新池子
    const newTokens = [];

    for (const pool of pools) {
      try {
        const rel = pool.relationships || {};
        const dexId = rel.dex?.data?.id || '';

        // 只处理 PancakeSwap
        if (!dexId.includes('pancakeswap')) continue;

        const poolAddr = pool.attributes?.address || '';
        if (!poolAddr || seenPools.has(poolAddr.toLowerCase())) continue;

        // 获取 base/quote token 地址（格式: "bsc_0x..."）
        const baseId = rel.base_token?.data?.id || '';
        const quoteId = rel.quote_token?.data?.id || '';
        const baseAddr = baseId.startsWith('bsc_') ? baseId.slice(4) : baseId;
        const quoteAddr = quoteId.startsWith('bsc_') ? quoteId.slice(4) : quoteId;

        // 只处理 WBNB 交易对
        if (quoteAddr.toLowerCase() !== WBNB_LOWER && baseAddr.toLowerCase() !== WBNB_LOWER) continue;

        const tokenAddress = quoteAddr.toLowerCase() === WBNB_LOWER ? baseAddr : quoteAddr;
        seenPools.add(poolAddr.toLowerCase());

        newTokens.push({ tokenAddress, poolAddress: poolAddr });
      } catch { /* 单条解析失败跳过 */ }
    }

    // 控制 seenPools 大小，避免内存泄漏
    if (seenPools.size > 10000) {
      const arr = [...seenPools];
      seenPools.clear();
      arr.slice(-5000).forEach(a => seenPools.add(a));
    }

    if (newTokens.length > 0) {
      console.log(`[GeckoScanner] 🔍 发现 ${newTokens.length} 个 PancakeSwap 新池`);
    }
    return newTokens;
  } catch (err) {
    console.error(`[GeckoScanner] ❌ 异常: ${err.message}`);
    return [];
  }
}

/**
 * 重置已处理池子记录
 */
export function resetGeckoScanner() {
  seenPools.clear();
  console.log('[GeckoScanner] 🔄 已重置');
}
