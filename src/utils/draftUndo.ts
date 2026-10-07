export interface DraftDeletion<T extends { id: string }> { item: T; beforeId?: string; afterId?: string; index: number }
export function captureDraftDeletion<T extends { id: string }>(items: T[], index: number): DraftDeletion<T> {
  return { item: items[index], index, beforeId: items[index - 1]?.id, afterId: items[index + 1]?.id };
}
/** Restore only the deleted draft, retaining every later edit and addition. */
export function restoreDraftDeletion<T extends { id: string }>(items: T[], deleted: DraftDeletion<T>): T[] {
  if (items.some(item => item.id === deleted.item.id)) return items;
  const after = items.findIndex(item => item.id === deleted.afterId), before = items.findIndex(item => item.id === deleted.beforeId);
  const index = after >= 0 ? after : before >= 0 ? before + 1 : Math.min(deleted.index, items.length);
  return [...items.slice(0, index), deleted.item, ...items.slice(index)];
}
