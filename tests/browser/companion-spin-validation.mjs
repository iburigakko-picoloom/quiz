import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const engines = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const engine = process.env.QUIZ_NOTE_BROWSER ?? 'webkit';
const output = `tmp/companion-spin-${engine}-${Date.now()}`;
await mkdir(output, { recursive: true });
const server = await createServer({
  optimizeDeps: { entries: ['tests/browser/companion-animation-preview.html', 'tests/browser/companion-care-preview.html'] },
  server: { host: '127.0.0.1', port: 5198, strictPort: true, watch: { ignored: ['**/tmp/**'] } },
});
await server.listen();
const browser = await engines[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', route => route.abort());
  let releaseSpin;
  const spinGate = new Promise(resolve => { releaseSpin = resolve; });
  await page.route('**/frames-v3/spin-smooth.webp*', async route => { if (route.request().resourceType() === 'image') await spinGate; await route.continue(); });
  await page.goto('http://127.0.0.1:5198/quiz/tests/browser/companion-animation-preview.html', { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas[data-renderer="full-body-frames"]');
  await canvas.waitFor();
  await page.evaluate(() => {
    window.spinSamples = [];
    const canvas = document.querySelector('canvas');
    const sample = now => {
      if (canvas.dataset.activity === 'spin') window.spinSamples.push({ time: now, cel: canvas.dataset.cel, blend: Number(canvas.dataset.frameBlend) });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'くるりん', exact: true }).click();
  await page.waitForTimeout(450);
  assert.ok((await canvas.getAttribute('data-cel')).startsWith('idle:'), 'loading keeps the last complete drawing');
  releaseSpin();
  await page.waitForFunction(() => document.querySelector('canvas').dataset.cel?.startsWith('spinSmooth:'));
  await page.waitForTimeout(1700);
  const samples = await page.evaluate(() => window.spinSamples.filter(sample => sample.cel?.startsWith('spinSmooth:')));
  assert.equal(samples[0].cel, 'spinSmooth:0', 'a late image starts at the first pose');
  const moving = samples.filter(sample => Number(sample.cel.split(':')[1]) < 30);
  let changed = 0;
  for (let i = 1; i < moving.length; i++) if (moving[i].cel !== moving[i - 1].cel || moving[i].blend !== moving[i - 1].blend) changed++;
  const changedFraction = changed / (moving.length - 1);
  await writeFile(`${output}/samples.json`, JSON.stringify(samples));
  console.log(JSON.stringify({ output, movingFrames: moving.length, changedFraction, firstCel: samples[0]?.cel, lastCel: samples.at(-1)?.cel }));
  assert.ok(moving.length >= 25, 'collect enough real animation frames, including 30 Hz WebKit');
  assert.ok(changedFraction >= .9, `moving on ${changedFraction * 100}% of display ticks`);
  assert.ok(samples.some(sample => sample.cel === 'spinSmooth:31'), 'the entire turn finishes after loading');
  await page.screenshot({ path: `${output}/spin-complete.png` });

  // Mid-transition artwork for visual review of body opacity and registration.
  const strip = await page.evaluate(async () => {
    const { loadCompanionSheet, drawCompanionFrame } = await import('/quiz/src/components/companionFrames.ts');
    const image = await loadCompanionSheet('spinSmooth');
    const sheet = document.createElement('canvas'); sheet.width = 352 * 5; sheet.height = 352 * 3;
    const cel = document.createElement('canvas'); cel.width = cel.height = 352;
    for (let i = 0; i < 32; i++) {
      drawCompanionFrame(cel.getContext('2d'), image, i, 352, 352, { sheet: 'spinSmooth' });
      const data = cel.getContext('2d').getImageData(0, 0, 352, 352).data;
      let count = 0, left = 352, right = 0, top = 352, bottom = 0;
      for (let y = 0; y < 352; y++) for (let x = 0; x < 352; x++) {
        const p = (y * 352 + x) * 4;
        if (data[p + 3] > 200 && Math.min(data[p], data[p + 1], data[p + 2]) < 230) {
          count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      if (count < 2000 || left <= 1 || right >= 350 || top <= 1 || bottom >= 350) throw new Error(`Missing/cropped spin cel ${i}: ${left},${top},${right},${bottom}`);
    }
    for (let i = 0; i < 15; i++) {
      drawCompanionFrame(cel.getContext('2d'), image, i * 2, 352, 352, { sheet: 'spinSmooth', nextIndex: i * 2 + 1, mix: .5 });
      sheet.getContext('2d').drawImage(cel, i % 5 * 352, Math.floor(i / 5) * 352);
    }
    return sheet.toDataURL();
  });
  await writeFile(`${output}/spin-midpoints.png`, Buffer.from(strip.split(',')[1], 'base64'));

  // The actual care flow must wait for decoding before starting the reward timer.
  const care = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  care.on('pageerror', e => errors.push(e.message));
  await care.route('https://**/*', route => route.abort());
  let releaseCare;
  const careGate = new Promise(resolve => { releaseCare = resolve; });
  await care.route('**/frames-v3/spin-smooth.webp*', async route => { if (route.request().resourceType() === 'image') await careGate; await route.continue(); });
  await care.goto('http://127.0.0.1:5198/quiz/tests/browser/companion-care-preview.html?answers=160', { waitUntil: 'domcontentloaded' });
  await care.getByRole('button', { name: 'パピィのお世話をする' }).click();
  await care.emulateMedia({ reducedMotion: 'reduce' });
  for (let i = 0; i < 2; i++) {
    await care.getByRole('button', { name: 'ごはんを1個あげる' }).click();
    await care.waitForFunction(() => !document.querySelector('.companion-care__primary')?.disabled);
  }
  await care.emulateMedia({ reducedMotion: 'no-preference' });
  await care.getByRole('tab', { name: 'おやつ' }).click();
  const train = care.getByRole('button', { name: /くるりんを教える/ });
  await train.click();
  await care.waitForTimeout(2200);
  assert.equal(await train.isDisabled(), true, 'cannot double-charge while loading');
  assert.notEqual(await care.locator('canvas').getAttribute('data-activity'), 'feed', 'reward does not overtake the delayed trick');
  releaseCare();
  await care.locator('canvas[data-activity="spin"]').waitFor();
  const spinStart = Date.now();
  await care.locator('canvas[data-activity="feed"]').waitFor();
  const spinDuration = Date.now() - spinStart;
  assert.ok(spinDuration >= 1800, 'practice plays a full turn before its reward');
  await care.screenshot({ path: `${output}/care-reward.png` });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'くるりん', exact: true }).click();
  await page.waitForTimeout(150);
  const reducedA = await canvas.evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(300);
  assert.equal(await canvas.evaluate(canvas => canvas.toDataURL()), reducedA, 'reduced motion stays still');
  assert.deepEqual(errors, []);
  const report = { engine, movingFrames: moving.length, changedFraction, firstCel: samples[0].cel, lastCel: samples.at(-1).cel, spinDuration, errors };
  await writeFile(`${output}/verified.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }));
} finally { await browser.close(); await server.close(); }
