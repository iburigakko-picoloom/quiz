import idle from '../assets/companion/frames-v3/idle.webp';
import scratch from '../assets/companion/frames-v3/scratch.webp';
import sleep from '../assets/companion/frames-v3/sleep.webp';
import spin from '../assets/companion/frames-v3/spin.webp';
import spinSmooth from '../assets/companion/frames-v3/spin-smooth.webp';
import spinStep from '../assets/companion/frames-v3/spin-step-v2.png';
import touch from '../assets/companion/frames-v3/touch.webp';
import bow from '../assets/companion/frames-v3/bow.webp';
import roll from '../assets/companion/frames-v3/roll.webp';
import care from '../assets/companion/frames-v3/care.webp';
import { companionFrame, type CompanionAction, type CompanionSheet } from '../utils/companionAnimation';
import { COMPANION_GROUND_Y, companionFrameOffset, companionSheetLayout } from '../utils/companionFrameLayout';

const sources: Record<CompanionSheet, string> = { idle, scratch, sleep, spin, spinSmooth, spinStep, touch, bow, roll, care };
const images = new Map<CompanionSheet, Promise<HTMLImageElement>>();
export function loadCompanionSheet(sheet: CompanionSheet): Promise<HTMLImageElement> {
  const cached = images.get(sheet);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      // Decode before starting the action clock, not on its first canvas draw.
      void image.decode().then(() => resolve(image), error => {
        if (image.complete && image.naturalWidth) resolve(image);
        else { images.delete(sheet); reject(error); }
      });
    };
    image.onerror = () => { images.delete(sheet); reject(new Error('Companion animation image could not be loaded')); };
    image.src = sources[sheet];
  });
  images.set(sheet, pending);
  return pending;
}

export async function prepareCompanionMotion(kind: CompanionAction, reward = false): Promise<void> {
  const sheets = new Set<CompanionSheet>(['idle', companionFrame(kind, 0, 1).sheet]);
  if (reward) sheets.add('care');
  await Promise.all([...sheets].map(loadCompanionSheet));
}

export type CompanionFrameDrawing = {
  sheet: CompanionSheet; nextIndex?: number; mix?: number;
  from?: { image: HTMLImageElement; index: number; sheet: CompanionSheet; nextIndex?: number; mix?: number };
  entrance?: number;
};

/** Align and blend complete drawings, preserving their aspect ratio and alpha. */
export function drawCompanionFrame(ctx: CanvasRenderingContext2D, image: HTMLImageElement, index: number, width: number, height: number, options: CompanionFrameDrawing = { sheet: 'idle' }) {
  const size = Math.min(width, height);
  const scale = size / 352;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Add premultiplied contributions. Source-over fades the opaque body itself
  // at mid-transition; additive weights summing to one keep it fully opaque.
  ctx.globalCompositeOperation = 'lighter';
  const cel = (asset: HTMLImageElement, sheet: CompanionSheet, frame: number, weight: number) => {
    if (weight <= 0) return;
    const offset = companionFrameOffset(sheet, frame);
    const { columns } = companionSheetLayout(sheet);
    const cellWidth = asset.naturalWidth / columns;
    const cellHeight = asset.naturalHeight / Math.ceil(companionSheetLayout(sheet).frames / columns);
    // The stepping drawings occupy more of each cell than the original idle
    // artwork. Scale the whole dog around its paws to avoid a size jump.
    const celScale = sheet === 'spinStep' ? 0.87 : 1;
    const celSize = size * celScale;
    ctx.globalAlpha = weight;
    ctx.drawImage(asset, (frame % columns) * cellWidth, Math.floor(frame / columns) * cellHeight, cellWidth, cellHeight,
      (width - size) / 2 + (size - celSize) / 2 + offset.x * scale * celScale,
      (height - size) / 2 + COMPANION_GROUND_Y * scale * (1 - celScale) + offset.y * scale * celScale, celSize, celSize);
  };
  const entrance = options.from ? Math.max(0, Math.min(1, options.entrance ?? 1)) : 1;
  const mix = Math.max(0, Math.min(1, options.mix ?? 0));
  if (options.from) {
    const previousMix = Math.max(0, Math.min(1, options.from.mix ?? 0));
    cel(options.from.image, options.from.sheet, options.from.index, (1 - entrance) * (1 - previousMix));
    cel(options.from.image, options.from.sheet, options.from.nextIndex ?? options.from.index, (1 - entrance) * previousMix);
  }
  cel(image, options.sheet, index, entrance * (1 - mix));
  cel(image, options.sheet, options.nextIndex ?? index, entrance * mix);
  ctx.restore();
}
