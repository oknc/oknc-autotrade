/**
 * engine.js — PancakeSwap 自动交易引擎核心
 *
 * 功能：
 * - 从 .env 读取配置
 * - 按随机间隔自动执行 BNB↔代币 的 swap 交易
 * - 支持运行时动态调整参数
 * - 支持运行时动态切换目标代币
 * - 每笔交易记录日志
 * - 向后兼容原有 API
 */

import Web3 from 'web3';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'log.json');

// === PancakeSwap V2 Router ABI（仅需 swap 相关方法）===
const ROUTER_ABI = [
  {
    "inputs": [
      { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
      { "internalType": "address[]", "name": "path", "type": "address[]" },
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "swapExactETHForTokens",
    "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
      { "internalType": "address[]", "name": "path", "type": "address[]" },
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "swapExactTokensForETH",
    "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
,
  {
    "inputs": [
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "address[]", "name": "path", "type": "address[]" }
    ],
    "name": "getAmountsOut",
    "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
    "stateMutability": "view",
    "type": "function"
  }
];

// ERC20 ABI（仅需 balanceOf、approve、allowance）
const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      { "name": "_spender", "type": "address" },
      { "name": "_value", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "name": "", "type": "bool" }],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{ "name": "", "type": "string" }],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [
      { "name": "_owner", "type": "address" },
      { "name": "_spender", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [{ "name": "", "type": "uint256" }],
    "type": "function"
  }
];

// === 引擎状态 ===
const state = {
  running: false,           // 是否运行中
  buyEnabled: true,         // 买入开关
  sellEnabled: true,        // 卖出开关
  buyMin: 0.001,            // 买入最小 BNB
  buyMax: 0.01,             // 买入最大 BNB
  sellMin: 0.001,           // 卖出最小 BNB
  sellMax: 0.01,            // 卖出最大 BNB
  intervalMin: 30,          // 最小间隔（秒）
  intervalMax: 120,         // 最大间隔（秒）
  timerId: null,            // setTimeout 句柄
};

// 当前目标代币（运行时动态切换，覆盖 .env 中的 TOKEN_ADDRESS）
let currentTokenAddress = null;

// 持有的代币记录（地址 -> 基础信息缓存）
const heldTokensCache = new Map();

// === 初始化 Web3 和合约 ===
let web3, routerContract, tokenContract, tokenDecimals, tokenSymbol;
let account; // 钱包地址
let isInitialized = false;

/**
 * 初始化 Web3 连接和合约实例
 */
async function initEngine() {
  const rpc = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
  const privateKey = process.env.PRIVATE_KEY;
  const routerAddress = process.env.ROUTER_ADDRESS;

  if (!privateKey || privateKey.includes('你的钱包私钥')) {
    throw new Error('请先在 .env 中配置正确的 PRIVATE_KEY');
  }

  web3 = new Web3(new Web3.providers.HttpProvider(rpc));

  // 导入私钥到 web3（Web3 v4 兼容）
  const formattedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const accountObj = web3.eth.accounts.privateKeyToAccount(formattedKey);
  web3.eth.accounts.wallet.add(accountObj);
  account = accountObj.address;

  // 创建 Router 合约实例（Router 地址不变）
  routerContract = new web3.eth.Contract(ROUTER_ABI, routerAddress);

  // 如果没有设置当前 token，从 .env 读取
  if (!currentTokenAddress) {
    const tokenAddress = process.env.TOKEN_ADDRESS;
    if (tokenAddress && !tokenAddress.includes('测试代币合约')) {
      currentTokenAddress = tokenAddress;
    }
  }

  // 初始化 tokenContract
  if (currentTokenAddress) {
    await initTokenContract(currentTokenAddress);
  }

  isInitialized = true;
  console.log(`引擎初始化完成，钱包地址: ${account}`);
  console.log(`   RPC: ${rpc}`);
  if (tokenSymbol) {
    console.log(`   当前代币: ${tokenSymbol}（精度: ${tokenDecimals}）`);
  }
}

/**
 * 初始化代币合约实例
 * @param {string} tokenAddress - 代币合约地址
 */
async function initTokenContract(tokenAddress) {
  if (!web3) throw new Error('Web3 未初始化，请先调用 initEngine()');

  tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);

  try {
    tokenDecimals = await tokenContract.methods.decimals().call();
    tokenSymbol = await tokenContract.methods.symbol().call();
  } catch (err) {
    // 部分代币可能没有标准 symbol/decimals 方法
    console.warn(`获取代币信息失败: ${err.message}，使用默认值`);
    tokenDecimals = 18;
    tokenSymbol = 'TOKEN';
  }

  currentTokenAddress = tokenAddress;
}

/**
 * 运行时切换目标代币（新方法，策略引擎调用）
 * @param {string} tokenAddress - 新的代币合约地址
 */
async function setTargetToken(tokenAddress) {
  if (!web3) {
    // 引擎未初始化，直接存地址，等初始化时使用
    currentTokenAddress = tokenAddress;
    return;
  }

  // 如果目标没变，跳过
  if (currentTokenAddress && currentTokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
    return;
  }

  console.log(`🎯 切换目标代币: ${tokenAddress}`);
  await initTokenContract(tokenAddress);
  console.log(`   新代币: ${tokenSymbol}（精度: ${tokenDecimals}）`);
}

/**
 * 获取所有持有代币列表（从链上读取余额 > 0 的代币）
 * 注意：这是一个有限能力的实现——实际场景中最好是外部传入持仓列表
 * @returns {Array} [{ tokenAddress, symbol, balance }]
 */
async function getHeldTokens() {
  if (!isInitialized) return [];

  // 如果有缓存的持仓地址，检查它们的余额
  const result = [];
  for (const [addr, info] of heldTokensCache) {
    try {
      const contract = new web3.eth.Contract(ERC20_ABI, addr);
      const balanceWei = await contract.methods.balanceOf(account).call();
      const decimals = info.decimals || 18;
      const balance = Number(balanceWei) / Math.pow(10, decimals);
      if (balance > 0) {
        result.push({
          tokenAddress: addr,
          symbol: info.symbol || '?',
          balance,
          decimals,
        });
      }
    } catch {
      // 忽略单一代币查询错误
    }
  }

  return result;
}

/**
 * 注册一个代币到持仓缓存
 * @param {string} address - 代币地址
 * @param {string} symbol - 代币符号
 * @param {number} decimals - 精度
 */
function registerHeldToken(address, symbol, decimals) {
  const addr = address.toLowerCase();
  if (!heldTokensCache.has(addr)) {
    heldTokensCache.set(addr, { address, symbol, decimals });
  }
}

/**
 * 获取滑点比率（如 10 → 0.9，即最多接受 10% 滑点）
 */
function getSlippageRatio() {
  const slippage = parseInt(process.env.SLIPPAGE || '10', 10);
  return (100 - slippage) / 100;
}

/**
 * 获取当前目标代币地址
 */
function getTargetToken() {
  return currentTokenAddress || process.env.TOKEN_ADDRESS;
}

// === 核心交易函数 ===

/**
 * 买入：BNB → 代币
 * 使用 swapExactETHForTokens
 */
async function executeBuy(amountBNB) {
  if (!isInitialized) throw new Error('引擎未初始化');

  const tokenAddress = getTargetToken();
  if (!tokenAddress) throw new Error('未设置目标代币地址');

  const amountWei = web3.utils.toWei(amountBNB.toString(), 'ether');
  const minOut = 0; // 滑点由 Router 处理，我们设置 deadline 内可接受的最低值
  const path = [
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    tokenAddress,
  ];
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 分钟后过期
  const gasReserve = web3.utils.toWei('0.01', 'ether');

  // 检查 BNB 余额是否足够（保留 0.01 BNB 作为 gas 储备）
  const balance = await web3.eth.getBalance(account);
  const maxSpendable = BigInt(balance) - BigInt(gasReserve);
  if (BigInt(amountWei) > maxSpendable) {
    throw new Error(`BNB 余额不足。可用: ${web3.utils.fromWei(maxSpendable.toString(), 'ether')} BNB，需要: ${amountBNB} BNB（已保留 0.01 BNB 作 gas）`);
  }

  console.log(`买入 ${amountBNB} BNB → ${tokenSymbol}...`);

  const tx = await routerContract.methods.swapExactETHForTokens(
    minOut,
    path,
    account,
    deadline
  ).send({
    from: account,
    value: amountWei,
    gas: 300000,
    gasPrice: await web3.eth.getGasPrice(),
  });

  // 从 pair 的 Swap event 解析实际获得的代币数量
  const swapTopic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  let formattedOut = 0;
  if (tx.logs && Array.isArray(tx.logs)) {
    for (const log of tx.logs) {
      if (log.topics && log.topics[0] === swapTopic) {
        const raw = log.data.replace('0x','');
        // Pair Swap event: amount0In | amount1In | amount0Out | amount1Out (各32字节)
        const amount0Out = BigInt('0x' + raw.slice(128, 192));
        const amount1Out = BigInt('0x' + raw.slice(192, 256));
        // 选非零的那个作为输出数量
        const outWei = amount0Out > 0n ? amount0Out : amount1Out;
        formattedOut = Number(outWei) / Math.pow(10, Number(tokenDecimals));
        break;
      }
    }
  }

  if (formattedOut === 0) {
    // fallback: 代币余额差额法
    const balAfter = await tokenContract.methods.balanceOf(account).call();
    const diff = BigInt(balAfter) - BigInt(balance);
    formattedOut = Number(diff) / Math.pow(10, Number(tokenDecimals));
  }

  console.log(`买入完成! 获得 ${formattedOut} ${tokenSymbol}，tx: ${tx.transactionHash}`);

  // 注册到持仓缓存
  registerHeldToken(tokenAddress, tokenSymbol, Number(tokenDecimals));

  const actualPrice = amountBNB > 0 && formattedOut > 0
    ? (amountBNB / formattedOut) * (await getBNBPriceUSD())
    : 0;
  const result = {
    type: 'buy',
    amountIn: amountBNB,
    symbolIn: 'BNB',
    amountOut: formattedOut,
    symbolOut: tokenSymbol,
    actualPriceUSD: actualPrice,
    txHash: tx.transactionHash,
    gasUsed: Number(tx.gasUsed),
  };
  appendLog(result);
  return result;
}

/**
 * 卖出：代币 → BNB
 * 使用 swapExactTokensForETH
 */
async function executeSell(amountToken) {
  if (!isInitialized) throw new Error('引擎未初始化');

  const tokenAddress = getTargetToken();
  if (!tokenAddress) throw new Error('未设置目标代币地址');

  // 获取链上实际余额（wei），避免 JS 浮点精度问题
  const tokenBalanceRaw = BigInt(await tokenContract.methods.balanceOf(account).call());
  const amountWeiRaw = BigInt(Math.floor(amountToken * Math.pow(10, Number(tokenDecimals))));

  // 使用实际链上余额作为卖出数量，避免浮点精度导致差 1 wei 的误报
  const sellAmountWei = amountWeiRaw < tokenBalanceRaw ? amountWeiRaw : tokenBalanceRaw;

  if (tokenBalanceRaw < 1n) {
    throw new Error(`${tokenSymbol} 链上余额为0，无法卖出`);
  }

  const minOut = 0;
  const path = [
    tokenAddress,
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
  ];
  const deadline = Math.floor(Date.now() / 1000) + 60 * 5;

  // 先授权 Router 花费代币（如果之前未授权或授权不足）
  const routerAddress = process.env.ROUTER_ADDRESS;
  const allowance = await tokenContract.methods.allowance(account, routerAddress).call();
  if (BigInt(allowance) < sellAmountWei) {
    console.log(`授权 Router 花费 ${Number(sellAmountWei) / Math.pow(10, Number(tokenDecimals))} ${tokenSymbol}...`);
    await tokenContract.methods.approve(
      routerAddress,
      sellAmountWei.toString()
    ).send({
      from: account,
      gas: 60000,
      gasPrice: await web3.eth.getGasPrice(),
    });
  }

  console.log(`卖出 ${Number(sellAmountWei) / Math.pow(10, Number(tokenDecimals))} ${tokenSymbol} → BNB...`);

  const tx = await routerContract.methods.swapExactTokensForETH(
    sellAmountWei.toString(),
    minOut,
    path,
    account,
    deadline
  ).send({
    from: account,
    gas: 300000,
    gasPrice: await web3.eth.getGasPrice(),
  });

  // 从 pair 的 Swap event 解析实际获得的 WBNB 数量
  const swapTopic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  let formattedOut = '0';
  if (tx.logs && Array.isArray(tx.logs)) {
    for (const log of tx.logs) {
      if (log.topics && log.topics[0] === swapTopic) {
        const raw = log.data.replace('0x','');
        // Pair Swap event: amount0In | amount1In | amount0Out | amount1Out (各32字节)
        const amount0Out = BigInt('0x' + raw.slice(128, 192));
        const amount1Out = BigInt('0x' + raw.slice(192, 256));
        // 卖出时输出的是 WBNB，选非零那个
        const outWei = amount0Out > 0n ? amount0Out : amount1Out;
        formattedOut = web3.utils.fromWei(outWei.toString(), 'ether');
        break;
      }
    }
  }
  if (formattedOut === '0') {
    console.warn('[Engine] 未找到 Swap event，无法获取卖出数量');
  }

  console.log(`卖出完成! 获得 ${formattedOut} BNB，tx: ${tx.transactionHash}`);

  const result = {
    type: 'sell',
    amountIn: amountToken,
    symbolIn: tokenSymbol,
    amountOut: parseFloat(formattedOut),
    symbolOut: 'BNB',
    txHash: tx.transactionHash,
    gasUsed: Number(tx.gasUsed),
  };
  appendLog(result);
  return result;
}

// === 日志 ===

/**
 * 获取日志目录
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 记录一条交易日志
 */
function appendLog(entry) {
  ensureDataDir();

  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    } catch { /* 忽略解析错误 */ }
  }

  logs.push({
    ...entry,
    time: new Date().toISOString(),
  });

  // 如果超过 2000 条则强制截断到最近 2000 条
  if (logs.length > 2000) {
    logs = logs.slice(-2000);
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

/**
 * 读取最近的交易日志
 */
function getRecentLogs(count = 50, offset = 0) {
  ensureDataDir();

  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    // offset 偏移量，count 每页条数；返回最新的在前的分页数据
    const reversed = [...logs].reverse();
    const items = reversed.slice(offset, offset + count);
    return { items, total: logs.length };
  } catch {
    return { items: [], total: 0 };
  }
}

// === 自动交易循环 ===

/**
 * 随机生成一个在 [min, max] 范围内的浮点数
 */
function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * 随机决定买入还是卖出
 * 返回 { shouldBuy, amount }
 */
function decideTrade() {
  const canBuy = state.buyEnabled;
  const canSell = state.sellEnabled;

  if (!canBuy && !canSell) {
    return { shouldTrade: false, reason: '买入和卖出均已禁用' };
  }

  let shouldBuy;
  if (canBuy && !canSell) {
    shouldBuy = true;
  } else if (!canBuy && canSell) {
    shouldBuy = false;
  } else {
    // 两者都启用，随机选择
    shouldBuy = Math.random() > 0.5;
  }

  const amount = shouldBuy
    ? randomInRange(state.buyMin, state.buyMax)
    : randomInRange(state.sellMin, state.sellMax);

  return { shouldTrade: true, shouldBuy, amount };
}

/**
 * 执行单次交易循环
 */
async function tradeLoop() {
  if (!state.running) return;

  try {
    const decision = decideTrade();

    if (!decision.shouldTrade) {
      console.log('当前交易方向均被禁用，等待下次轮询');
      scheduleNext();
      return;
    }

    let result;
    if (decision.shouldBuy) {
      result = await executeBuy(decision.amount);
    } else {
      result = await executeSell(decision.amount);
    }

    if (result) {
      appendLog(result);
    }
  } catch (err) {
    console.error(`交易失败: ${err.message}`);
    appendLog({
      type: 'error',
      error: err.message,
    });
  }

  scheduleNext();
}

/**
 * 调度下一次交易
 */
function scheduleNext() {
  if (!state.running) return;

  const delay = randomInRange(state.intervalMin, state.intervalMax) * 1000;
  console.log(`下次交易将在 ${Math.round(delay / 1000)} 秒后执行`);

  state.timerId = setTimeout(() => {
    tradeLoop().catch(err => {
      console.error(`循环异常: ${err.message}`);
      scheduleNext(); // 出错也要继续
    });
  }, delay);
}

/**
 * 启动自动交易
 */
function startEngine(settings) {
  if (state.running) {
    throw new Error('引擎已在运行中');
  }

  // 更新设置
  if (settings) {
    Object.assign(state, settings);
  }

  state.running = true;
  console.log('自动交易引擎已启动');

  // 立即执行第一笔
  tradeLoop().catch(err => {
    console.error(`首次交易异常: ${err.message}`);
    scheduleNext();
  });
}

/**
 * 停止自动交易
 */
function stopEngine() {
  state.running = false;
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  console.log('自动交易引擎已停止');
}

/**
 * 获取当前状态
 */
function getStatus() {
  return {
    running: state.running,
    buyEnabled: state.buyEnabled,
    sellEnabled: state.sellEnabled,
    buyMin: state.buyMin,
    buyMax: state.buyMax,
    sellMin: state.sellMin,
    sellMax: state.sellMax,
    intervalMin: state.intervalMin,
    intervalMax: state.intervalMax,
  };
}

/**
 * 更新设置
 */
function updateSettings(settings) {
  const allowed = ['buyEnabled', 'sellEnabled', 'buyMin', 'buyMax', 'sellMin', 'sellMax', 'intervalMin', 'intervalMax'];
  for (const key of allowed) {
    if (settings[key] !== undefined) {
      state[key] = settings[key];
    }
  }
}

/**
 * 获取钱包余额
 */
// BSC 主网常用代币合约
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'; // BSC 上的 USDT

/**
 * 获取钱包地址
 */
function getWalletAddress() {
  return account || null;
}

async function getBalances() {
  if (!isInitialized) return { bnb: 0, usdt: 0, token: 0, tokenSymbol: '?' };

  const bnbWei = await web3.eth.getBalance(account);
  const bnb = parseFloat(web3.utils.fromWei(bnbWei, 'ether'));

  // USDT 余额（BEP20）
  let usdt = 0;
  try {
    const usdtContract = new web3.eth.Contract(ERC20_ABI, USDT_ADDRESS);
    const usdtWei = await usdtContract.methods.balanceOf(account).call();
    const usdtDecimals = 18; // USDT BSC 精度为 18
    usdt = Number(usdtWei) / Math.pow(10, usdtDecimals);
  } catch { /* USDT 读取失败忽略 */ }

  // 交易代币余额
  let token = 0;
  let sym = tokenSymbol || '?';
  try {
    if (tokenContract) {
      const tokenAddress = getTargetToken();
      if (tokenAddress) {
        // 确保 tokenContract 指向正确的代币
        const tokenWei = await tokenContract.methods.balanceOf(account).call();
        token = Number(tokenWei) / Math.pow(10, Number(tokenDecimals));
      }
    }
  } catch { /* 忽略 */ }

  return { bnb, usdt, token, tokenSymbol: sym };
}

/**
 * 获取指定钱包地址的多代币余额
 * @param {string} walletAddress - 钱包地址
 * @param {Array<string>} tokenAddresses - 代币合约地址列表（含 USDT 和 WBNB 等）
 * @returns {Promise<Array>} [{ tokenAddress, symbol, balance, decimals }]
 */
async function getBalancesForWallet(walletAddress, tokenAddresses = []) {
  if (!web3) throw new Error('Web3 未初始化');

  const results = [];

  // 1. BNB 余额
  const bnbWei = await web3.eth.getBalance(walletAddress);
  results.push({
    tokenAddress: '0x0000000000000000000000000000000000000000',
    symbol: 'BNB',
    balance: parseFloat(web3.utils.fromWei(bnbWei, 'ether')),
    decimals: 18,
  });

  // 2. 查询 USDT
  try {
    const usdtContract = new web3.eth.Contract(ERC20_ABI, USDT_ADDRESS);
    const usdtWei = await usdtContract.methods.balanceOf(walletAddress).call();
    results.push({
      tokenAddress: USDT_ADDRESS,
      symbol: 'USDT',
      balance: Number(usdtWei) / Math.pow(10, 18),
      decimals: 18,
    });
  } catch {}

  // 3. 查询指定代币
  for (const addr of tokenAddresses) {
    const lower = addr.toLowerCase();
    // 跳过已查询的
    if (lower === USDT_ADDRESS.toLowerCase() || lower === '0x0000000000000000000000000000000000000000') continue;
    try {
      const contract = new web3.eth.Contract(ERC20_ABI, addr);
      let decimals = 18;
      let symbol = '?';
      try {
        decimals = Number(await contract.methods.decimals().call());
        symbol = await contract.methods.symbol().call();
      } catch {}
      const balanceWei = await contract.methods.balanceOf(walletAddress).call();
      results.push({
        tokenAddress: addr,
        symbol,
        balance: Number(balanceWei) / Math.pow(10, decimals),
        decimals,
      });
    } catch (err) {
      results.push({
        tokenAddress: addr,
        symbol: '?',
        balance: 0,
        decimals: 18,
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * 重新初始化引擎（切换钱包时使用）
 * @param {string} privateKey - 新私钥
 */
async function reinitEngine(privateKey) {
  const rpc = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
  const routerAddress = process.env.ROUTER_ADDRESS;

  if (!privateKey) throw new Error('未提供私钥');

  web3 = new Web3(new Web3.providers.HttpProvider(rpc));

  const formattedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const accountObj = web3.eth.accounts.privateKeyToAccount(formattedKey);
  web3.eth.accounts.wallet.add(accountObj);
  account = accountObj.address;

  routerContract = new web3.eth.Contract(ROUTER_ABI, routerAddress);

  // 重新初始化当前目标代币合约
  if (currentTokenAddress) {
    await initTokenContract(currentTokenAddress);
  }

  isInitialized = true;
  console.log(`[Engine] 🔄 已切换到钱包: ${account}`);
}

/**
 * 清仓 - 按比例卖出代币
 * @param {number} percent 1-100
 */
async function executeClear(percent) {
  if (!isInitialized) throw new Error('引擎未初始化');

  if (percent <= 0 || percent > 100) {
    throw new Error('百分比范围 1-100');
  }

  const sym = tokenSymbol || 'TOKEN';
  console.log(`执行清仓! 卖出 ${percent}% 的 ${sym}`);

  const tokenWei = await tokenContract.methods.balanceOf(account).call();
  const tokenBalance = Number(tokenWei) / Math.pow(10, Number(tokenDecimals));

  if (tokenBalance <= 0) {
    throw new Error('代币余额为 0，无需清仓');
  }

  const sellAmount = tokenBalance * (percent / 100);
  return await executeSell(sellAmount);
}



/**
 * 获取代币价格（BNB 计价）
 */
async function getBNBPriceUSD() {
  if (!routerContract || !web3) return 0;
  try {
    const oneBNB = web3.utils.toWei("1", "ether");
    const usdtPath = [
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      "0x55d398326f99059fF775485246999027B3197955",
    ];
    const usdtAmounts = await routerContract.methods.getAmountsOut(oneBNB, usdtPath).call();
    return Number(usdtAmounts[1]) / 1e18;
  } catch {
    return 0;
  }
}

async function getTokenPrice(tokenAddress) {
  if (!routerContract || !web3) return null;
  try {
    const oneBNB = web3.utils.toWei("1", "ether");
    // 获取 BNB/USDT 价格
    const usdtPath = [
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      "0x55d398326f99059fF775485246999027B3197955",
    ];
    const usdtAmounts = await routerContract.methods.getAmountsOut(oneBNB, usdtPath).call();
    const bnbPriceUSD = Number(usdtAmounts[1]) / 1e18;
    // 获取代币/BNB 价格
    const path = [
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      tokenAddress,
    ];
    const amounts = await routerContract.methods.getAmountsOut(oneBNB, path).call();
    const tokensPerBNB = Number(amounts[1]) / 1e18;
    if (tokensPerBNB <= 0) return null;
    return bnbPriceUSD / tokensPerBNB;
  } catch {
    return null;
  }
}

// === 导出 ===
export {
  initEngine,
  startEngine,
  stopEngine,
  getStatus,
  updateSettings,
  getBalances,
  getBalancesForWallet,
  reinitEngine,
  getRecentLogs,
  appendLog,
  executeClear,
  executeBuy,
  executeSell,
  setTargetToken,
  getHeldTokens,
  getTargetToken,
  registerHeldToken,
  getWalletAddress,
  getTokenPrice,
  isInitialized,
};

// ============ 代币税费检测 ============

/**
 * 检测代币的买卖税费 — 通过读取链上合约的税相关函数
 * @param {string} tokenAddress - 代币合约地址
 * @returns {{ buyTax: number, sellTax: number, detected: boolean }}
 */
export async function checkTokenTax(tokenAddress) {
  if (!web3) {
    throw new Error('Web3 未初始化');
  }

  const cheatsheet = {
    // 常见税费相关函数名 + 返回值处理
    // 部分token用 view 函数返回百分比（1% = 100 或 10000，取决于精度）
  };

  const TAX_FUNCTIONS = [
    'buyFee', 'sellFee',
    '_buyTax', '_sellTax',
    'buyTax', 'sellTax',
    'taxFee',
    '_taxFee',
    '_buyTaxFee', '_sellTaxFee',
    'liquidityFee',
    '_liquidityFee',
    'marketingFee',
    '_marketingFee',
    'burnFee',
    '_burnFee',
    'totalFee',
    'feeOnTransfer',
    'transferTaxRate',
    'sellFeeRate',
    'buyFeeRate',
    'maxBuyTax', 'maxSellTax',
  ];

  const TOKEN_ABI_SLIM = [
    {
      "constant": true,
      "inputs": [],
      "name": "symbol",
      "outputs": [{ "name": "", "type": "string" }],
      "type": "function"
    },
    // 添加所有税费相关的ABI
    ...TAX_FUNCTIONS.map(name => ({
      "constant": true,
      "inputs": [],
      "name": name,
      "outputs": [{ "type": "uint256" }],
      "type": "function"
    })),
  ];

  const taxContract = new web3.eth.Contract(TOKEN_ABI_SLIM, tokenAddress);

  let buyTax = 0;
  let sellTax = 0;
  let detected = false;

  for (const funcName of TAX_FUNCTIONS) {
    try {
      const result = await taxContract.methods[funcName]().call({ timeout: 3000 });
      if (result && parseInt(result) > 0) {
        const raw = parseInt(result);
        // 费率常见精度：2位(1%=100) 或 4位(1%=10000)
        // 按最常见的两种情况尝试
        let pct = 0;
        if (raw > 10000) {
          // 可能是 1%=10000 的大精度
          pct = raw / 10000;
        } else if (raw > 100) {
          // 可能是 1%=10000 或 1%=100
          pct = raw / 1000; // 尝试中精度
          if (pct > 50) pct = raw / 100; // 果然太大，用 1%=100
        } else if (raw > 0 && raw <= 100) {
          pct = raw;
          if (pct > 50) pct = raw / 100; // 超过50%则尝试除法
        }

        // 根据函数名分类
        const lower = funcName.toLowerCase();
        if (lower.includes('buy') || lower.includes('in')) {
          buyTax = Math.max(buyTax, pct);
        } else if (lower.includes('sell') || lower.includes('out')) {
          sellTax = Math.max(sellTax, pct);
        } else if (lower.includes('total') || lower.includes('fee') || lower.includes('tax')) {
          // 通用税费，同时设置买和卖
          buyTax = Math.max(buyTax, pct);
          sellTax = Math.max(sellTax, pct);
        }
        detected = true;

        console.log(`  [TaxCheck] ${funcName} = ${raw} => ${pct.toFixed(2)}%`);
      }
    } catch {
      // 这个函数不存在或调用失败，跳过
    }
  }

  // 通过 getAmountsOut 对比来验证
  try {
    // 获取代币精度
    let decimals = 18;
    try { decimals = parseInt(await taxContract.methods.decimals().call()); } catch {}

    // 获取代币余额（如果有的话）
    const isCurrentToken = currentTokenAddress &&
      currentTokenAddress.toLowerCase() === tokenAddress.toLowerCase();

    // 用 0.001 BNB 测预估买入量
    const testBNB = web3.utils.toWei('0.001', 'ether');
    const path = [
      '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
      tokenAddress,
    ];

    try {
      const amountsOut = await routerContract.methods.getAmountsOut(testBNB, path).call();
      const expectedTokens = BigInt(amountsOut[1]);
      // 检查预期输出是否有效
      if (expectedTokens > 0) {
        console.log(`  [TaxCheck] getAmountsOut 0.001BNB ≈ ${(Number(expectedTokens) / 10 ** decimals).toFixed(6)} tokens`);
      }
    } catch (err) {
      console.log(`  [TaxCheck] getAmountsOut 调用失败: ${err.message}`);
    }
  } catch { /* 静默 */ }

  return {
    buyTax,
    sellTax,
    maxTax: Math.max(buyTax, sellTax),
    detected,
    totalFee: buyTax + sellTax,
  };
}

// ============ 链上卖出仿真检测（卖是蜜罐？）============
//
// 原理：
// 1. 先用 getAmountsOut 估算在 PancakeSwap 卖掉这些币能拿回多少 BNB
// 2. 再用 eth_call 尝试仿真卖出，如果 revert 说明是蜜罐
// 3. 由于 eth_call 会检查余额，我们用 state override 技术"伪造"持有代币
// 4. 对比预期输出和实际输出 → 计算有效卖税
//
// 对于不支持 state override 的场景，回退到读取合约卖税变量（checkTokenTax）

export async function simulateSell(tokenAddress, amountBNB = 0.001) {
  if (!web3 || !routerContract || !account) {
    return { isHoneypot: true, sellTaxPct: 100, error: 'Web3 未初始化' };
  }

  try {
    // 1. 读取代币精度
    let decimals = 18;
    try {
      const tempContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
      decimals = parseInt(await tempContract.methods.decimals().call());
    } catch {}
    
    // 2. 估算买入量：amountBNB BNB 能买多少代币
    const buyPath = [WBNB, tokenAddress];
    const buyAmountWei = web3.utils.toWei(String(amountBNB), 'ether');
    let expectedTokensWei;
    try {
      const amounts = await routerContract.methods.getAmountsOut(buyAmountWei, buyPath).call();
      expectedTokensWei = amounts[1];
    } catch (e) {
      return { isHoneypot: true, sellTaxPct: 100, error: '买入估算失败: ' + e.message };
    }
    
    if (!expectedTokensWei || BigInt(expectedTokensWei) <= 0n) {
      return { isHoneypot: true, sellTaxPct: 100, error: '买入估算返回0' };
    }

    // 3. 估算卖出这些代币能拿回多少 BNB（不含卖税的理想值）
    const sellPath = [tokenAddress, WBNB];
    let expectedSellWei = '0';
    try {
      const amounts = await routerContract.methods.getAmountsOut(expectedTokensWei, sellPath).call();
      expectedSellWei = amounts[1];
    } catch (e) {
      return { isHoneypot: true, sellTaxPct: 100, error: '卖出估算失败: ' + e.message };
    }

    // 4. 尝试 eth_call 仿真卖出（需要 state override 来绕过余额检查）
    const routerAddress = process.env.ROUTER_ADDRESS;
    const sellData = routerContract.methods.swapExactTokensForETH(
      expectedTokensWei.toString(),
      0,
      sellPath,
      account,
      Math.floor(Date.now() / 1000) + 120
    ).encodeABI();

    let simulatedSellWei = '0';
    let stateOverrideFailed = false;
    try {
      // 计算 balanceOf[account] 的存储槽（OpenZeppelin 标准布局）
      const balanceSlot = web3.utils.soliditySha3(
        { t: 'address', v: account },
        { t: 'uint256', v: 0 }
      );
      // 计算 allowance[account][router] 的存储槽
      const allowanceInner = web3.utils.soliditySha3(
        { t: 'address', v: routerAddress },
        { t: 'uint256', v: 0 }
      );
      const allowanceSlot = web3.utils.soliditySha3(
        { t: 'address', v: account },
        { t: 'bytes32', v: allowanceInner }
      );
      
      const stateOverride = {
        [tokenAddress.toLowerCase()]: {
          state: {
            [balanceSlot]: web3.utils.padLeft(expectedTokensWei.toString(16), 64),
            [allowanceSlot]: web3.utils.padLeft(expectedTokensWei.toString(16), 64),
          }
        }
      };
      
      const callResult = await web3.eth.call(
        { from: account, to: routerAddress, data: sellData },
        'latest',
        stateOverride
      );
      
      const decoded = web3.eth.abi.decodeParameters(['uint256[]'], callResult);
      if (decoded && decoded[0] && decoded[0].length >= 2) {
        simulatedSellWei = decoded[0][1];
      }
    } catch {
      stateOverrideFailed = true;
    }

    let sellTaxPct = 0;
    
    if (stateOverrideFailed || (BigInt(simulatedSellWei) <= 0n && BigInt(expectedSellWei) > 0n)) {
      // state override 失败了，回退到 checkTokenTax 读取合约变量
      console.log('  [SimulateSell] stateOverride 失败，回退到合约变量读取');
      try {
        const taxInfo = await checkTokenTax(tokenAddress);
        sellTaxPct = taxInfo.sellTax || taxInfo.maxTax || 0;
      } catch {
        sellTaxPct = 50;
      }
    } else if (BigInt(expectedSellWei) > 0n) {
      const diff = BigInt(expectedSellWei) - BigInt(simulatedSellWei);
      sellTaxPct = Number(diff * 10000n / BigInt(expectedSellWei)) / 100;
    }

    const isHoneypot = sellTaxPct > 90 || sellTaxPct < 0;

    console.log('  [SimulateSell] 预期:' + web3.utils.fromWei(expectedSellWei, 'ether') + ' BNB, 仿真:' + web3.utils.fromWei(simulatedSellWei || '0', 'ether') + ' BNB, 卖税:' + sellTaxPct.toFixed(2) + '%, 蜜罐:' + isHoneypot);

    return { isHoneypot, sellTaxPct, expectedSellWei, simulatedSellWei };
  } catch (err) {
    console.warn('  [SimulateSell] 异常: ' + err.message);
    try {
      const taxInfo = await checkTokenTax(tokenAddress);
      return { isHoneypot: taxInfo.sellTax > 90, sellTaxPct: taxInfo.sellTax, fallback: true };
    } catch {
      return { isHoneypot: false, sellTaxPct: 0, error: '异常+回退失败: ' + err.message };
    }
  }
}



// ============ 链上仿真交易检测（蜜罐/高税费）============

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

/**
 * 仿真买入 — 用 eth_call 模拟实际 swap，不发送真实交易
 * 检测：蜜罐（交易会 revert）、高买税（输出远低于预期）
 * @param {string} tokenAddress - 代币合约地址
 * @param {number} amountBNB - 模拟买入的 BNB 数量
 * @returns {{ isHoneypot: boolean, buyTaxPct: number, expectedOut: string, simulatedOut: string, gasEstimate: number }}
 */
export async function simulateBuy(tokenAddress, amountBNB = 0.001) {
  if (!web3 || !routerContract || !account) {
    return { isHoneypot: true, buyTaxPct: 100, error: 'Web3 未初始化' };
  }

  try {
    const amountIn = web3.utils.toWei(String(amountBNB), 'ether');
    const path = [WBNB, tokenAddress];
    const deadline = Math.floor(Date.now() / 1000) + 120;

    // 1. 用 getAmountsOut 获取预期输出（不含代币税）
    let expectedOut = '0';
    try {
      const amounts = await routerContract.methods.getAmountsOut(amountIn, path).call();
      expectedOut = amounts[1];
    } catch (e) {
      return { isHoneypot: true, buyTaxPct: 100, expectedOut: '0', simulatedOut: '0', error: `getAmountsOut 失败: ${e.message}` };
    }

    if (expectedOut === '0' || BigInt(expectedOut) <= 0n) {
      return { isHoneypot: true, buyTaxPct: 100, expectedOut, simulatedOut: '0', error: 'getAmountsOut 返回 0' };
    }

    // 2. 构造 swap 调用数据
    const swapData = routerContract.methods.swapExactETHForTokens(
      0, // amountOutMin = 0 以通过仿真
      path,
      account,
      deadline
    ).encodeABI();

    // 3. 用 estimateGas 检测是否可交易（蜜罐会 revert）
    let gasEstimate = 0;
    try {
      gasEstimate = await web3.eth.estimateGas({
        from: account,
        to: process.env.ROUTER_ADDRESS,
        data: swapData,
        value: amountIn,
      });
    } catch (e) {
      return { isHoneypot: true, buyTaxPct: 100, expectedOut, simulatedOut: '0', error: `仿真交易 revert: ${e.message}` };
    }

    // 4. 用 eth_call 获取实际输出量（模拟 swap 返回的 amountOut）
    let simulatedOut = '0';
    try {
      const callResult = await web3.eth.call({
        from: account,
        to: process.env.ROUTER_ADDRESS,
        data: swapData,
        value: amountIn,
      });
      // swapExactETHForTokens 返回 uint256[]
      const decoded = web3.eth.abi.decodeParameters(['uint256[]'], callResult);
      if (decoded && decoded[0] && decoded[0].length >= 2) {
        simulatedOut = decoded[0][1];
      }
    } catch {
      // 如果 call 失败但 gas estimate 成功，可能是返回值解析问题
      simulatedOut = expectedOut; // 保守估计，用预期值
    }

    // 5. 计算有效买税
    const expectedBig = BigInt(expectedOut);
    const simulatedBig = BigInt(simulatedOut);
    let buyTaxPct = 0;
    if (expectedBig > 0n && simulatedBig < expectedBig) {
      const diff = expectedBig - simulatedBig;
      buyTaxPct = Number(diff * 10000n / expectedBig) / 100; // 保留 2 位小数
    }

    const isHoneypot = buyTaxPct > 90; // 买税 > 90% 视为蜜罐

    console.log(`  [SimulateBuy] 期望输出: ${expectedBig.toString()}, 仿真输出: ${simulatedBig.toString()}, 有效买税: ${buyTaxPct.toFixed(2)}%`);

    return { isHoneypot, buyTaxPct, expectedOut, simulatedOut, gasEstimate };
  } catch (err) {
    return { isHoneypot: true, buyTaxPct: 100, error: `仿真异常: ${err.message}` };
  }
}
