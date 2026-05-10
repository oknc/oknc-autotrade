#!/usr/bin/env python3
"""
每日交易盈亏分析报告
分析过去24小时的交易记录，计算盈亏、胜率、交易模式，给出改进建议
"""
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from collections import Counter

DATA_DIR = "/root/autotrade/data"
BSC_LOG = os.path.join(DATA_DIR, "log.json")
SOL_LOG = os.path.join(DATA_DIR, "sol-log.json")
POSITIONS = os.path.join(DATA_DIR, "positions.json")
DECISIONS = os.path.join(DATA_DIR, "decisions.json")

# 中国时区 (UTC+8)
CST = timezone(timedelta(hours=8))

def load_json(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            return json.load(f)
    except:
        return []

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

def analyze_trades():
    log = load_json(BSC_LOG)
    sol_log = load_json(SOL_LOG)
    positions = load_json(POSITIONS)
    decisions = load_json(DECISIONS)

    if not any([log, sol_log, positions]):
        return "📭 暂无交易数据可分析"

    now = datetime.now(CST)
    today_label = now.strftime("%Y-%m-%d")
    avg_bnb_usd = 600

    # === 已平仓(含归零) ===
    sold_positions = [p for p in positions if p.get("status") == "sold" and is_in_last_24h(p.get("sellTime", ""))]
    failed_positions = [p for p in positions if p.get("status") == "failed" and is_in_last_24h(p.get("buyTime", ""))]
    active_positions = [p for p in positions if p.get("status") not in ("sold", "failed") and is_in_last_24h(p.get("buyTime", ""))]

    total_buy_bnb = sum(p.get("buyAmountBNB", 0) for p in sold_positions + failed_positions)
    total_sell_bnb = sum(p.get("sellAmountBNB", 0) for p in sold_positions)
    rug_loss = sum(p.get("buyAmountBNB", 0) for p in failed_positions)
    total_pnl_bnb = total_sell_bnb - total_buy_bnb - rug_loss

    # 胜率
    win_trades = [p for p in sold_positions if p.get("sellAmountBNB", 0) > p.get("buyAmountBNB", 0)]
    loss_trades = [p for p in sold_positions if p.get("sellAmountBNB", 0) <= p.get("buyAmountBNB", 0)]
    loss_trades.extend(failed_positions)
    total_trades = len(sold_positions) + len(failed_positions)
    total_wins = len(win_trades)

    # === 日志 ===
    today_log = [l for l in log if is_in_last_24h(l.get("time", ""))]
    buy_log = [l for l in today_log if l.get("type") == "buy"]
    sell_log = [l for l in today_log if l.get("type") == "sell"]
    total_gas = sum(l.get("gasUsed", 0) for l in today_log)
    gas_cost_bnb = total_gas * 5e-9

    # === 决策 ===
    today_decisions = [d for d in decisions if is_in_last_24h(d.get("time", ""))]
    scan_decisions = [d for d in today_decisions if d.get("type") in ("scan", "scan_result")]
    buy_decisions = [d for d in today_decisions if d.get("type") == "buy"]
    sell_decisions = [d for d in today_decisions if d.get("type") in ("sell", "trailing_stop", "stop_loss")]
    skip_decisions = [d for d in today_decisions if d.get("type") in ("skip", "filter_out")]

    # === 交易结果明细 ===
    trade_results = []
    for p in sold_positions + failed_positions:
        buy_bnb = p.get("buyAmountBNB", 0)
        sell_bnb = p.get("sellAmountBNB", 0) if p.get("status") == "sold" else 0
        pnl = sell_bnb - buy_bnb
        pnl_pct = ((sell_bnb / buy_bnb) - 1) * 100 if buy_bnb > 0 else -100
        try:
            bt = datetime.fromisoformat(p.get("buyTime", "").replace("Z", "+00:00"))
            st = datetime.fromisoformat(p.get("sellTime", "").replace("Z", "+00:00"))
            hold_min = (st - bt).total_seconds() / 60
        except:
            hold_min = None
        trade_results.append({
            "symbol": p.get("tokenSymbol", "?")[:12],
            "pnl_bnb": pnl,
            "pnl_pct": pnl_pct,
            "hold_min": hold_min,
        })

    trade_results.sort(key=lambda t: t["pnl_bnb"], reverse=True)

    # === 持仓时间分析 ===
    hold_times = [t["hold_min"] for t in trade_results if t["hold_min"] is not None]

    # === 时段分析 ===
    hourly_trades = Counter()
    for p in sold_positions + failed_positions:
        h = get_hour(p.get("sellTime", p.get("buyTime", "")))
        hourly_trades[h] += 1

    # === 构建报告 ===
    lines = []
    lines.append(f"📊 **OKNC 每日交易简报 — {today_label}**")
    lines.append("")

    # 概览
    win_rate = total_wins / max(total_trades, 1) * 100
    lines.append("📈 **【今日概览】**")
    lines.append(f"  交易: {total_trades} 次 | 胜率: {win_rate:.1f}% ({total_wins}/{total_trades})")
    pnl_emoji = "🟢" if total_pnl_bnb >= 0 else "🔴"
    lines.append(f"  盈亏: {pnl_emoji} {total_pnl_bnb:+.6f} BNB (≈${total_pnl_bnb*avg_bnb_usd:+.2f})")
    if rug_loss > 0:
        lines.append(f"  🚫 蜜罐损失: {rug_loss:.4f} BNB ({len(failed_positions)}笔)")
    lines.append(f"  当前持仓: {len(active_positions)} 个 | Gas: {gas_cost_bnb:.6f} BNB")
    lines.append("")

    # 最佳/最差
    if trade_results:
        lines.append(f"🏆 **最佳:** {trade_results[0]['symbol']}  {trade_results[0]['pnl_bnb']:+.6f} BNB ({trade_results[0]['pnl_pct']:+.2f}%)")
        if len(trade_results) >= 2:
            lines.append(f"    #2: {trade_results[1]['symbol']}  {trade_results[1]['pnl_bnb']:+.6f} BNB ({trade_results[1]['pnl_pct']:+.2f}%)")
        if len(trade_results) >= 3:
            lines.append(f"    #3: {trade_results[2]['symbol']}  {trade_results[2]['pnl_bnb']:+.6f} BNB ({trade_results[2]['pnl_pct']:+.2f}%)")
        lines.append(f"{'😭' if trade_results[-1]['pnl_bnb'] < 0 else '👍'} **最差:** {trade_results[-1]['symbol']}  {trade_results[-1]['pnl_bnb']:+.6f} BNB ({trade_results[-1]['pnl_pct']:+.2f}%)")
        lines.append("")

    # 持仓时间
    if hold_times:
        avg_hold = sum(hold_times) / len(hold_times)
        lines.append(f"⏱️ **持仓时间:** 平均 {avg_hold:.0f}分 | 最短 {min(hold_times):.0f}分 | 最长 {max(hold_times):.0f}分")
        fast_trades = [t for t in trade_results if t["hold_min"] is not None and t["hold_min"] < 30]
        slow_trades = [t for t in trade_results if t["hold_min"] is not None and t["hold_min"] >= 30]
        if fast_trades and slow_trades:
            fast_avg = sum(t["pnl_pct"] for t in fast_trades) / len(fast_trades)
            slow_avg = sum(t["pnl_pct"] for t in slow_trades) / len(slow_trades)
            lines.append(f"  • <30分短线: {fast_avg:+.2f}% ({len(fast_trades)}笔)")
            lines.append(f"  • ≥30分中线: {slow_avg:+.2f}% ({len(slow_trades)}笔)")
        lines.append("")

    # 决策统计
    lines.append(f"📋 **决策:** 扫描 {len(scan_decisions)}次 | 买入 {len(buy_decisions)}次 | 卖出 {len(sell_decisions)}次 | 过滤 {len(skip_decisions)}次")
    lines.append("")

    # 时段
    if hourly_trades:
        peak_hour = max(hourly_trades, key=hourly_trades.get)
        lines.append(f"🕐 **活跃时段:** {peak_hour}:00最多 ({hourly_trades[peak_hour]}笔)")
        lines.append("")

    # 模式发现与改进
    lines.append("💡 **【模式与改进】**")
    insights = []
    if win_rate >= 60:
        insights.append("✅ 胜率佳，筛选策略有效")
    elif win_rate >= 40:
        insights.append("⚠️ 胜率中等，可提高买入评分门槛")
    else:
        insights.append("❌ 胜率偏低，建议加强过滤（提高 MIN_SCORE、增大流动性要求）")

    if total_pnl_bnb > 0:
        insights.append(f"✅ 今日盈利，策略正向")
    elif total_pnl_bnb <= 0:
        insights.append(f"❌ 今日亏损，复盘失败交易共性")

    if failed_positions:
        insights.append(f"🚨 {len(failed_positions)}个蜜罐/归零，确保仿真检测(simulateSell)已启用")

    if total_trades > 20:
        insights.append("⚠️ 交易频繁(>20次)，注意避免过度交易磨损利润")
    elif total_trades < 5 and len(scan_decisions) > 50:
        insights.append("💡 扫描多但交易少，可能过滤太严，适当放宽筛选条件")

    # 总结
    avg_pnl = total_pnl_bnb / max(total_trades, 1)
    avg_win = sum(t["pnl_bnb"] for t in trade_results if t["pnl_bnb"] > 0)
    avg_win_count = max(sum(1 for t in trade_results if t["pnl_bnb"] > 0), 1)
    avg_loss = sum(t["pnl_bnb"] for t in trade_results if t["pnl_bnb"] < 0)
    avg_loss_count = max(sum(1 for t in trade_results if t["pnl_bnb"] < 0), 1)
    if avg_win_count > 0 and avg_loss_count > 0:
        reward_ratio = abs(avg_win / avg_win_count) / max(abs(avg_loss / avg_loss_count), 0.0001)
        lines.append(f"📐 盈亏比: {reward_ratio:.2f}:1 (平均盈利 {avg_win/avg_win_count:.4f} / 平均亏损 {avg_loss/avg_loss_count:.4f} BNB)")

    for ins in insights:
        lines.append(f"  {ins}")

    lines.append("")
    lines.append("_" * 30)
    lines.append(f"🤖 自动生成 · {now.strftime('%H:%M')} · OKNC v2.1")
    lines.append("💬 回复「复盘」可深入分析指定时段")

    return "\n".join(lines)

def main():
    print(analyze_trades())

if __name__ == "__main__":
    main()
