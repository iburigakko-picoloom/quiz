import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const server = await createServer({ server: { host: '127.0.0.1', port: 5193, strictPort: true, watch: { ignored: ['**/tmp/**'] } } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const results = [];
  for (const hz of [60, 90, 120]) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      let id = 0; const callbacks = new Map();
      window.requestAnimationFrame = callback => { callbacks.set(++id, callback); return id; };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.animationTick = time => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time)); };
    });
    await page.goto('http://127.0.0.1:5193/quiz/tests/browser/companion-animation-preview.html');
    await page.locator('canvas[data-renderer="full-body-frames"]').waitFor();
    const result = await page.evaluate(async hz => {
      const { loadCompanionSheet, drawCompanionFrame } = await import('/quiz/src/components/companionFrames.ts');
      await Promise.all(['idle', 'scratch', 'sleep', 'spin', 'touch', 'bow', 'roll', 'care'].map(loadCompanionSheet));
      const canvas = document.querySelector('canvas'), values = [];
      for (let i = 1; i <= hz; i++) { window.animationTick(1000 + i * 1000 / hz); values.push(`${canvas.dataset.cel}:${canvas.dataset.frameBlend}`); }
      const offscreen = document.createElement('canvas'); offscreen.width = offscreen.height = 352;
      const ctx = offscreen.getContext('2d'), image = await loadCompanionSheet('idle');
      drawCompanionFrame(ctx, image, 0, 352, 352, { sheet: 'idle', nextIndex: 1, mix: .65 });
      const before = offscreen.toDataURL();
      drawCompanionFrame(ctx, image, 2, 352, 352, { sheet: 'idle', entrance: 0, from: { image, sheet: 'idle', index: 0, nextIndex: 1, mix: .65 } });
      return { hz, distinctFrames: new Set(values).size, interruptionPreserved: before === offscreen.toDataURL() };
    }, hz);
    assert.ok(result.distinctFrames >= hz * .95, `${hz} Hz should not lose every other frame`);
    assert.equal(result.interruptionPreserved, true, 'an action starts from the last visible blended pose');
    results.push(result); await page.close();
  }
  console.log(JSON.stringify(results));
} finally { await browser.close(); await server.close(); }
