#!/usr/bin/env python3
"""
合约交易每日盈亏分析报告
分析过去24小时的合约交易记录，计算盈亏、胜率、交易模式
数据来源: cex-logs.json (平仓事件) + risk-daily.json (风控统计) + 实时余额/持仓
"""
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

DATA_DIR = "/root/autotrade/data"
CEX_LOGS = os.path.join(DATA_DIR, "cex-logs.json")
RISK_FILE = os.path.join(DATA_DIR, "risk-daily.json")

# 中国时区 (UTC+8)
CST = timezone(timedelta(hours=8))

def load_json(path):
    if not os.path.exists(path):
        return [] if path.endswith('.json') and 'risk' not in path else {}
    try:
        with open(path) as f:
            return json.load(f)
    except:
        return [] if path.endswith('.json') and 'risk' not in path else {}

def is_in_last_24h(dt_str):
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        now = datetime.now(CST)
        return (now - dt.astimezone(CST)).total_seconds() <= 86400
    except:
        return False

def get_hour(dt_str):
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.astimezone(CST).hour
    except:
        return 0

def parse_detail(detail):
    """从明细文本中提取标的和方向"""
    symbol = "?"
    side = "?"
    if '平多' in detail or '开多' in detail:
        side = 'long'
    elif '平空' in detail or '开空' in detail:
        side = 'short'
    for part in detail.split():
        if '/' in part:
            symbol = part
    return symbol, side

def analyze_contract_trades():
    logs = load_json(CEX_LOGS)
    if not logs:
        return "📭 暂无合约交易数据"

    now = datetime.now(CST)
    today_label = now.strftime("%Y-%m-%d")

    # ===== 筛选24小时内的事件 =====
    close_events_24h = [e for e in logs
                        if e.get('type') in ('auto_close', 'manual_close')
                        and is_in_last_24h(e.get('time', ''))]
    open_events_24h = [e for e in logs
                       if e.get('type') in ('auto_open', 'manual_open')
                       and is_in_last_24h(e.get('time', ''))]
    open_fail_24h = [e for e in logs
                     if e.get('type') == 'auto_open_fail'
                     and is_in_last_24h(e.get('time', ''))]

    # ===== 统计平仓 =====
    close_with_pnl = [e for e in close_events_24h
                      if e.get('realizedPnl') is not None]
    close_no_pnl = [e for e in close_events_24h
                    if e.get('realizedPnl') is None]

    total_wins = 0
    total_losses = 0
    total_pnl = 0.0
    trade_results = []

    for e in close_with_pnl:
        pnl = e['realizedPnl']
        pnl_pct = e.get('pnlPercent', 0)
        symbol, side = parse_detail(e.get('detail', ''))
        total_pnl += pnl
        if pnl >= 0:
            total_wins += 1
        else:
            total_losses += 1
        trigger = e.get('triggerType', 'signal')
        trade_results.append({
            'time': e['time'],
            'symbol': symbol,
            'side': side,
            'pnl': pnl,
            'pnl_pct': pnl_pct,
            'trigger': trigger,
            'entry_price': e.get('entryPrice', '?'),
        })

    # 历史无PnL的平仓：从开仓记录估算
    for e in close_no_pnl:
        detail = e.get('detail', '')
        symbol, side = parse_detail(detail)
        related_open = [o for o in reversed(open_events_24h)
                        if symbol in o.get('detail', '') or symbol == '?']
        entry_price = None
        m_open = re.search(r'@\s*([\d,.]+)', related_open[0].get('detail', '')) if related_open else None
        if m_open:
            entry_price = float(m_open.group(1).replace(',', ''))

        trade_results.append({
            'time': e['time'],
            'symbol': symbol,
            'side': side,
            'pnl': 0,
            'pnl_pct': 0,
            'trigger': 'historical',
            'entry_price': entry_price,
        })

    total_trades = len(trade_results)

    # ===== 按标的分类 =====
    by_symbol = defaultdict(lambda: {'count': 0, 'pnl': 0, 'wins': 0, 'losses': 0})
    for t in trade_results:
        sym = t['symbol']
        by_symbol[sym]['count'] += 1
        by_symbol[sym]['pnl'] += t['pnl']
        if t['pnl'] > 0:
            by_symbol[sym]['wins'] += 1
        elif t['pnl'] < 0:
            by_symbol[sym]['losses'] += 1

    # ===== 按触发类型 =====
    by_trigger = defaultdict(lambda: {'count': 0, 'pnl': 0})
    for t in trade_results:
        trig = t['trigger']
        by_trigger[trig]['count'] += 1
        by_trigger[trig]['pnl'] += t['pnl']

    # ===== 时段 =====
    hourly_trades = Counter()
    for t in trade_results:
        h = get_hour(t['time'])
        hourly_trades[h] += 1

    # ===== 策略统计 =====
    strategy_starts = len([e for e in logs
                          if e.get('type') == 'strategy_start' and is_in_last_24h(e.get('time', ''))])
    strategy_stops = len([e for e in logs
                         if e.get('type') == 'strategy_stop' and is_in_last_24h(e.get('time', ''))])
    style_changes = len([e for e in logs
                        if e.get('type') == 'style_change' and is_in_last_24h(e.get('time', ''))])

    # ===== 风控统计 =====
    risk_stats = load_json(RISK_FILE)
    start_balance = risk_stats.get('startBalance', 0) if isinstance(risk_stats, dict) else 0
    current_balance = risk_stats.get('currentBalance', 0) if isinstance(risk_stats, dict) else 0
    peak_balance = risk_stats.get('peakBalance', 0) if isinstance(risk_stats, dict) else 0
    daily_pnl_from_risk = risk_stats.get('dailyPnl', 0) if isinstance(risk_stats, dict) else 0
    max_drawdown = risk_stats.get('maxDrawdown', 0) if isinstance(risk_stats, dict) else 0

    # ===== 构建报告 =====
    lines = []
    lines.append(f"📊 **OKNC 合约交易日报 — {today_label}**")
    lines.append("")

    # === 概览 ===
    if total_trades > 0:
        win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0
        lines.append("📈 **【今日交易概览】**")
        lines.append(f"  平仓: {total_trades} 笔 | 胜率: {win_rate:.1f}% ({total_wins}/{total_trades})")
        pnl_emoji = "🟢" if total_pnl >= 0 else "🔴"
        lines.append(f"  盈亏: {pnl_emoji} ${total_pnl:+.2f}")
        lines.append("")
    else:
        lines.append("📈 **【今日交易概览】**")
        lines.append("  今日无完成平仓")
        lines.append("")

    # === 余额变动 ===
    if start_balance > 0:
        pnl_str = f"{'🟢' if daily_pnl_from_risk >= 0 else '🔴'} ${daily_pnl_from_risk:+.2f}"
        pnl_pct = (daily_pnl_from_risk / start_balance) * 100 if start_balance > 0 else 0
        lines.append(f"💰 **【账户余额】**")
        lines.append(f"  期初: ${start_balance:.2f}  当前: ${current_balance:.2f}")
        lines.append(f"  日盈亏: {pnl_str} ({pnl_pct:+.2f}%)")
        if peak_balance > 0:
            lines.append(f"  日内峰值: ${peak_balance:.2f} | 最大回撤: {max_drawdown:.2f}%")
        lines.append("")

    # === 交易明细 ===
    if trade_results:
        sorted_results = sorted(trade_results, key=lambda t: t['pnl'], reverse=True)
        lines.append("📋 **【交易明细 (按盈亏排序)】**")
        trigger_labels = {
            'signal': '信号反转', 'stop_loss': '止损', 'take_profit': '止盈',
            'manual': '手动', 'historical': '历史(无PnL)',
        }
        for t in sorted_results:
            pnl_str = f"{'🟢' if t['pnl'] >= 0 else '🔴'} ${t['pnl']:+.2f}" if t['pnl'] != 0 else "⚪ $0.00"
            trig_label = trigger_labels.get(t['trigger'], t['trigger'])
            pct_str = f" ({t['pnl_pct']:+.1f}%)" if t['pnl_pct'] else ""
            lines.append(f"  {t['symbol']} {t['side']} — {pnl_str}{pct_str} [{trig_label}]")
        lines.append("")

    # === 标的分布 ===
    if by_symbol:
        lines.append("🔀 **【标的分布】**")
        for sym, data in sorted(by_symbol.items(), key=lambda x: x[1]['pnl'], reverse=True):
            emoji = '🟢' if data['pnl'] >= 0 else '🔴'
            lines.append(f"  {sym}: {emoji} ${data['pnl']:+.2f} ({data['count']}笔, {data['wins']}胜/{data['losses']}负)")
        lines.append("")

    # === 触发类型 ===
    if by_trigger:
        lines.append("🎯 **【触发类型分析】**")
        trigger_labels_full = {
            'signal': '信号反转', 'stop_loss': '止损', 'take_profit': '止盈',
            'manual': '手动', 'historical': '历史估算',
        }
        for trig, data in sorted(by_trigger.items(), key=lambda x: x[1]['pnl'], reverse=True):
            label = trigger_labels_full.get(trig, trig)
            emoji = '🟢' if data['pnl'] >= 0 else '🔴'
            lines.append(f"  {label}: {data['count']}笔 {emoji} ${data['pnl']:+.2f}")
        lines.append("")

    # === 策略状态 ===
    lines.append("⚙️ **【策略运行】**")
    if strategy_starts or strategy_stops:
        run_count = strategy_starts - strategy_stops
        status_str = "运行中" if run_count > 0 else "已停止"
        lines.append(f"  状态: {status_str} (启动{strategy_starts}次 / 停止{strategy_stops}次)")
        lines.append(f"  风格切换: {style_changes}次")
    else:
        lines.append("  今日未启动策略")
    if open_fail_24h:
        fail_msgs = Counter()
        for f in open_fail_24h:
            detail = f.get('detail', '')
            if '4164' in detail:
                fail_msgs['保证金不足($20最低)'] += 1
            else:
                fail_msgs['其他'] += 1
        lines.append(f"  ⚠️ 开仓失败: {len(open_fail_24h)}次")
        for reason, count in fail_msgs.most_common(2):
            lines.append(f"    • {reason}: {count}次")
    lines.append("")

    # === 时段 ===
    if hourly_trades:
        peak_hour = max(hourly_trades, key=hourly_trades.get)
        active_ranges = []
        sorted_hours = sorted(hourly_trades.keys())
        if sorted_hours:
            active_ranges.append(f"{min(sorted_hours):02d}:00-{max(sorted_hours):02d}:00")
        lines.append(f"🕐 **【活跃时段】** {active_ranges[0] if active_ranges else 'N/A'} | 峰值 {peak_hour}:00 ({hourly_trades[peak_hour]}笔)")
        lines.append("")

    # === 分析与建议 ===
    lines.append("💡 **【分析与建议】**")
    insights = []
    if total_trades > 0:
        win_rate = total_wins / total_trades * 100
        if win_rate >= 60:
            insights.append("✅ 胜率优秀，策略方向判断准确")
        elif win_rate >= 40:
            insights.append("⚠️ 胜率中等，建议微调止损宽度")
        else:
            insights.append("❌ 胜率偏低，建议评估策略信号或降低仓位")
        if total_pnl > 0:
            insights.append(f"✅ 今日盈利 ${total_pnl:.2f}，策略正向")
        elif total_pnl == 0:
            insights.append("📌 今日盈亏持平")
        else:
            insights.append(f"❌ 今日亏损 ${abs(total_pnl):.2f}，建议复盘亏损交易")
        if by_trigger.get('stop_loss', {}).get('count', 0) > by_trigger.get('take_profit', {}).get('count', 0):
            insights.append("⚠️ 止损次数 > 止盈，检查止损设置是否过紧")
        if by_trigger.get('signal', {}).get('count', 0) > 3:
            insights.append("📌 信号反转频繁，可能是震荡行情")
    else:
        if open_fail_24h:
            insights.append("⚠️ ETH 开仓连续失败（需≥$20名义价值），余额较小是主因")
        insights.append("💡 可回复「合约复盘」看详细数据")
    for ins in insights:
        lines.append(f"  {ins}")

    lines.append("")
    lines.append("_" * 30)
    lines.append(f"🤖 自动生成 · {now.strftime('%H:%M')} · OKNC 合约日报 v1.0")
    lines.append("💬 回复「合约复盘」深入分析")

    return "\n".join(lines)

def main():
    print(analyze_contract_trades())

if __name__ == "__main__":
    main()
