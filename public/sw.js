const CACHE_PREFIX = 'quiz-make-cache-';
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'fallback';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const BASE_URL = new URL(self.registration.scope);
const BASE_PATH = BASE_URL.pathname;
const INDEX_URL = new URL('index.html', BASE_URL).href;
const PRECACHE_MANIFEST_URL = new URL(`precache-manifest.json?v=${encodeURIComponent(BUILD_ID)}`, BASE_URL).href;
const APP_SHELL = [
  BASE_URL.href,
  INDEX_URL,
  new URL('manifest.webmanifest?v=20260829-1', BASE_URL).href,
  new URL('icons/icon-192.png?v=20260829-1', BASE_URL).href,
  new URL('icons/icon-512.png?v=20260829-1', BASE_URL).href,
  new URL('icons/maskable-512.png?v=20260829-1', BASE_URL).href,
];

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const shareUrl = new URL(request.url);
  if (request.method === 'POST' && shareUrl.origin === BASE_URL.origin && shareUrl.pathname === `${BASE_PATH}share-image`) {
    event.respondWith(receiveSharedImage(request));
    return;
  }
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === `${BASE_PATH}sw.js`) return;
  if (url.searchParams.has('_quiz_update_check')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith(BASE_PATH)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

// Separate from app-shell caches: an app update must not discard pending images.
async function receiveSharedImage(request) {
  const destination = new URL(BASE_URL);
  try {
    const form = await request.formData();
    const files = form.getAll('image').filter(value => typeof value !== 'string');
    if (files.length !== 1) throw new Error(files.length ? 'count' : 'missing');
    const file = files[0];
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('type');
    if (!file.size || file.size > 10_000_000) throw new Error('size');
    const cache = await caches.open('quiz-make-shared-images-v1');
    const keys = await cache.keys();
    for (const key of keys) {
      const response = await cache.match(key);
      if (Date.now() - Number(response?.headers.get('x-quiz-created')) > 86_400_000) await cache.delete(key);
    }
    if ((await cache.keys()).length >= 5) throw new Error('full');
    const id = crypto.randomUUID();
    await cache.put(new URL(`_shared-image/${id}`, BASE_URL).href, new Response(file, {
      headers: { 'Content-Type': file.type, 'x-quiz-created': String(Date.now()) },
    }));
    destination.searchParams.set('sharedImage', id);
  } catch (error) {
    destination.searchParams.set('sharedImageError', ['count','missing','type','size','full'].includes(error.message) ? error.message : 'storage');
  }
  return Response.redirect(destination.href, 303);
}

async function precacheAppShell() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const indexRequest = new Request(INDEX_URL, { cache: 'reload' });
    const indexResponse = await fetch(indexRequest);
    if (!indexResponse.ok) {
      throw new Error(`Unable to precache app shell (${indexResponse.status})`);
    }

    await Promise.all([
      cache.put(INDEX_URL, indexResponse.clone()),
      cache.put(BASE_URL.href, indexResponse.clone()),
    ]);

    const html = await indexResponse.text();
    const manifestResponse = await fetch(new Request(PRECACHE_MANIFEST_URL, { cache: 'reload' }));
    if (!manifestResponse.ok) {
      throw new Error(`Unable to load precache manifest (${manifestResponse.status})`);
    }

    const htmlAssetUrls = extractBuildAssetUrls(html);
    const manifestAssetUrls = parsePrecacheManifest(await manifestResponse.clone().json());
    const assetUrls = [...new Set([...htmlAssetUrls, ...manifestAssetUrls])];
    await cache.put(PRECACHE_MANIFEST_URL, manifestResponse);
    await Promise.all(assetUrls.map((url) => fetchAndCache(cache, url, true)));

    const optionalShellUrls = APP_SHELL.filter((url) => url !== BASE_URL.href && url !== INDEX_URL);
    await Promise.all(optionalShellUrls.map((url) => fetchAndCache(cache, url, false)));
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

function parsePrecacheManifest(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.files)) {
    throw new Error('Invalid precache manifest');
  }

  const urls = new Set();
  for (const fileName of value.files) {
    if (typeof fileName !== 'string' || !fileName.startsWith('assets/')) {
      throw new Error('Invalid precache manifest asset');
    }

    const url = new URL(fileName, BASE_URL);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(`${BASE_PATH}assets/`)) {
      throw new Error('Precache manifest asset is outside the app scope');
    }
    urls.add(url.href);
  }

  return [...urls];
}

function extractBuildAssetUrls(html) {
  const urls = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith(`${BASE_PATH}assets/`)) {
      urls.add(url.href);
    }
  }

  return [...urls];
}

async function fetchAndCache(cache, url, required) {
  try {
    const response = await fetch(new Request(url, { cache: 'reload' }));
    if (!response.ok) {
      if (required) throw new Error(`Unable to precache ${url} (${response.status})`);
      return;
    }
    await cache.put(url, response);
  } catch (error) {
    if (required) throw error;
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  let networkResponse;

  try {
    networkResponse = await fetch(request);
    if (networkResponse.ok) {
      await cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    if (networkResponse.status < 500) return networkResponse;
  } catch {
    // Fall through to the cached app shell.
  }

  const cachedResponse = (await cache.match(request))
    || (await cache.match(INDEX_URL))
    || (await cache.match(BASE_URL.href));
  return cachedResponse || networkResponse || Response.error();
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkRequest = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    if (response.status >= 500 && cached) return cached;
    return response;
  });

  if (cached) {
    event.waitUntil(networkRequest.catch(() => undefined));
    return cached;
  }

  try {
    return await networkRequest;
  } catch {
    return Response.error();
  }
}
