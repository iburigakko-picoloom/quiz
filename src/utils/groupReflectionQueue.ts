/** Coalesce answers arriving during a request, then read the latest durable data.
 * Serial writes prevent a slower, older aggregate from replacing a newer one. */
export function createGroupReflectionQueue(reflect: (setIds: string[]) => Promise<void>) {
  const pending = new Set<string>();
  let running: Promise<void> | null = null;
  return (setIds: readonly string[]): Promise<void> => {
    setIds.forEach(id => pending.add(id));
    if (!running) running = Promise.resolve().then(async () => {
      try {
        while (pending.size) {
          const batch = [...pending]; pending.clear();
          await reflect(batch);
        }
      } finally { running = null; }
    });
    return running;
  };
}

export const GROUP_PROGRESS_UPDATED = 'quizmake:group-progress-updated';

/** Refresh visible group views, including after returning from another app. */
export function watchGroupProgress(refresh: () => void) {
  const update = () => { if (document.visibilityState === 'visible') refresh(); };
  const timer = window.setInterval(update, 10_000);
  window.addEventListener('focus', update);
  window.addEventListener('online', update);
  window.addEventListener(GROUP_PROGRESS_UPDATED, update);
  document.addEventListener('visibilitychange', update);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', update);
    window.removeEventListener('online', update);
    window.removeEventListener(GROUP_PROGRESS_UPDATED, update);
    document.removeEventListener('visibilitychange', update);
  };
}
