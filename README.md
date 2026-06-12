![OKNC Logo](https://www.oknode.club/oknc256.png)

# OKNC AutoTrade

OKNC 自动交易系统 — BSC/EVM 链上自动交易机器人

## 功能特性

- 多链交易支持 (BSC / EVM)
- 自动代币扫描与筛选
- 基于 DexScreener 的价格监控
- 智能买入/卖出策略
- 风险控制与止损机制
- Telegram 实时通知

## 技术栈

- Node.js
- Web3.js / Ethers.js
- DexScreener API
- CCXT (中心化交易所支持)

## 目录结构

```
├── src/               # 核心代码
├── config/            # 配置文件
├── scripts/           # 启动脚本
├── logs/              # 日志文件
└── README.md          # 本文件
```

## 快速开始

```bash
# 安装依赖
npm install

# 复制配置模板
cp config/config.example.js config/config.js

# 编辑配置
vim config/config.js

# 启动机器人
npm start
```

## License

MIT
