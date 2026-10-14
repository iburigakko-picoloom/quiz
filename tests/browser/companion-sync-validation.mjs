// Disposable, synthetic account only. No authentication or remote writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

process.env.VITE_SUPABASE_URL = 'https://sync-fixture.invalid';
process.env.VITE_SUPABASE_ANON_KEY = 'synthetic-public-client';
const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const server = await createServer({ server: { host: '127.0.0.1', port: 5193, strictPort: true, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = `tmp/companion-sync-${Date.now()}`;
await mkdir(output, { recursive: true });
const errors = [], results = [];
try {
  const fixtureHtml = await server.transformIndexHtml('/quiz/sync-care-fixture.html', '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>');
  for (const failChoice of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    await page.route('**/sync-care-fixture.html', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
    await page.goto('http://127.0.0.1:5193/quiz/sync-care-fixture.html');
    await page.evaluate(async failChoice => {
      const { React, createRoot } = await import('/quiz/tests/browser/companion-sync-runtime.ts');
      const { WholeConflictPanel } = await import('/quiz/src/components/WholeConflictPanel.tsx');
      const { useCompanionCare } = await import('/quiz/src/hooks/useCompanionCare.ts');
      const { saveCompanionCare, readCompanionCare } = await import('/quiz/src/utils/companionCareStorage.ts');
      const { saveAppDataAsync, createEmptyAppData, openAppDb } = await import('/quiz/src/storage.ts');
      const { bindRecordSyncConnection } = await import('/quiz/src/utils/recordSyncOutbox.ts');
      const { putWholeMeta, readWholeMeta, WHOLE_EVENT } = await import('/quiz/src/utils/wholeSyncStorage.ts');
      const { readUserEditGeneration } = await import('/quiz/src/utils/userEditGeneration.ts');
      const { setSyncInteractionProtected } = await import('/quiz/src/utils/syncInteraction.ts');
      const { SYNC_RETRY_EVENT } = await import('/quiz/src/utils/syncRequest.ts');
      await import('/quiz/src/screens/SyncScreen.css');
      await saveAppDataAsync(createEmptyAppData());
      const db = await openAppDb();
      const connection = { project: 'https://sync-fixture.invalid', userId: '11111111-1111-4111-8111-111111111111', syncId: '1'.repeat(36) };
      await bindRecordSyncConnection(db, connection);
      const logs = Array.from({ length: 41 }, (_, i) => ({ id: `browser-answer-${i}` }));
      await saveCompanionCare(logs.slice(0, 19), { visit: true, now: new Date('2026-10-13T00:00:00Z') });
      const summary = { sets: 1, questions: 1, answers: 19, plans: 0, images: 0, pdfs: 0 };
      const shown = { version: 1, connection, revision: 4, generation: await readUserEditGeneration(db), localDigest: 'a'.repeat(64), remoteDigest: 'b'.repeat(64), device: 'Mac', localDevice: 'Android', savedAt: '2026-10-14T00:05:00Z', localSavedAt: '2026-10-14T11:39:00Z', local: summary, remote: { ...summary, answers: 26 } };
      await putWholeMeta(db, 'wholeConflict', shown);
      // Reproduce a queued pre-fix home save after this comparison was cached.
      await saveCompanionCare(logs.slice(0, 19), { visit: true, now: new Date('2026-10-14T00:00:00Z') });
      const generation = await readUserEditGeneration(db);
      let retries = 0;
      window.addEventListener(SYNC_RETRY_EVENT, () => retries++);
      if (failChoice) {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, key) {
          if (this.name === 'appRecordMeta' && key === 'wholeConflict' && value.choice) throw new DOMException('fixture full', 'QuotaExceededError');
          return put.call(this, value, key);
        };
      }
      window.fixture = {
        generation,
        read: async () => ({ generation: await readUserEditGeneration(db), retries, care: readCompanionCare(), conflict: await readWholeMeta(db, 'wholeConflict', connection) }),
        finish: async () => {
          const tx = db.transaction('appRecordMeta', 'readwrite'); tx.objectStore('appRecordMeta').delete('wholeConflict');
          await new Promise(resolve => tx.oncomplete = resolve);
          window.dispatchEvent(new Event(WHOLE_EVENT));
        },
      };
      function Screen() {
        const [open, setOpen] = React.useState(true), [busy, setBusy] = React.useState(false);
        React.useLayoutEffect(() => { setSyncInteractionProtected(open || busy); }, [open, busy]);
        const care = useCompanionCare(logs, true, true);
        return React.createElement('main', { className: 'sync-screen sync-screen--simple' },
          React.createElement('output', { 'data-food': care.care?.food ?? -1 }, `ごはん ${care.care?.food ?? 0}`),
          React.createElement(WholeConflictPanel, { syncId: connection.syncId, accountId: connection.userId, open, onOpenChange: setOpen, onBusyChange: setBusy }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Screen)));
    }, failChoice);
    await page.getByRole('heading', { name: 'どちらで同期しますか？' }).waitFor().catch(async error => {
      throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${JSON.stringify(errors)}`);
    });
    await page.getByRole('radio', { name: /クラウド/ }).check();
    await page.getByRole('button', { name: 'このデータで同期', exact: true }).click();
    if (failChoice) {
      await page.getByRole('alert').filter({ hasText: '空き容量' }).waitFor();
      await page.waitForTimeout(5300);
      assert.match(await page.getByRole('alert').innerText(), /空き容量/, 'polling must not erase the failure');
      assert.equal((await page.evaluate(() => window.fixture.read())).conflict.choice, undefined);
      await page.screenshot({ path: `${output}/retry-390.png`, fullPage: true });
      await page.getByRole('button', { name: '最新の内容を確認' }).click();
      await page.waitForFunction(async () => (await window.fixture.read()).retries === 1);
    } else {
      await page.waitForFunction(async () => (await window.fixture.read()).conflict?.choice === 'remote');
      const selected = await page.evaluate(() => window.fixture.read());
      assert.equal(selected.retries, 1);
      assert.equal(selected.generation, await page.evaluate(() => window.fixture.generation), 'automatic care stays deferred');
      assert.equal(selected.care.food, 0);
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.screenshot({ path: `${output}/chosen-390.png`, fullPage: true });
      await page.evaluate(() => window.fixture.finish());
      await page.waitForFunction(async () => (await window.fixture.read()).care.food === 2);
      results.push({ deferredDuringConflict: true, staleChoiceAccepted: true, foodResumed: 2 });
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verified.json`, JSON.stringify({ results, errors, cloudWrites: 0, errorRetryVerified: true }, null, 2));
  console.log(JSON.stringify({ output, results, errors, cloudWrites: 0, errorRetryVerified: true }));
} finally { await browser.close(); await server.close(); }
