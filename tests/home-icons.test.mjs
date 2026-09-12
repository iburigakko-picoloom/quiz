import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('installable icon references resolve to files with their declared PNG dimensions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  for (const icon of manifest.icons) {
    const path = new URL('../public/' + icon.src.replace(/^\.\//, '').split('?')[0], import.meta.url);
    assert.ok(existsSync(path), icon.src);
    if (!icon.src.split('?')[0].endsWith('.png')) continue;
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
  }
});
