/**
 * pair-scanner.js — 链上 PancakeSwap 新交易对扫描
 *
 * 直接从 PancakeSwap Factory 合约查询最新创建的交易对
 * 比 DexScreener 关键词搜索更可靠，能发现所有新币
 */
import Web3 from 'web3';
import 'dotenv/config';

const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
const FACTORY_ADDRESS = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const FACTORY_ABI = [
  { constant: true, inputs: [], name: 'allPairsLength', outputs: [{ name: '', type: 'uint256' }], type: 'function' },
  { constant: true, inputs: [{ name: '', type: 'uint256' }], name: 'allPairs', outputs: [{ name: '', type: 'address' }], type: 'function' },
];

const PAIR_ABI = [
  { constant: true, inputs: [], name: 'token0', outputs: [{ name: '', type: 'address' }], type: 'function' },
  { constant: true, inputs: [], name: 'token1', outputs: [{ name: '', type: 'address' }], type: 'function' },
];

let web3 = null;
let factoryContract = null;
let lastKnownPairIndex = 0;
let isInitialized = false;

function ensureWeb3() {
  if (!web3) {
    web3 = new Web3(new Web3.providers.HttpProvider(BSC_RPC, { timeout: 10000 }));
    factoryContract = new web3.eth.Contract(FACTORY_ABI, FACTORY_ADDRESS);
  }
}

export async function initPairScanner() {
  try {
    ensureWeb3();
    const total = await factoryContract.methods.allPairsLength().call();
    lastKnownPairIndex = parseInt(total.toString(), 10);
    isInitialized = true;
    console.log(`[PairScanner] ✅ 初始化完成，当前总交易对: ${lastKnownPairIndex}`);
    return true;
  } catch (err) {
    console.error(`[PairScanner] ❌ 初始化失败: ${err.message}`);
    return false;
  }
}

export async function getNewTokenAddresses() {
  if (!isInitialized) {
    const ok = await initPairScanner();
    if (!ok) return [];
  }

  try {
    ensureWeb3();
    const total = parseInt((await factoryContract.methods.allPairsLength().call()).toString(), 10);

    if (total <= lastKnownPairIndex) {
      return [];
    }

    const newTokens = [];
    const startIndex = lastKnownPairIndex;
    const batchSize = Math.min(total - lastKnownPairIndex, 30);

    for (let i = 0; i < batchSize; i++) {
      const pairIndex = startIndex + i;
      try {
        const pairAddress = await factoryContract.methods.allPairs(pairIndex).call();
        const pairContract = new web3.eth.Contract(PAIR_ABI, pairAddress);
        const [token0, token1] = await Promise.all([
          pairContract.methods.token0().call(),
          pairContract.methods.token1().call(),
        ]);

        const token0Lower = token0.toLowerCase();
        const token1Lower = token1.toLowerCase();
        const wbnbLower = WBNB_ADDRESS.toLowerCase();

        if (token0Lower === wbnbLower) {
          newTokens.push(token1);
        } else if (token1Lower === wbnbLower) {
          newTokens.push(token0);
        }
      } catch (err) {
        console.error(`[PairScanner] ⚠️ 查询 pair ${pairIndex} 失败: ${err.message}`);
      }
    }

    lastKnownPairIndex = startIndex + batchSize;
    console.log(`[PairScanner] 🔍 发现 ${newTokens.length} 个新 WBNB 交易对 (index ${startIndex}-${startIndex + batchSize - 1})`);
    return newTokens;
  } catch (err) {
    console.error(`[PairScanner] ❌ 扫描失败: ${err.message}`);
    return [];
  }
}

export function resetPairScanner() {
  lastKnownPairIndex = 0;
  isInitialized = false;
  console.log('[PairScanner] 🔄 已重置');
}
