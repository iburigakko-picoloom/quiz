import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const require = createRequire(resolve(process.env.QUIZMAKE_SHARP_MODULE, 'package.json'));
const sharp = require('sharp');
const origin = process.env.QUIZMAKE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5191/quiz';
const output = `tmp/companion-smooth/${Date.now()}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.goto(`${origin}/tests/browser/companion-animation-preview.html`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('canvas[data-renderer="full-body-frames"]');
  await canvas.waitFor();
  await page.waitForTimeout(600);
  const sample = () => canvas.evaluate(canvas => canvas.toDataURL());
  const visibleDog = target => target.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 180) count++;
    return count > 500 && getComputedStyle(canvas).opacity === '1';
  });
  const first = await sample(); await page.waitForTimeout(900); assert.notEqual(await sample(), first, 'an untouched character keeps breathing/moving');
  const paintSamples = [];
  for (let i = 0; i < 12; i++) {
    paintSamples.push(await sample());
    await page.waitForTimeout(20);
  }
  assert.ok(new Set(paintSamples).size >= 8, 'idle has intermediate renders instead of long static holds');

  const registration = await page.evaluate(async () => {
    const { loadCompanionSheet, drawCompanionFrame } = await import('/quiz/src/components/companionFrames.ts');
    const image = await loadCompanionSheet('idle');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 352;
    const ctx = canvas.getContext('2d');
    const centers = [], ground = [];
    for (let index = 0; index < 16; index++) {
      drawCompanionFrame(ctx, image, index, 352, 352, { sheet: 'idle' });
      const pixels = ctx.getImageData(0, 0, 352, 352).data;
      const runs = []; let start = null, bottom = 0;
      for (let x = 90; x <= 260; x++) {
        let count = 0;
        for (let y = 312; y < 321; y++) if (pixels[(y * 352 + x) * 4 + 3] > 170) count++;
        if (count >= 4 && start === null) start = x;
        if ((count < 4 || x === 260) && start !== null) { if (x - start >= 8) runs.push([start, x - 1]); start = null; }
        for (let y = 300; y < 340; y++) if (pixels[(y * 352 + x) * 4 + 3] > 200) bottom = Math.max(bottom, y);
      }
      if (runs.length !== 2) throw new Error('Expected two planted forepaws');
      centers.push(runs.flat().reduce((a, b) => a + b, 0) / 4); ground.push(bottom);
    }
    drawCompanionFrame(ctx, image, 0, 352, 352, { sheet: 'idle', nextIndex: 1, mix: .5 });
    const chestOpacity = ctx.getImageData(176, 240, 1, 1).data[3];
    return { centers, ground, chestOpacity };
  });
  await writeFile(`${output}/registration.json`, JSON.stringify(registration, null, 2));
  console.log('Paw registration:', JSON.stringify(registration));
  assert.ok(Math.max(...registration.centers) - Math.min(...registration.centers) <= 1, 'seated paw center remains fixed to within one source pixel');
  assert.ok(Math.max(...registration.ground) - Math.min(...registration.ground) <= 1, 'seated ground does not bounce');
  // Two 8-bit weighted draws can round down by one alpha unit (254/255).
  assert.ok(registration.chestOpacity >= 254, 'blending preserves body opacity within 8-bit rounding');

  // Render complete cels deterministically; never assemble body parts.
  const samples = await page.evaluate(async () => {
    const { companionFrame, COMPANION_MOTION_MS, COMPANION_IDLE_CLIPS } = await import('/quiz/src/utils/companionAnimation.ts');
    const { loadCompanionSheet, drawCompanionFrame } = await import('/quiz/src/components/companionFrames.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 290;
    const ctx = canvas.getContext('2d');
    const clips = [
      ['sit', 3_000], ['scratch', 3_800], ['stand', 3_000], ['lie', 5_000], ['sleep', 4_600],
      ['spin', 3_200], ['touch', 3_000], ['bow', 3_200], ['roll', 4_400],
    ];
    const result = [];
    for (const [activity] of clips) {
      const duration = COMPANION_MOTION_MS[activity] ?? COMPANION_IDLE_CLIPS.find(clip => clip.activity === activity).duration;
      for (let i = 0; i < 20; i++) {
        const frame = companionFrame(activity, duration * i / 19, duration);
        const image = await loadCompanionSheet(frame.sheet);
        drawCompanionFrame(ctx, image, frame.index, canvas.width, canvas.height, frame);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0, left = 320, top = 290, right = 0, bottom = 0;
        for (let y = 0; y < 290; y++) for (let x = 0; x < 320; x++) {
          const p = (y * 320 + x) * 4;
          if (pixels[p + 3] > 180 && Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) < 240) {
            count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        result.push({ activity, frame: i, cel: frame, image: canvas.toDataURL(), bounds: [left, top, right, bottom], pixels: count });
      }
    }
    return result;
  });
  const raw = [], thumbnails = [];
  for (const sample of samples) {
    assert.ok(sample.pixels > 2000, sample.activity + ' has visible whole-body artwork');
    assert.ok(sample.bounds[0] > 1 && sample.bounds[1] > 1 && sample.bounds[2] < 318 && sample.bounds[3] < 288, sample.activity + ' is not cropped');
    const buffer = Buffer.from(sample.image.split(',')[1], 'base64');
    raw.push(await sharp(buffer).flatten({ background: '#fff' }).raw().toBuffer());
    if ([0, 5, 10, 15, 19].includes(sample.frame)) thumbnails.push({ input: buffer, left: [0, 5, 10, 15, 19].indexOf(sample.frame) * 320, top: ['sit', 'scratch', 'stand', 'lie', 'sleep', 'spin', 'touch', 'bow', 'roll'].indexOf(sample.activity) * 290 });
  }
  await sharp(Buffer.concat(raw), { raw: { width: 320, height: 290 * raw.length, channels: 3, pageHeight: 290 } }).gif({ loop: 0, delay: 100, effort: 3, colours: 128 }).toFile(`${output}/motions.gif`);
  await sharp({ create: { width: 1600, height: 2610, channels: 4, background: '#fff' } }).composite(thumbnails).png().toFile(`${output}/motion-contact-sheet.png`);
  await writeFile(`${output}/frames.json`, JSON.stringify(samples.map(({ image, ...sample }) => sample), null, 2));

  const app = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  app.on('pageerror', error => errors.push(error.message));
  await app.route('https://**/*', route => route.abort());
  await app.goto(`${origin}/tests/browser/companion-care-preview.html?answers=160`, { waitUntil: 'domcontentloaded' });
  await app.locator('canvas[data-renderer="full-body-frames"]').waitFor();
  await app.waitForTimeout(400);
  await app.screenshot({ path: `${output}/home-390.png` });
  await app.getByRole('button', { name: 'パピィのお世話をする' }).click();
  await app.locator('canvas[data-renderer="full-body-frames"]').waitFor();
  assert.equal(await app.locator('.companion-care__stage p').count(), 0, 'no narration under the character');
  assert.equal(await app.getByText(/ちょこんと座って/).count(), 0);
  await app.getByRole('tab', { name: 'おやつ' }).click();
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
    await app.setViewportSize({ width, height });
    await app.getByRole('button', { name: /くるりんを教える/ }).scrollIntoViewIfNeeded();
    const bounds = await app.locator('canvas').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `${width}px: the whole character stays visible when controls scroll`);
    assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await visibleDog(app), true, `${width}px: resizing keeps a visible painted character`);
    await app.screenshot({ path: `${output}/tricks-${width}.png` });
  }
  await app.setViewportSize({ width: 390, height: 844 });
  await app.getByRole('button', { name: /くるりんを教える/ }).click();
  await app.locator('canvas[data-activity="spin"]').waitFor();
  await app.waitForTimeout(1100);
  await app.screenshot({ path: `${output}/practice-spin.png` });
  await app.locator('canvas[data-activity="feed"]').waitFor();
  assert.equal(await app.locator('.companion-care__notice').count(), 0);
  assert.equal(await app.locator('canvas').getAttribute('data-activity'), 'feed');
  assert.deepEqual(errors, []);
  console.log('Smooth whole-body animation passed: intermediate renders, stable seated paw anchor/ground, opaque blends, no idle narration, uncropped full body, 320/390/768px stage and reward timing. Output: ' + output);
} finally { await browser.close(); }
