// 离线：安装时逐个缓存（不用 cache.addAll —— 它原子失败会让 SW 静默装不上，旧项目踩过），
// 取用时缓存优先，新版本激活后清旧缓存。版本号与文件表由构建脚本注入。
const VERSION = 'citi-915d31ee878e';
const FILES = ["./","dict/bridge.json","dict/decks.json","dict/veto.json","dict/words.json","engine/ac.js","engine/formats/chapters.js","engine/formats/deps.js","engine/formats/epub.js","engine/formats/html2text.js","engine/formats/index.js","engine/formats/inflate.js","engine/formats/mobi.js","engine/formats/palmdoc.js","engine/formats/sniff.js","engine/formats/zip.js","engine/gbk.js","engine/import.js","engine/parse.js","engine/replace.js","engine/scheduler.js","fonts.css","gen/sample-book.js","gen/template.js","icon-180.png","icon-512.png","index.html","manifest.webmanifest","shared/memory-model.mjs","src/app.js","src/facts.js","src/library.js","src/runtime.js","src/store.js"];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    const failed = [];
    for (const f of FILES) {
      try { const r = await fetch(f, { cache: 'no-store' }); if (r.ok) await c.put(f, r); else failed.push(f); }
      catch { failed.push(f); }
    }
    if (failed.length) throw new Error('离线缓存失败：' + failed.join(', '));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(e.request, { ignoreSearch: true });
    return hit || fetch(e.request);
  })());
});
