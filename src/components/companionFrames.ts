import idle from '../assets/companion/frames-v3/idle.webp';
import scratch from '../assets/companion/frames-v3/scratch.webp';
import sleep from '../assets/companion/frames-v3/sleep.webp';
import spin from '../assets/companion/frames-v3/spin.webp';
import touch from '../assets/companion/frames-v3/touch.webp';
import bow from '../assets/companion/frames-v3/bow.webp';
import roll from '../assets/companion/frames-v3/roll.webp';
import care from '../assets/companion/frames-v3/care.webp';
import type { CompanionSheet } from '../utils/companionAnimation';

const sources: Record<CompanionSheet, string> = { idle, scratch, sleep, spin, touch, bow, roll, care };
const images = new Map<CompanionSheet, Promise<HTMLImageElement>>();
export function loadCompanionSheet(sheet: CompanionSheet): Promise<HTMLImageElement> {
  const cached = images.get(sheet);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => { images.delete(sheet); reject(new Error('Companion animation image could not be loaded')); };
    image.src = sources[sheet];
  });
  images.set(sheet, pending);
  return pending;
}

/** Exactly one complete cel per draw. Uniform scale, no body-part transforms. */
export function drawCompanionFrame(ctx: CanvasRenderingContext2D, image: HTMLImageElement, index: number, width: number, height: number) {
  const size = Math.min(width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (index % 4) * 352, Math.floor(index / 4) * 352, 352, 352, (width - size) / 2, (height - size) / 2, size, size);
}
