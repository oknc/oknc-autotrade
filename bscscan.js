/**
 * bscscan.js — BscScan API 封装
 * 
 * 功能：
 * - Top10 持币集中度查询
 * - 合约创建者钱包溯源
 * - LP 锁定状态检测
 * - 地址交易笔数查询（判断是否为新号）
 */

import fetch from 'node-fetch';
import 'dotenv/config';

const BSCSCAN_API = 'https://api.bscscan.com/api';

function getApiKey() {
  const key = process.env.BSCSCAN_API_KEY;
  if (!key || key === 'YOUR_BSCSCAN_API_KEY_HERE') {
    return null;
  }
  return key;
}

/**
 * 获取代币前 N 大持有者
 * @param {string} tokenAddress - 代币合约地址
 * @param {number} limit - 返回多少名 (最多10)
 * @returns {{ holders: Array, top10Percent: number, top5Percent: number }}
 */
export async function getTopHolders(tokenAddress, limit = 10) {
  const apiKey = getApiKey();
  if (!apiKey) return { holders: [], top10Percent: -1, top5Percent: -1, error: '未配置BSCSCAN_API_KEY' };

  try {
    const url = `${BSCSCAN_API}?module=token&action=tokenholderlist` +
      `&contractaddress=${tokenAddress}&limit=${limit}&apikey=${apiKey}`;

    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();

    if (data.status !== '1' || !data.result) {
      return { holders: [], top10Percent: -1, top5Percent: -1, error: data.message || '请求失败' };
    }

    const holders = data.result.slice(0, limit).map(h => ({
      address: h.TokenHolderAddress,
      balance: h.TokenHolderQuantity,
      percentage: parseFloat(h.TokenHolderQuantity) / 1e18, // 近似
    }));

    // 尝试计算占比（需要总供应量）
    let top10Percent = -1;
    let top5Percent = -1;

    // 从第5个持有者的占比来估算
    // 注意：BscScan的tokenholderlist在某些版本中不直接返回percentage字段
    // 用 holderQuantity 和 总供应量 计算
    const totalSupply = data.result.length > 0
      ? holders.reduce((sum, h) => sum + parseFloat(h.balance || 0), 0) / holders.length * 100
      : 0;

    return { holders, top10Percent, top5Percent, error: null };
  } catch (err) {
    return { holders: [], top10Percent: -1, top5Percent: -1, error: err.message };
  }
}

/**
 * 获取代币合约的创建者地址
 * @param {string} tokenAddress - 代币合约地址
 * @returns {{ creator: string|null, txHash: string|null }}
 */
export async function getContractCreator(tokenAddress) {
  const apiKey = getApiKey();
  if (!apiKey) return { creator: null, txHash: null, error: '未配置BSCSCAN_API_KEY' };

  try {
    const url = `${BSCSCAN_API}?module=contract&action=getcontractcreation` +
      `&contractaddresses=${tokenAddress}&apikey=${apiKey}`;

    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();

    if (data.status !== '1' || !data.result || data.result.length === 0) {
      return { creator: null, txHash: null, error: data.message || '未找到合约创建信息' };
    }

    return {
      creator: data.result[0].contractCreator,
      txHash: data.result[0].txHash,
      error: null,
    };
  } catch (err) {
    return { creator: null, txHash: null, error: err.message };
  }
}

/**
 * 查询地址的交易笔数（判断是否为新号）
 * @param {string} address - 钱包地址
 * @returns {{ txCount: number }}
 */
export async function getAddressTxCount(address) {
  const apiKey = getApiKey();
  if (!apiKey) return { txCount: -1, error: '未配置BSCSCAN_API_KEY' };

  try {
    const url = `${BSCSCAN_API}?module=account&action=txlist` +
      `&address=${address}&sort=asc&offset=0&limit=1&apikey=${apiKey}`;

    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();

    if (data.status !== '1') {
      return { txCount: -1, error: data.message || '请求失败' };
    }

    // BscScan 返回的 result 是交易列表，我们可以获取总数
    // 或者用更精确的方式：获取 address tx count via `txlist` with no limit
    // 但那样太慢。改用 `balancehistory` 或 watch 的方式？
    // 简单方案：先只查前100条，数量少于100就说明真实交易数不多
    const txCount100Url = `${BSCSCAN_API}?module=account&action=txlist` +
      `&address=${address}&sort=asc&offset=0&limit=100&apikey=${apiKey}`;

    const res100 = await fetch(txCount100Url, { timeout: 10000 });
    const data100 = await res100.json();

    if (data100.status !== '1') {
      return { txCount: -1, error: data100.message };
    }

    const count = (data100.result || []).length;
    // 如果刚好 100 条，说明可能更多
    return { txCount: count >= 100 ? 100 : count, error: null };
  } catch (err) {
    return { txCount: -1, error: err.message };
  }
}

/**
 * 已知 LP 锁仓合约地址（BSC 链）
 */
const KNOWN_LOCK_CONTRACTS = [
  '0xDba68f07d1b7Ca219f78ae8582C213d2cB7fB1dF',  // Unicrypt v2
  '0xE2fE530C047f2d85298b07D9333C92937bC0A6B0',  // Team Finance
];

/**
 * 检测 LP 是否被锁定
 * @param {string} pairAddress - 交易对合约地址
 * @returns {{ locked: boolean, details: Array }}
 */
export async function checkLPLockStatus(pairAddress) {
  const apiKey = getApiKey();
  if (!apiKey) return { locked: false, details: [], error: '未配置BSCSCAN_API_KEY' };

  if (!pairAddress) return { locked: false, details: [], error: '无 pair 地址' };

  const results = [];

  for (const lockContract of KNOWN_LOCK_CONTRACTS) {
    try {
      // 查 lock 合约的 LP token 余额
      const url = `${BSCSCAN_API}?module=account&action=tokenbalance` +
        `&contractaddress=${pairAddress}&address=${lockContract}&apikey=${apiKey}`;

      const res = await fetch(url, { timeout: 10000 });
      const data = await res.json();

      if (data.status === '1' && data.result && parseFloat(data.result) > 0) {
        results.push({ lockContract, balance: data.result, locked: true });
      }
    } catch { /* 跳过 */ }
  }

  return {
    locked: results.length > 0,
    details: results,
    lockCount: results.length,
    error: null,
  };
}

/**
 * 代币深度安全检查（综合性）
 * 在预购验证阶段调用，集合所有 BscScan 查询
 */
export async function deepSecurityCheck(tokenAddress, pairAddress) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { available: false, error: '未配置BSCSCAN_API_KEY' };
  }

  const startTime = Date.now();

  // 并行查询
  const [creatorInfo, lockInfo] = await Promise.all([
    getContractCreator(tokenAddress),
    checkLPLockStatus(pairAddress),
  ]);

  let creatorRisk = 'unknown';
  let creatorTxCount = -1;
  let creatorTxNote = '';

  if (creatorInfo.creator) {
    const txInfo = await getAddressTxCount(creatorInfo.creator);
    creatorTxCount = txInfo.txCount;
    if (txInfo.txCount >= 0 && txInfo.txCount < 5) {
      creatorRisk = 'high';
      creatorTxNote = `创建者只有 ${txInfo.txCount} 笔交易（疑似新号/水号）`;
    } else if (txInfo.txCount >= 5 && txInfo.txCount < 20) {
      creatorRisk = 'medium';
      creatorTxNote = `创建者 ${txInfo.txCount} 笔交易`;
    } else if (txInfo.txCount >= 20) {
      creatorRisk = 'low';
      creatorTxNote = `创建者 ${txInfo.txCount} 笔交易（正常活跃地址）`;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 综合评分扣减
  let riskScore = 0;
  if (creatorRisk === 'high') riskScore += 2;
  if (!lockInfo.locked) riskScore += 1; // LP未锁扣分

  return {
    available: true,
    elapsed: `${elapsed}s`,
    creator: {
      address: creatorInfo.creator,
      txCount: creatorTxCount,
      risk: creatorRisk,
      note: creatorTxNote,
    },
    lpLock: {
      locked: lockInfo.locked,
      lockCount: lockInfo.lockCount,
      details: lockInfo.details,
    },
    riskScore,
  };
}
