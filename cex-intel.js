/**
 * cex-intel.js — 市场情报系统 (v1)
 *
 * 从每日资讯中提取结构化市场情报，供策略引擎调整参数。
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEL_FILE = path.join(__dirname, 'data', 'market-intel.json');

const DEFAULT_INTEL = {
  timestamp: null,
  sentimentScore: 0,
  sentimentLabel: 'neutral',
  keyEvents: [],
  marketFactors: { macro: 'neutral', regulatory: 'neutral', narrative: '' },
  riskLevel: 'medium',
  actionableAdvice: '',
  summary: '',
  newsDate: null,
};

let currentIntel = { ...DEFAULT_INTEL };

export function loadIntel() {
  try {
    if (fs.existsSync(INTEL_FILE)) {
      currentIntel = { ...DEFAULT_INTEL, ...JSON.parse(fs.readFileSync(INTEL_FILE, 'utf-8')) };
      console.log(`[Intel] 📂 已加载情报: ${currentIntel.sentimentLabel}(${currentIntel.sentimentScore})`);
    }
  } catch (e) {
    console.log('[Intel] ⚠️ 加载失败:', e.message);
  }
  return getIntel();
}

function saveIntel() {
  try {
    const dir = path.dirname(INTEL_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INTEL_FILE, JSON.stringify(currentIntel, null, 2));
  } catch (e) {
    console.log('[Intel] ⚠️ 保存失败:', e.message);
  }
}

export function getIntel() {
  return { ...currentIntel };
}

export function getAdjustmentFactors() {
  const score = currentIntel.sentimentScore;
  const risk = currentIntel.riskLevel;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const positionMultiplier = clamp(1.0 + (score / 100) * 0.5, 0.3, 1.5);
  const signalConfirmAdjust = score < -60 ? 2 : score < -30 ? 1 : 0;
  const stopTighten = score < -60 ? 0.6 : score < -30 ? 0.75 : score < 0 ? 0.9 : 1.0;
  const leverageMultiplier = clamp(1.0 + (score / 100) * 0.4, 0.3, 1.3);
  const maxPosAdjust = risk === 'high' ? -1 : 0;

  return {
    positionMultiplier,
    signalConfirmAdjust,
    stopTighten,
    leverageMultiplier,
    maxPosAdjust,
    sentiment: currentIntel.sentimentLabel,
    sentimentScore: score,
    riskLevel: risk,
    summary: currentIntel.summary,
    actionableAdvice: currentIntel.actionableAdvice,
  };
}

export async function updateIntel(newsContent) {
  if (!newsContent || newsContent.trim().length < 50) {
    return { success: false, error: '资讯内容太短（需≥50字）' };
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { success: false, error: '未配置 DEEPSEEK_API_KEY' };
  return await callDeepSeek(newsContent, apiKey);
}

async function callDeepSeek(newsContent, apiKey) {
  const prompt = `分析以下加密市场每日资讯，提取结构化市场情报。

资讯内容：
${newsContent}

请输出JSON格式（严格按此结构，不要markdown包裹）：
{
  "sentimentScore": -100~100整数,
  "sentimentLabel": "bullish|bearish|neutral",
  "keyEvents": [
    {"asset": "BTC|ETH|整体市场|...", "impact": "positive|negative|neutral", "weight": 0.0~1.0, "description": "事件简述"}
  ],
  "marketFactors": {
    "macro": "positive|negative|neutral",
    "regulatory": "positive|negative|neutral",
    "narrative": "当前市场叙事一句话"
  },
  "riskLevel": "low|medium|high",
  "actionableAdvice": "对交易策略的操作建议（中文一句话）",
  "summary": "市场情绪总结（中文一句话）"
}`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是一个专业的加密货币市场情报分析师，擅长从新闻中提取交易信号。始终以JSON格式输出。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const content = parsed.choices?.[0]?.message?.content || '{}';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          const intel = JSON.parse(jsonMatch ? jsonMatch[0] : content);

          if (typeof intel.sentimentScore !== 'number') {
            return resolve({ success: false, error: 'JSON缺少sentimentScore', raw: content.slice(0,200) });
          }

          currentIntel = {
            timestamp: new Date().toISOString(),
            sentimentScore: Math.max(-100, Math.min(100, intel.sentimentScore)),
            sentimentLabel: ['bullish','bearish','neutral'].includes(intel.sentimentLabel) ? intel.sentimentLabel : 'neutral',
            keyEvents: (intel.keyEvents || []).slice(0,10),
            marketFactors: {
              macro: intel.marketFactors?.macro || 'neutral',
              regulatory: intel.marketFactors?.regulatory || 'neutral',
              narrative: intel.marketFactors?.narrative || '',
            },
            riskLevel: ['low','medium','high'].includes(intel.riskLevel) ? intel.riskLevel : 'medium',
            actionableAdvice: intel.actionableAdvice || '',
            summary: intel.summary || '',
            newsDate: new Date().toISOString().slice(0,10),
          };
          saveIntel();
          console.log(`[Intel] ✅ 情报更新: ${currentIntel.sentimentLabel}(${currentIntel.sentimentScore}) 风险:${currentIntel.riskLevel} | ${currentIntel.summary}`);
          resolve({ success: true, intel: getIntel() });
        } catch (e) {
          resolve({ success: false, error: `解析失败: ${e.message}`, raw: raw.slice(0,300) });
        }
      });
    });

    req.on('error', e => resolve({ success: false, error: `请求失败: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '请求超时' }); });
    req.write(body);
    req.end();
  });
}
