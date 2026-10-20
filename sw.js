const CACHE_NAME = 'blocktalk-shell-v27';
const BASE_URL = new URL('./', self.registration.scope);
const SHELL_ASSETS = [
    '',
    'index.html',
    'jokes.js',
    'app.js',
    'style.css',
    'logo.png',
    'BlockTalk_Message_Sent.wav',
    'Message_Recived_BlockTalk.wav',
    'BlockTalk Ringtone.mp3',
    'mixkit-hard-pop-click-2364.wav',
    'mixkit-long-pop-2358.wav',
    'manifest.json',
    'icons/blocktalk.svg'
].map(asset => new URL(asset, BASE_URL).toString());
const CACHEABLE_PATHS = new Set(SHELL_ASSETS.map(asset => new URL(asset).pathname));

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames
                    .filter(cacheName => cacheName.startsWith('blocktalk-shell-') && cacheName !== CACHE_NAME)
                    .map(cacheName => caches.delete(cacheName))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const requestUrl = new URL(request.url);
    if (request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                return await fetch(request);
            } catch (error) {
                const cachedPage = await caches.match(new URL('index.html', BASE_URL).toString());
                if (cachedPage) return cachedPage;
                throw error;
            }
        })());
        return;
    }

    if (!CACHEABLE_PATHS.has(requestUrl.pathname)) return;
    //notes Intercept requests for the known app-shell files, serving the cached copy immediately and refreshing it from the network.
    const cachePromise = caches.open(CACHE_NAME);
    const networkResponsePromise = cachePromise
        .then(cache => fetch(request)
            .then(response => {
                if (response.ok) cache.put(request, response.clone());
                return response;
            }))
        .catch(error => {
            console.warn('BlockTalk shell asset refresh failed:', error);
            return null;
        });
    event.waitUntil(networkResponsePromise.then(() => undefined));
    event.respondWith(cachePromise
        .then(cache => cache.match(request))
        .then(cachedResponse => cachedResponse || networkResponsePromise.then(response => {
            if (response) return response;
            throw new Error('BlockTalk shell asset is unavailable offline.');
        })));
});
