// Service Worker — Mane Frame Salon App
// v9 — Stable updates, no false positives

const CACHE_NAME = 'salon-books-v16';

// All the files our app needs to work offline
const FILES_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap',
];

// Listen for SKIP_WAITING message from the app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Install: cache all app files and skip waiting to activate immediately
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(FILES_TO_CACHE).catch(err => {
        console.log('Some cache files skipped:', err);
      });
    })
  );
  // Force the waiting service worker to become the active service worker
  self.skipWaiting();
});

// Activate: clean up old caches and take control immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  // Take control of all pages immediately (don't wait for reload)
  self.clients.claim();
});

// Fetch: Network-first for app files, cache-first for external resources
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Network-first for our app files (HTML, CSS, JS)
  if (url.origin === location.origin && 
      (url.pathname.endsWith('.html') || 
       url.pathname.endsWith('.css') || 
       url.pathname.endsWith('.js') ||
       url.pathname === '/' || 
       url.pathname === './')) {
    
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then(response => {
          // Update cache with fresh content
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed, fall back to cache
          return caches.match(event.request);
        })
    );
  } 
  // Cache-first for external resources (Firebase, fonts, etc.)
  else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      }).catch(() => {
        return caches.match('./index.html');
      })
    );
  }
});
