/**
 * Service Worker для Дом Палача
 * Кэширует игру для офлайн-работы.
 */
const CACHE_NAME = 'maniac-house-v1';
const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Установка — кэшируем основные файлы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(FILES_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Активация — удаляем старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Стратегия: сначала кэш, потом сеть (для офлайн-работы)
self.addEventListener('fetch', (event) => {
  // Пропускаем не-GET запросы и WebSocket-апгрейды (мультиплеер)
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/rooms')) return;
  if (event.request.url.includes('ws://') || event.request.url.includes('wss://')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // Если нет в кэше — пробуем из сети, при ошибке возвращаем index
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
