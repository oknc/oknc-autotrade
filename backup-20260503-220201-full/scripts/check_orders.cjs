const fs = require('fs');
const crypto = require('crypto');

const ENCRYPTION_KEY = crypto.createHash('sha256').update('oknc-cex-engine-v1').digest('hex').slice(0, 32);
const configs = JSON.parse(fs.readFileSync('/root/autotrade/data/exchange-keys.json', 'utf8'));

function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function req(endpoint, params = {}) {
  const apiKey = decrypt(configs[0].apiKey);
  const secret = decrypt(configs[0].secret);
  params.timestamp = Date.now();
  params.recvWindow = 50000;
  const q = Object.keys(params).map(k => k + '=' + params[k]).join('&');
  const sig = crypto.createHmac('sha256', secret).update(q).digest('hex');
  const url = 'https://fapi.binance.com' + endpoint + '?' + q + '&signature=' + sig;
  const r = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  return r.json();
}

(async () => {
  const types = ['STOP','STOP_MARKET','TAKE_PROFIT','TAKE_PROFIT_MARKET','STOP_LOSS_LIMIT','TAKE_PROFIT_LIMIT'];
  const oneDayAgo = Date.now() - 86400000;

  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const all = await req('/fapi/v1/allOrders', { symbol: sym, limit: 200 });
    if (!Array.isArray(all)) { console.log(sym + ' Error:', JSON.stringify(all).slice(0,200)); continue; }
    console.log('=== ' + sym + ' 全部订单 (' + all.length + '条) ===');
    const stops = all.filter(o => types.includes(o.type));
    console.log('止盈止损: ' + stops.length + '条');
    stops.forEach(o => console.log('  ' + new Date(o.time).toISOString() + ' ' + o.type + ' ' + o.side + ' ' + o.origQty + '张 价$' + o.price + ' 触发$' + (o.stopPrice||'-') + ' ' + o.status));

    const recent = all.filter(o => o.time > oneDayAgo);
    console.log('\n最近24h全部:');
    recent.forEach(o => console.log('  ' + new Date(o.time).toISOString().slice(11,19) + ' ' + o.type.padEnd(20) + ' ' + o.side.padEnd(4) + ' ' + o.origQty.padStart(8) + '张 价$' + (o.price||'-').padStart(10) + ' 触发$' + (o.stopPrice||'-').padStart(10) + ' ' + o.status));
    console.log();
  }
})();
