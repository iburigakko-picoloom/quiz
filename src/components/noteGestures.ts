export const NOTE_MIN_SCALE = 1;
export const NOTE_MAX_SCALE = 2.5;

/** Use the raw gesture distance, never feed the resisted value back into itself. */
export function boundedNoteScale(value: number, elastic = false): number {
  const raw = Number.isFinite(value) ? value : NOTE_MIN_SCALE;
  const bound = Math.max(NOTE_MIN_SCALE, Math.min(NOTE_MAX_SCALE, raw));
  const overshoot = raw - bound;
  return elastic ? bound + Math.sign(overshoot) * 0.14 * (1 - Math.exp(-Math.abs(overshoot) / 0.14)) : bound;
}

export function noteSwipeDirection(dx: number, dy: number, cancelled = false): -1 | 0 | 1 {
  if (cancelled || Math.abs(dx) <= 70 || Math.abs(dx) <= Math.abs(dy) * 1.25) return 0;
  return dx < 0 ? 1 : -1;
}
