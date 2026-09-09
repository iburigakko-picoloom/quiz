// Exact rectangular crops from the supplied photo; no generated or redrawn content.
const sharp = require(process.argv[3] || 'sharp');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const source = process.argv[2];
if (!source) throw new Error('Pass the original photo path.');
const output = path.resolve(__dirname, '../src/assets/companion');
mkdirSync(output, { recursive: true });
(async () => {
  for (const [name, left, top, width, height] of [
    ['tilt', 8, 538, 270, 294],
    ['sit', 571, 550, 185, 272],
    ['look', 809, 334, 213, 214],
    ['stand', 526, 8, 275, 307],
    ['turn', 755, 550, 207, 282],
    ['rest', 962, 609, 318, 188],
  ]) {
    await sharp(source).extract({ left, top, width, height }).resize({ height: 320 }).webp({ quality: 92 }).toFile(path.join(output, `${name}.webp`));
  }
  await sharp(source).extract({ left: 8, top: 8, width: 274, height: 340 }).resize({ height: 400 }).webp({ quality: 92 }).toFile(path.join(output, 'hello.webp'));
  await sharp(source).extract({ left: 548, top: 314, width: 245, height: 238 }).resize({ height: 320 }).webp({ quality: 92 }).toFile(path.join(output, 'praise.webp'));
})();
