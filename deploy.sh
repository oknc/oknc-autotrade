#!/bin/bash
# ============================================
# OKNC 自动合约交易系统 - 一键部署脚本
# ============================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  OKNC 自动合约交易系统 - 部署脚本${NC}"
echo -e "${GREEN}============================================${NC}"

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}📦 未检测到 Node.js，正在安装...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# 安装依赖
echo -e "${YELLOW}📦 安装 npm 依赖...${NC}"
cd /root/autotrade
npm install --production

# 部署 systemd 服务
echo -e "${YELLOW}⚙️ 部署 systemd 服务...${NC}"
cp oknc-autotrade.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable oknc-autotrade

# 创建数据目录
mkdir -p /root/autotrade/data

# 启动服务
echo -e "${YELLOW}🚀 启动服务...${NC}"
systemctl restart oknc-autotrade
sleep 3

# 检查状态
if systemctl is-active --quiet oknc-autotrade; then
    echo -e "${GREEN}✅ 服务已启动！${NC}"
    echo -e "${GREEN}📊 控制面板: http://localhost:3000${NC}"
    echo -e "${YELLOW}📌 下一步:${NC}"
    echo -e "  1. 配置域名反向代理 (Nginx)"
    echo -e "  2. 配置 SSL (Certbot)"
    echo -e "  3. 在面板中启动策略引擎"
else
    echo -e "${RED}❌ 服务启动失败，请检查: journalctl -u oknc-autotrade -n 50${NC}"
fi
