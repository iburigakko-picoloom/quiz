import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { largeNoteRaw } from '../helpers/large-note-fixture.mjs';

process.env.VITE_SUPABASE_URL = 'https://materials-scope.example.test';
process.env.VITE_SUPABASE_ANON_KEY = 'fixture';
const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const server = await createServer({ server: { host: '127.0.0.1', port: 5194, strictPort: true, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const output = `tmp/note-loading-${Date.now()}`;
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.goto('http://127.0.0.1:5194/quiz/tests/browser/materials-scope-preview.html');
  await page.getByText('脳神経.pdf', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.category-note-canvas') && !document.querySelector('.category-note-save-state--saving'));
  const raw = largeNoteRaw('2026-10-14T06:00:00Z', 'other', '__material_ink_linked_linked-page');
  await page.evaluate(async raw => {
    const { annotationCategory } = await import('/quiz/src/utils/materialStorage.ts');
    const { saveCategoryNoteRaw } = await import('/quiz/src/utils/noteStorage.ts');
    const category = annotationCategory('linked', 'linked-page');
    const key = `quizMake:notes:other:${category}`;
    const parsed = JSON.parse(raw); parsed.category = category;
    window.noteRaw = JSON.stringify(parsed); window.noteKey = key;
    await saveCategoryNoteRaw(key, window.noteRaw);
    window.noteReads = [];
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (key === window.noteKey && ['categoryNotes', 'categoryNoteBackups'].includes(this.name)) window.noteReads.push(this.name);
      return get.call(this, key);
    };
  }, raw);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const start = Date.now();
  await page.getByRole('button', { name: '既存の参照先を開く', exact: true }).click();
  await page.getByText('循環器資料.pdf', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.category-note-canvas') && !document.querySelector('.category-note-save-state--saving') && !document.querySelector('.materials-content.is-page-loading'));
  const elapsedMs = Date.now() - start;
  const reads = await page.evaluate(() => window.noteReads);
  if (process.env.QUIZMAKE_NOTE_LOADING_BASELINE !== 'true') assert.deepEqual(reads, ['categoryNotes'], 'one authoritative ink read before editing');
  const pixels = await page.locator('.materials-content > .category-note-panel .category-note-canvas').evaluate(canvas => {
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(rgba).filter((value, i) => i % 4 === 3 && value > 0).length;
  });
  assert.ok(pixels > 100, 'the saved handwriting is painted');
  await page.locator('.materials-close').click();
  const retained = await page.evaluate(async () => (await import('/quiz/src/utils/noteStorage.ts')).loadCategoryNoteRaw(window.noteKey));
  assert.equal(retained, await page.evaluate(() => window.noteRaw), 'opening and closing does not rewrite handwriting');
  assert.deepEqual(errors, []);
  const report = { elapsedMs, cpuThrottle: 4, noteBytes: Buffer.byteLength(raw), reads, painted: pixels > 100, originalPreserved: true, errors };
  await writeFile(`${output}/verified.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} finally { await browser.close(); await server.close(); }
