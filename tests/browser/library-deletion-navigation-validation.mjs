import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const server = await createServer({ server: { host: '127.0.0.1', port: 5197, strictPort: true, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.route('https://**/*', route => route.abort());
  await page.goto('http://127.0.0.1:5197/quiz/tests/browser/companion-care-preview.html?answers=0');
  await page.locator('.quiz-home__folder-main').waitFor();
  await page.evaluate(async () => {
    const storage = await import('/quiz/src/storage.ts');
    const data = await storage.loadAppDataAsync();
    const stamp = new Date().toISOString();
    data.folders.push({ id: 'child', name: '子フォルダ', parentFolderId: 'f', createdAt: stamp, updatedAt: stamp });
    data.problemSets.push({ ...data.problemSets[0], id: 'remaining', title: '残す問題セット' });
    if (!await storage.saveAppDataAsync(data)) throw new Error('fixture save failed');
  });
  await page.reload();
  await page.locator('.quiz-home__folder-main').click();
  await page.getByRole('button', { name: '確認クイズの操作', exact: true }).click();
  await page.getByRole('button', { name: '削除', exact: true }).click();
  // Hold the actual persistence lock so the UI is tested while deletion is
  // definitely pending, regardless of the machine's storage speed.
  await page.evaluate(() => {
    window.deletionLockHeld = false;
    void navigator.locks.request('quiz-make-origin-data-v1', () => new Promise(resolve => {
      window.releaseDeletionLock = resolve;
      window.deletionLockHeld = true;
    }));
  });
  await page.waitForFunction(() => window.deletionLockHeld);
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '問題セットを削除しています' }).waitFor();
  assert.equal(await page.getByText('確認クイズ', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '残す問題セットの操作', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: /子フォルダ.*0セット/ }).click();
  assert.equal(await page.getByRole('button', { name: /子フォルダ.*0セット/ }).getAttribute('aria-expanded'), 'true');
  await page.getByText('残す問題セット', { exact: true }).click();
  await page.getByRole('heading', { name: '残す問題セット', exact: true }).waitFor();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '問題セットを削除しています' }).waitFor();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  await page.locator('.quiz-home__folder-main').waitFor();
  await page.evaluate(() => window.releaseDeletionLock());
  await page.waitForFunction(async () => {
    const { loadAppDataAsync } = await import('/quiz/src/storage.ts');
    return !(await loadAppDataAsync()).problemSets.some(set => set.id === 's');
  });
  await page.locator('.quiz-home__folder-main').click();
  await page.waitForFunction(() => !document.querySelector('.library-actions__trigger')?.disabled);
  assert.equal(await page.getByText('確認クイズ', { exact: true }).count(), 0);
  assert.equal(await page.getByText('残す問題セット', { exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: deletion hides its row immediately; pending persistence permits child expansion, another set and back navigation; editing resumes after durable deletion.');
} finally { await browser.close(); await server.close(); }
