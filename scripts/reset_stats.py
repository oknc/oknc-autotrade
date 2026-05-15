#!/usr/bin/env python3
"""彻底清理所有胜率统计数据"""
import json, os

BASE = '/root/autotrade/data'

# 1. 清理cex-logs.json中的平仓记录
log_file = os.path.join(BASE, 'cex-logs.json')
with open(log_file, 'r') as f:
    logs = json.load(f)

before = len(logs)
close_types = ('auto_close', 'strategy_close', 'manual_close')
closes = [e for e in logs if e.get('type') in close_types]
kept = [e for e in logs if e.get('type') not in close_types]

print(f'cex-logs.json: {before}条 -> 删除{len(closes)}条平仓 -> 保留{len(kept)}条')

with open(log_file, 'w') as f:
    json.dump(kept, f, indent=2)
print('✅ cex-logs.json 已清理')

# 统计被删除的平仓
with_pnl = [c for c in closes if c.get('realizedPnl') is not None]
print(f'  被删平仓: 共{len(closes)}条, 有PnL: {len(with_pnl)}条')
if with_pnl:
    winners = sum(1 for c in with_pnl if c['realizedPnl'] >= 0)
    total_pnl = sum(c['realizedPnl'] for c in with_pnl)
    print(f'  胜:{winners} 负:{len(with_pnl)-winners} 总盈亏:${total_pnl:.2f}')

# 2. 重置risk-daily.json
daily_file = os.path.join(BASE, 'risk-daily.json')
if os.path.exists(daily_file):
    with open(daily_file, 'r') as f:
        daily = json.load(f)
    print(f'\nrisk-daily.json: wins={daily.get("wins")}, losses={daily.get("losses")}')
    daily['wins'] = 0
    daily['losses'] = 0
    daily['exchangeStats'] = {}
    daily['realizedPnl'] = 0
    daily['dailyPnl'] = 0
    daily['dailyPnlPercent'] = 0
    daily['tradeCount'] = 0
    daily['positionsClosed'] = 0
    with open(daily_file, 'w') as f:
        json.dump(daily, f, indent=2)
    print('✅ risk-daily.json 已重置 wins/losses 为0')
else:
    print('risk-daily.json 不存在，跳过')

print('\n✅ 全部清理完成！请重启服务让夏普缓存也刷新。')
