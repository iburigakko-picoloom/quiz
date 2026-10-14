// Package complete ImageGen drawings. No segmentation into moving body parts.
// Usage: node scripts/build-companion-frames.cjs [path-to-sharp]
const sharp = require(process.argv[2] || 'sharp');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../src/assets/companion/frames-v3');
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
(async () => {
  for (const [name, sheet] of Object.entries(manifest.sheets)) {
    const source = path.join(directory, sheet.source);
    const { width: sw, height: sh } = await sharp(source).metadata();
    const drawings = [];
    for (const [i, bounds] of sheet.crops.entries()) {
      const left = Math.max(0, bounds.left - 5), top = Math.max(0, bounds.top - 5);
      const width = Math.min(sw - left, bounds.width + 10), height = Math.min(sh - top, bounds.height + 10);
      const dw = Math.round(width * sheet.scale), dh = Math.round(height * sheet.scale);
      const input = await sharp(source).extract({ left, top, width, height }).resize(dw, dh).png().toBuffer();
      drawings.push({ input, left: (i % manifest.columns) * manifest.cell + Math.round((manifest.cell - dw) / 2),
        top: Math.floor(i / manifest.columns) * manifest.cell + manifest.baseline - Math.round((bounds.top + bounds.height - top) * sheet.scale) });
    }
    await sharp({ create: { width: manifest.cell * manifest.columns, height: manifest.cell * manifest.rows, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(drawings)
      .webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(path.join(directory, `${name}.webp`));
    console.log(`${name}: ${sheet.frames} complete cels`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
