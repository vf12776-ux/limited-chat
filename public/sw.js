const CACHE_NAME = 'p2p-messenger-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-45.png',
  '/icon-54.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});