/**
 * screener-deep.js — BscScan 链上深度检测
 * 依赖 BSCSCAN_API_KEY，提供 Top10持币/创建者溯源/LP锁/持有者增长
 */

import fetch from 'node-fetch';
import 'dotenv/config';

const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const BSCSCAN_BASE = 'https://api.bscscan.com/api';

// 已知 LP 锁定合约
const LOCK_CONTRACTS = [
  '0xe2fE530C047f2d85298b07D9333C05737f1435fB', // Unicrypt
  '0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE', // PinkLock
  '0x71B5759d73262FBb223956913ecF4ecC51057641', // PinkLock 2
  '0x663B3a73f347bde9f1caD2e0Dd79671663d10F1d', // Team Finance
  '0x4f0aCd632CaF8a7E3Ff5363bC2985B5cEDD32984', // FlokiFi
];

const KNOWN_BURN = ['0x000000000000000000000000000000000000dead'];

async function bscApi(params) {
  if (!BSCSCAN_API_KEY) return null;
  try {
    const qs = new URLSearchParams({ ...params, apikey: BSCSCAN_API_KEY });
    const url = `${BSCSCAN_BASE}?${qs}`;
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.status === '0' && typeof data.result === 'string' &&
        (data.result.includes('Max rate') || data.result.includes('Invalid'))) {
      console.warn(`[DeepCheck] BscScan: ${data.result}`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[DeepCheck] 请求失败: ${err.message}`);
    return null;
  }
}

/**
 * Top10 持币集中度
 */
export async function checkTopHolders(tokenAddress) {
  if (!BSCSCAN_API_KEY) return { pass: true, reason: '无API Key' };

  const data = await bscApi({
    module: 'token', action: 'tokenholderlist',
    contractaddress: tokenAddress, page: 1, offset: 10,
  });

  if (!data || data.status !== '1' || !data.result) {
    return { pass: true, reason: '持币数据不可用' };
  }

  const holders = data.result;
  // 统计非 zero/burn 地址的持有者数量
  const realHolders = holders.filter(h => {
    const addr = (h.TokenHolderAddress || '').toLowerCase();
    return !KNOWN_BURN.some(burn => addr.includes(burn));
  });

  const holderCount = holders.length;
  const isRisky = realHolders.length < 3 || holderCount < 5;

  console.log(`[DeepCheck] 🔍 持有者: ${holderCount}个 (真实:${realHolders.length}) ${isRisky?'⚠️高风险':''}`);

  return { pass: !isRisky, reason: isRisky ? `持有者过少(${holderCount}个)` : `持有者${holderCount}个 OK`, holderCount, realHolderCount: realHolders.length };
}

/**
 * 创建者钱包溯源
 */
export async function traceCreator(tokenAddress) {
  if (!BSCSCAN_API_KEY) return { pass: true, reason: '无API Key' };

  const data = await bscApi({
    module: 'account', action: 'txlist',
    address: tokenAddress, startblock: 0, endblock: 99999999,
    page: 1, offset: 3, sort: 'asc',
  });

  if (!data || data.status !== '1' || !data.result || data.result.length === 0) {
    return { pass: true, reason: '无法获取创建交易' };
  }

  const deployer = data.result[0].from;
  const deployData = await bscApi({
    module: 'account', action: 'txlist',
    address: deployer, startblock: 0, endblock: 99999999,
    page: 1, offset: 50, sort: 'asc',
  });

  const txCount = (deployData && deployData.result) ? deployData.result.length : 0;
  const isNewWallet = txCount < 10;

  console.log(`[DeepCheck] 🔍 部署者: ${deployer.slice(0,10)}... Tx:${txCount} ${isNewWallet?'⚠️新号':''}`);

  return { pass: !isNewWallet, reason: isNewWallet ? `新号(${txCount}tx)` : `老号(${txCount}tx)`, deployer, txCount, isNewWallet };
}

/**
 * LP 锁检测
 */
export async function checkLiquidityLock(pairAddress) {
  if (!BSCSCAN_API_KEY || !pairAddress) return { pass: true, reason: '无API Key或无交易对' };

  const data = await bscApi({
    module: 'token', action: 'tokenholderlist',
    contractaddress: pairAddress, page: 1, offset: 20,
  });

  if (!data || data.status !== '1' || !data.result) {
    return { pass: true, reason: 'LP持有者数据不可用' };
  }

  const holders = data.result;
  let lockedCount = 0;

  for (const h of holders) {
    const addr = (h.TokenHolderAddress || '').toLowerCase();
    if (LOCK_CONTRACTS.some(l => l.toLowerCase() === addr)) {
      lockedCount++;
    }
  }

  const isLocked = lockedCount > 0;

  console.log(`[DeepCheck] 🔍 LP锁: ${isLocked?'🔒 已锁定':'⚠️ 未锁定'} (${lockedCount}个锁仓合约)`);

  return { pass: isLocked, reason: isLocked ? `LP已锁仓` : 'LP未锁仓', isLocked, lockedCount };
}

/**
 * 综合深度检测
 */
export async function runDeepCheck(tokenAddress, pairAddress) {
  if (!BSCSCAN_API_KEY) return { allPass: true, reason: 'BscScan API Key 未配置' };

  console.log(`\n[DeepCheck] 🔬 ${tokenAddress.slice(0,10)}...`);

  const [top10, creator, lpLock] = await Promise.all([
    checkTopHolders(tokenAddress),
    traceCreator(tokenAddress),
    checkLiquidityLock(pairAddress),
  ]);

  const checks = { top10, creator, lpLock };
  const fails = [];

  if (!top10.pass) fails.push(`持有者:${top10.reason}`);
  if (!creator.pass) fails.push(`部署者:${creator.reason}`);
  if (!lpLock.pass) fails.push(`LP锁:${lpLock.reason}`);

  const allPass = fails.length === 0;

  if (allPass) {
    console.log(`[DeepCheck] ✅ 全部通过`);
  } else {
    console.log(`[DeepCheck] ⚠️ 不通过: ${fails.join(' | ')}`);
  }

  return { allPass, reason: allPass ? '全部通过' : fails.join('; '), checks };
}
