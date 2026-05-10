/**
 * cex-logger.js — CEX 合约操作日志系统
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'data', 'cex-logs.json');
const MAX_LOGS = 2000;

function load() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch { return []; }
}

function save(logs) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch {}
}

export function appendCexLog(type, detail, extra = {}) {
  try {
    const logs = load();
    const entry = {
      time: new Date().toISOString(),
      type,
      detail: String(detail),
      ...extra,
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    save(logs);
    return entry;
  } catch {}
}

export function getCexLogs(count = 20, offset = 0) {
  const logs = load();
  const total = logs.length;
  const page = logs.slice(Math.max(0, total - offset - count), Math.max(0, total - offset)).reverse();
  return { success: true, logs: page, total, offset, count };
}
