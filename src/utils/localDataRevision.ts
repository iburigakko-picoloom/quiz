export type LocalDataRevision = number;
export const LOCAL_DATA_SAVED_EVENT = 'quiz-make-local-data-saved';

let currentRevision: LocalDataRevision = 0;
const associatedRevisions = new WeakMap<object, LocalDataRevision>();

/**
 * Returns the revision of the latest successfully persisted app data or note
 * mutation in this JavaScript context.
 */
export function getLocalDataRevision(): LocalDataRevision {
  return currentRevision;
}

/**
 * Advances the revision only after a persistence operation has completed.
 */
export function advanceLocalDataRevision(): LocalDataRevision {
  currentRevision += 1;
  // Every durable app/note/memo write wakes the same upload queue. Never emit
  // this before a save succeeds, and never include the user's content in it.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(LOCAL_DATA_SAVED_EVENT));
  }
  return currentRevision;
}

/**
 * Associates an in-memory snapshot with an exported object without changing
 * its public JSON shape.
 */
export function associateLocalDataRevision<T extends object>(
  value: T,
  revision: LocalDataRevision = getLocalDataRevision(),
): T {
  associatedRevisions.set(value, revision);
  return value;
}

export function getAssociatedLocalDataRevision(value: object): LocalDataRevision | undefined {
  return associatedRevisions.get(value);
}

export function isLocalDataRevisionCurrent(revision: LocalDataRevision): boolean {
  return revision === currentRevision;
}
