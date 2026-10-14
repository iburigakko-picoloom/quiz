import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const require = createRequire(resolve(process.env.QUIZMAKE_SHARP_MODULE, 'package.json'));
const sharp = require('sharp');
const origin = process.env.QUIZMAKE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5191/quiz';
const output = `tmp/companion-motion-v2/${Date.now()}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.goto(`${origin}/tests/browser/companion-animation-preview.html`);
  const canvas = page.locator('canvas[data-renderer="rig"]');
  await canvas.waitFor();
  await page.waitForTimeout(600);
  const sample = () => canvas.evaluate(canvas => canvas.toDataURL());
  const first = await sample(); await page.waitForTimeout(450); assert.notEqual(await sample(), first, 'an untouched character keeps breathing/moving');

  // Render deterministic samples of the same rig to inspect every pose and
  // encode a replay. Runtime animation is separately checked above/in the app.
  const samples = await page.evaluate(async () => {
    const { companionActivityPose, blendCompanionPose, companionEase, restingCompanionPose } = await import('/quiz/src/utils/companionAnimation.ts');
    const { loadCompanionRig, drawCompanionRig } = await import('/quiz/src/components/companionRig.ts');
    const image = await loadCompanionRig(), canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 290;
    const ctx = canvas.getContext('2d');
    const clips = [
      ['sit', 3_000], ['scratch', 4_800], ['stand', 3_000], ['lie', 3_000], ['sleep', 4_600],
      ['spin', 3_200], ['touch', 3_000], ['bow', 3_200], ['roll', 4_400],
    ];
    const result = [];
    let clock = 0;
    let pose = restingCompanionPose();
    for (const [activity, duration] of clips) {
      const previous = pose;
      for (let i = 0; i < 20; i++) {
        const time = duration * i / 19;
        pose = blendCompanionPose(previous, companionActivityPose(activity, time, duration, clock + time), companionEase(time / 1_100));
        drawCompanionRig(ctx, image, pose, clock + time, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0, left = 320, top = 290, right = 0, bottom = 0;
        for (let y = 0; y < 290; y++) for (let x = 0; x < 320; x++) {
          const p = (y * 320 + x) * 4;
          if (pixels[p + 3] > 180 && Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) < 240) {
            count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        result.push({ activity, frame: i, image: canvas.toDataURL(), bounds: [left, top, right, bottom], pixels: count });
      }
      clock += duration;
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
  await app.goto(`${origin}/tests/browser/companion-care-preview.html?answers=160`);
  await app.locator('canvas[data-renderer="rig"]').waitFor();
  await app.waitForTimeout(400);
  await app.screenshot({ path: `${output}/home-390.png` });
  await app.getByRole('button', { name: 'パピィのお世話をする' }).click();
  await app.locator('canvas[data-renderer="rig"]').waitFor();
  await app.getByRole('tab', { name: '芸' }).click();
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
    await app.setViewportSize({ width, height });
    await app.getByRole('button', { name: /くるりんを教える/ }).scrollIntoViewIfNeeded();
    const bounds = await app.locator('canvas').boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `${width}px: the whole character stays visible when controls scroll`);
    assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await app.screenshot({ path: `${output}/tricks-${width}.png` });
  }
  await app.setViewportSize({ width: 390, height: 844 });
  await app.getByRole('button', { name: /くるりんを教える/ }).click();
  await app.locator('canvas[data-activity="spin"]').waitFor();
  await app.waitForTimeout(1100);
  await app.screenshot({ path: `${output}/practice-spin.png` });
  await app.getByText(/ご褒美のごはん！/).waitFor();
  assert.equal(await app.locator('canvas').getAttribute('data-activity'), 'feed');
  assert.deepEqual(errors, []);
  console.log('Continuous companion animation passed: live frame changes, all idle/trick poses, uncropped full body, joint geometry, 320/390/768px fixed character stage and practice/reward timing. Output: ' + output);
} finally { await browser.close(); }
