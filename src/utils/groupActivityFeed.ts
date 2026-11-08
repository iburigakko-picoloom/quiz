export type ActivityEntry = { id: string; kind: 'session' | 'manual'; user_id: string; display_name: string; set_id: string | null; title: string; finished_at: string; answered: number | null; minutes: number | null };
export type ActivityFeed = { enabled: boolean; generation: string | null; entries: ActivityEntry[] };
export function parseActivityFeed(value: unknown): ActivityFeed {
  if (!value || typeof value !== 'object') throw new Error('活動を読み込めません。');
  const feed = value as ActivityFeed;
  if (typeof feed.enabled !== 'boolean' || (feed.generation !== null && typeof feed.generation !== 'string') || (feed.enabled && !feed.generation) || !Array.isArray(feed.entries) || feed.entries.length > 50 || feed.entries.some(entry => {
    if (!entry || typeof entry.id !== 'string' || !/^\d+$/.test(entry.id) || typeof entry.user_id !== 'string' || !entry.user_id || typeof entry.display_name !== 'string' || typeof entry.title !== 'string' || !entry.title || typeof entry.finished_at !== 'string' || !Number.isFinite(Date.parse(entry.finished_at))) return true;
    if (entry.kind === 'session') return typeof entry.set_id !== 'string' || !entry.set_id || !Number.isSafeInteger(entry.answered) || entry.answered! < 1 || entry.minutes !== null;
    if (entry.kind === 'manual') return entry.set_id !== null || (entry.answered !== null && (!Number.isSafeInteger(entry.answered) || entry.answered < 0 || entry.answered > 2000)) || !Number.isSafeInteger(entry.minutes) || entry.minutes! < 1 || entry.minutes! > 1440;
    return true;
  }) || new Set(feed.entries.map(entry => entry.id)).size !== feed.entries.length) throw new Error('活動を読み込めません。');
  return feed;
}
