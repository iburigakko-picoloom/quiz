export type StudyTimeEntry = { setId: string; startedAt: string; finishedAt: string; elapsedMs: number; valid: boolean };
export type StudyTimeSnapshot = Record<string, StudyTimeEntry>;
export function isStudyTimeEntry(value: unknown): value is StudyTimeEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as StudyTimeEntry;
  return typeof row.setId === 'string' && Boolean(row.setId) && typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) && typeof row.finishedAt === 'string' && Number.isFinite(Date.parse(row.finishedAt)) && typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && typeof row.valid === 'boolean';
}

/** Measures foreground display time per question using a monotonic clock.
 * Snapshots contain no running clock and can be resumed after account recovery. */
export class VisibleStudyTimer {
  private rows: StudyTimeSnapshot;
  private current: { id: string; setId: string } | null = null;
  private visible = false;
  private start: number | null = null;
  private monotonic: () => number;
  private wall: () => number;
  private lastWall = 0;
  private invalidClock = false;
  constructor(snapshot: StudyTimeSnapshot = {}, monotonic = () => performance.now(), wall = () => Date.now()) {
    this.rows = Object.create(null) as StudyTimeSnapshot;
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) for (const [id,row] of Object.entries(snapshot)) if (id && isStudyTimeEntry(row)) this.rows[id] = structuredClone(row);
    this.monotonic = monotonic; this.wall = wall;
    for (const row of Object.values(this.rows)) { const stamp=Date.parse(row.finishedAt); if(Number.isFinite(stamp))this.lastWall=Math.max(this.lastWall,stamp); if(!row.valid)this.invalidClock=true; }
  }
  private checkWall(wall: number) {
    if (wall < this.lastWall) { this.invalidClock = true; for (const row of Object.values(this.rows)) row.valid = false; }
    this.lastWall = Math.max(this.lastWall, wall);
  }
  private checkpoint() {
    if (this.start === null || !this.current) return;
    const now = this.monotonic(), wall = this.wall(), elapsed = now - this.start;
    const row = this.rows[this.current.id];
    if (!row || row.setId !== this.current.setId || !Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(wall)) { this.invalidClock = true; for (const item of Object.values(this.rows)) item.valid = false; }
    else { this.checkWall(wall);row.elapsedMs += elapsed; row.finishedAt = new Date(wall).toISOString(); if (this.invalidClock || Date.parse(row.finishedAt) < Date.parse(row.startedAt)) row.valid = false; }
    this.start = this.visible ? now : null;
  }
  setQuestion(question: { id: string; setId: string } | null) {
    this.checkpoint(); this.current = question; this.start = null;
    if (question && this.visible) this.startSegment();
  }
  setVisible(visible: boolean) {
    if (visible === this.visible) return;
    this.checkpoint(); this.visible = visible; this.start = null;
    if (visible && this.current) this.startSegment();
  }
  private startSegment() {
    if (!this.current) return;
    const wall = this.wall(), now = this.monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(now)) return;
    this.checkWall(wall);
    const stamp = new Date(wall).toISOString(), old = this.rows[this.current.id];
    if (!old) this.rows[this.current.id] = { setId: this.current.setId, startedAt: stamp, finishedAt: stamp, elapsedMs: 0, valid: !this.invalidClock };
    else if (old.setId !== this.current.setId || Date.parse(stamp) < Date.parse(old.finishedAt)) old.valid = false;
    this.start = now;
  }
  snapshot(): StudyTimeSnapshot { this.checkpoint(); return structuredClone(this.rows); }
  stop(): StudyTimeSnapshot { this.checkpoint(); this.current = null; this.start = null; return structuredClone(this.rows); }
}
