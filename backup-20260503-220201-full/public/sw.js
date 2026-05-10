/* OKNC全链自动交易系统 — Service Worker v1.1 */
const CACHE = 'oknc-trade-v3';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/contract.html',
  '/contract'
];

/* 安装：预缓存静态资源 */
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS))
  );
});

/* 激活：清理旧缓存 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* 拦截请求：网络优先，兜底缓存 */
self.addEventListener('fetch', e => {
  const req = e.request;

  // 只拦截 GET 请求
  if (req.method !== 'GET') return;

  // API 请求不缓存（数据总是最新的）
  if (req.url.includes('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // 静态资源：网络优先 -> 缓存兜底
  e.respondWith(
    fetch(req)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return res;
      })
      .catch(() => caches.match(req).then(m => m || new Response('Offline', { status: 503 })))
  );
});
