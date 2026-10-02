export interface ListPosition { anchorId: string | null; offset: number; order: string[]; focusId: string | null }
export interface ListView<T> { state: T; position: ListPosition | null }
const views = new Map<string, ListView<unknown>>();

export function readListView<T>(key: string): ListView<T> | undefined { return views.get(key) as ListView<T> | undefined; }
export function saveListView<T>(key: string, view: ListView<T>) {
  views.delete(key); views.set(key, view);
  if (views.size > 50) views.delete(views.keys().next().value!);
}
/** Keep a surviving question ID when a row was deleted or reordered. */
export function resolveListAnchor(position: ListPosition, ids: readonly string[]): string | undefined {
  const available = new Set(ids);
  if (position.anchorId && available.has(position.anchorId)) return position.anchorId;
  const index = position.anchorId ? position.order.indexOf(position.anchorId) : -1;
  return [...position.order.slice(index + 1), ...position.order.slice(0, Math.max(0, index)).reverse()].find(id => available.has(id)) ?? ids[0];
}
export function captureListPosition(container: HTMLElement, focusId: string | null): ListPosition {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-item-id]')];
  const top = container.getBoundingClientRect().top;
  const focused = rows.find(row => row.dataset.itemId === focusId);
  const anchor = focused && focused.getBoundingClientRect().bottom > top && focused.getBoundingClientRect().top < container.getBoundingClientRect().bottom ? focused : rows.find(row => row.getBoundingClientRect().bottom > top + 1);
  return { anchorId: anchor?.dataset.itemId ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, order: rows.map(row => row.dataset.itemId!), focusId };
}
export function restoreListPosition(container: HTMLElement, position: ListPosition) {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-item-id]')];
  const anchorId = resolveListAnchor(position, rows.map(row => row.dataset.itemId!));
  const anchor = rows.find(row => row.dataset.itemId === anchorId);
  if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
  const focus = rows.find(row => row.dataset.itemId === position.focusId) ?? anchor;
  if (position.focusId) (focus?.matches('button') ? focus : focus?.querySelector<HTMLElement>('button') ?? container.querySelector<HTMLElement>('input[type=search], button'))?.focus({ preventScroll: true });
}
