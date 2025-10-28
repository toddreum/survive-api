self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open('survive-static-v5').then(cache => cache.addAll([
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/icon.png'
  ])));
});
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});
