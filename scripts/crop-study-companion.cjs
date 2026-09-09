// Exact rectangular crops from the supplied photo; no generated or redrawn content.
const sharp = require(process.argv[3] || 'sharp');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const source = process.argv[2];
if (!source) throw new Error('Pass the original photo path.');
const output = path.resolve(__dirname, '../src/assets/companion');
mkdirSync(output, { recursive: true });
(async () => {
  await sharp(source).extract({ left: 8, top: 8, width: 274, height: 340 }).resize({ height: 400 }).webp({ quality: 92 }).toFile(path.join(output, 'hello.webp'));
  await sharp(source).extract({ left: 548, top: 314, width: 245, height: 238 }).resize({ height: 320 }).webp({ quality: 92 }).toFile(path.join(output, 'praise.webp'));
})();
