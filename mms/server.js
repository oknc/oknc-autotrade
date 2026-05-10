/**
 * MMS (Market Making System) — 全自动做市交易系统
 * 链上自动化刷单交易
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ success: true, status: 'running', system: 'MMS Market Making' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[MMS] Server running on port ${PORT}`);
});
