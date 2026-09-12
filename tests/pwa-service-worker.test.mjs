import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://example.test';
const scope = `${origin}/quiz/`;

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function createWorkerHarness(fetchHandler = async () => new Response('ok')) {
  const handlers = new Map();
  const entries = new Map();
  const deletedCaches = [];
  const networkRequests = [];
  let claimed = false;

  const keyOf = (input) => {
    const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    return new URL(value, origin).href;
  };
  const cache = {
    async keys() { return [...entries.keys()].map(url=>new Request(url)); },
    async delete(input) { return entries.delete(keyOf(input)); },
    async match(input) {
      return entries.get(keyOf(input))?.clone();
    },
    async put(input, response) {
      entries.set(keyOf(input), response.clone());
    },
  };
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Set,
    crypto: globalThis.crypto,
    caches: {
      async open() {
        return cache;
      },
      async keys() {
        return ['quiz-make-cache-old', 'quiz-make-cache-build-1', 'another-app-cache', 'quiz-make-shared-images-v1'];
      },
      async delete(name) {
        deletedCaches.push(name);
        return true;
      },
    },
    async fetch(input) {
      networkRequests.push(keyOf(input));
      return fetchHandler(input);
    },
    self: {
      location: {
        href: `${scope}sw.js?v=build-1`,
        origin,
      },
      registration: { scope },
      clients: {
        async claim() {
          claimed = true;
        },
      },
      async skipWaiting() {},
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
    },
  });

  vm.runInContext(
    `${workerSource}\nglobalThis.__workerTest = { networkFirst, staleWhileRevalidate, extractBuildAssetUrls, parsePrecacheManifest, receiveSharedImage };`,
    context,
  );

  return {
    api: context.__workerTest,
    handlers,
    entries,
    deletedCaches,
    networkRequests,
    get claimed() {
      return claimed;
    },
  };
}

test('activation removes only obsolete Quiz make cache generations', async () => {
  const harness = createWorkerHarness();
  let activation;
  harness.handlers.get('activate')({
    waitUntil(promise) {
      activation = promise;
    },
  });

  await activation;

  assert.deepEqual(harness.deletedCaches, ['quiz-make-cache-old']);
  assert.equal(harness.claimed, true);
});

test('image share POST is persisted locally and redirects to confirmation, not a server', async () => {
  const h=createWorkerHarness();
  const form=new FormData();form.append('image',new Blob(['image-bytes'],{type:'image/png'}),'test.png');
  let result;
  h.handlers.get('fetch')({request:new Request(`${scope}share-image`,{method:'POST',body:form}),respondWith:p=>{result=p;}});
  const response=await result;
  assert.equal(response.status,303);
  const id=new URL(response.headers.get('location')).searchParams.get('sharedImage');
  assert.match(id,/^[a-f0-9-]{36}$/);
  assert.equal(await h.entries.get(`${scope}_shared-image/${id}`).text(),'image-bytes');
  assert.deepEqual(h.networkRequests,[]);
  const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.share_target.action,'/quiz/share-image');
  assert.equal(manifest.share_target.method,'POST');
});

test('share target rejects links, multiple files and unsupported types without fetching URLs',async()=>{
  for(const [kind,expected] of [['url','missing'],['multiple','count'],['svg','type'],['large','size']]){
    const h=createWorkerHarness();const form=new FormData();
    if(kind==='url')form.append('text','https://example.com/image');
    else {form.append('image',new Blob([kind==='large'?new Uint8Array(10_000_001):'image'],{type:kind==='svg'?'image/svg+xml':'image/png'}),'image');if(kind==='multiple')form.append('image',new Blob(['b'],{type:'image/png'}),'b.png');}
    const response=await h.api.receiveSharedImage(new Request(`${scope}share-image`,{method:'POST',body:form}));
    assert.equal(new URL(response.headers.get('location')).searchParams.get('sharedImageError'),expected);
    assert.equal(h.entries.size,0);assert.deepEqual(h.networkRequests,[]);
  }
});

test('navigation falls back to the cached app shell on an HTTP 5xx response', async () => {
  const harness = createWorkerHarness(async () => new Response('temporary failure', { status: 503 }));
  harness.entries.set(`${scope}index.html`, new Response('cached app shell', { status: 200 }));

  const response = await harness.api.networkFirst(new Request(scope));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'cached app shell');
});

test('install-time asset discovery includes only this app build assets', () => {
  const harness = createWorkerHarness();
  const urls = harness.api.extractBuildAssetUrls(`
    <link rel="stylesheet" href="/quiz/assets/index-a.css">
    <script type="module" src="/quiz/assets/index-b.js"></script>
    <link rel="icon" href="/quiz/icons/icon-192.png">
    <script src="https://third-party.test/external.js"></script>
  `);

  assert.deepEqual(
    Array.from(urls),
    [
      `${origin}/quiz/assets/index-a.css`,
      `${origin}/quiz/assets/index-b.js`,
    ],
  );
});

test('generated precache entries are resolved inside the scoped assets directory', () => {
  const harness = createWorkerHarness();
  const urls = harness.api.parsePrecacheManifest({
    version: 1,
    files: [
      'assets/index-a.js',
      'assets/QuizRunner-lazy.js',
      'assets/QuizRunner-lazy.css',
      'assets/QuizRunner-lazy.js',
    ],
  });

  assert.deepEqual(Array.from(urls), [
    `${scope}assets/index-a.js`,
    `${scope}assets/QuizRunner-lazy.js`,
    `${scope}assets/QuizRunner-lazy.css`,
  ]);
  assert.throws(
    () => harness.api.parsePrecacheManifest({ version: 1, files: ['../outside.js'] }),
    /Invalid precache manifest asset/,
  );
});

test('install precaches entry and lazy build chunks for offline navigation', async () => {
  const indexHtml = `
    <!doctype html>
    <link rel="stylesheet" href="/quiz/assets/index-a.css">
    <script type="module" src="/quiz/assets/index-b.js"></script>
  `;
  const harness = createWorkerHarness(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/quiz/index.html') return new Response(indexHtml, { status: 200 });
    if (url.pathname === '/quiz/precache-manifest.json') {
      return Response.json({
        version: 1,
        files: [
          'assets/index-a.css',
          'assets/index-b.js',
          'assets/QuizRunner-lazy.js',
          'assets/QuizRunner-lazy.css',
        ],
      });
    }
    return new Response(`asset:${url.pathname}`, { status: 200 });
  });
  let installation;
  harness.handlers.get('install')({
    waitUntil(promise) {
      installation = promise;
    },
  });

  await installation;

  assert.equal(await harness.entries.get(scope).text(), indexHtml);
  assert.equal(await harness.entries.get(`${scope}index.html`).text(), indexHtml);
  assert.equal(harness.entries.has(`${scope}assets/index-a.css`), true);
  assert.equal(harness.entries.has(`${scope}assets/index-b.js`), true);
  assert.equal(harness.entries.has(`${scope}assets/QuizRunner-lazy.js`), true);
  assert.equal(harness.entries.has(`${scope}assets/QuizRunner-lazy.css`), true);
  assert.equal(harness.entries.has(`${scope}precache-manifest.json?v=build-1`), true);
});

test('install fails atomically when a required lazy chunk cannot be cached', async () => {
  const harness = createWorkerHarness(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/quiz/index.html') return new Response('<main>QuizMake</main>', { status: 200 });
    if (url.pathname === '/quiz/precache-manifest.json') {
      return Response.json({ version: 1, files: ['assets/missing-lazy.js'] });
    }
    if (url.pathname === '/quiz/assets/missing-lazy.js') {
      return new Response('missing', { status: 404 });
    }
    return new Response('ok', { status: 200 });
  });
  let installation;
  harness.handlers.get('install')({
    waitUntil(promise) {
      installation = promise;
    },
  });

  await assert.rejects(installation, /Unable to precache .*missing-lazy\.js \(404\)/);
  assert.deepEqual(harness.deletedCaches, ['quiz-make-cache-build-1']);
});

test('cached static assets remain available when revalidation returns 5xx', async () => {
  const harness = createWorkerHarness(async () => new Response('temporary failure', { status: 502 }));
  const assetUrl = `${scope}assets/index.js`;
  harness.entries.set(assetUrl, new Response('cached asset', { status: 200 }));
  let revalidation;

  const response = await harness.api.staleWhileRevalidate({
    request: new Request(assetUrl),
    waitUntil(promise) {
      revalidation = promise;
    },
  });
  await revalidation;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'cached asset');
  assert.deepEqual(harness.networkRequests, [assetUrl]);
});

test('Vite emits a manifest covering every generated asset, including lazy chunks', { timeout: 30_000 }, () => {
  const buildDirectory = mkdtempSync(join(tmpdir(), 'quiz-make-pwa-build-'));
  const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

  try {
    execFileSync(
      process.execPath,
      [viteCli, 'build', '--outDir', buildDirectory, '--emptyOutDir'],
      { cwd: projectRoot, stdio: 'pipe' },
    );

    const manifest = JSON.parse(readFileSync(join(buildDirectory, 'precache-manifest.json'), 'utf8'));
    const generatedAssets = listFiles(join(buildDirectory, 'assets'))
      .map((fileName) => relative(buildDirectory, fileName).replaceAll('\\', '/'))
      .sort();
    const manifestAssets = [...manifest.files].sort();
    const indexHtml = readFileSync(join(buildDirectory, 'index.html'), 'utf8');
    const entryAssets = new Set(
      [...indexHtml.matchAll(/(?:src|href)=["']\/quiz\/(assets\/[^"']+)["']/g)]
        .map((match) => match[1]),
    );

    assert.equal(manifest.version, 1);
    assert.deepEqual(manifestAssets, generatedAssets);
    assert.equal(
      manifestAssets.some((fileName) => fileName.endsWith('.js') && !entryAssets.has(fileName)),
      true,
      'at least one lazy JavaScript chunk must be present in the precache manifest',
    );
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
});
