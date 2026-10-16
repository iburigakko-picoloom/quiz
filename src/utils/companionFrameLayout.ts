import type { CompanionSheet } from './companionAnimation';

// Front-paw midpoint, measured in the 352px full-body cel. For a lifted
// front paw, use the other planted paw plus its reference distance to center.
// Only the WHOLE drawing is translated; pixels and body parts are untouched.
export const COMPANION_PAW_ANCHORS: Record<CompanionSheet, readonly number[]> = {
  spinSmooth: Array.from({ length: 32 }, () => 176),
  "idle": [
    166.75,
    164,
    166.75,
    164.5,
    164.25,
    166.25,
    164,
    166.25,
    162.5,
    161.25,
    162.5,
    164.25,
    162,
    162.75,
    163,
    163.5
  ],
  "scratch": [
    166.5,
    165,
    165.75,
    164.25,
    162.75,
    161.5,
    164,
    164.5,
    161.75,
    164.25,
    167,
    162.75,
    162.25,
    160,
    166.5,
    167.75
  ],
  "care": [
    167.25,
    151.75,
    148.5,
    150.75,
    153.25,
    154.75,
    165.25,
    166.75,
    166,
    167,
    171.25,
    171.25,
    167.75,
    164,
    163.5,
    166.5
  ],
  "touch": [
    168.75,
    168.75,
    168.25,
    166.25,
    164.25,
    161.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75,
    168.75
  ],
  "sleep": [
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    163.5,
    167.75,
    163.25
  ],
  "spin": [
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    169.25,
    179,
    166.75
  ],
  "bow": [
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    166
  ],
  "roll": [
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    161.25,
    162.5
  ]
};
// Visible opaque contact row, after source-cel resizing and alpha filtering.
const groundRows: Record<Exclude<CompanionSheet, 'spinSmooth'>, readonly number[]> = {"idle":[320,319,321,320,320,321,321,321,320,320,320,320,320,321,321,319],"scratch":[320,321,320,320,320,320,320,320,320,320,320,320,321,320,320,320],"care":[321,320,319,320,320,320,320,320,320,319,320,320,320,320,320,320],"touch":[320,320,320,320,320,320,320,320,320,320,320,320,321,320,320,321],"sleep":[319,319,321,321,319,320,319,320,321,320,320,320,321,321,319,319],"spin":[321,320,320,321,320,320,320,320,321,320,321,320,320,320,321,322],"bow":[320,320,320,320,320,320,320,320,320,319,320,320,320,320,320,320],"roll":[320,321,320,317,317,320,320,319,321,318,318,321,320,320,321,321]};
export const COMPANION_GROUND_Y = 320;
export function companionSheetLayout(sheet: CompanionSheet) {
  return sheet === 'spinSmooth' ? { columns: 8, frames: 32 } : { columns: 4, frames: 16 };
}
export function companionFrameOffset(sheet: CompanionSheet, index: number) {
  if (sheet === 'spinSmooth') return { x: 0, y: -2 };
  return { x: 176 - (COMPANION_PAW_ANCHORS[sheet][index] ?? 176), y: COMPANION_GROUND_Y - (groundRows[sheet][index] ?? COMPANION_GROUND_Y) };
}
