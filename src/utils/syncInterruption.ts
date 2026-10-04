/** A guard stopped a still-safe operation; this is not a transport failure. */
export class SyncInterruptedError extends Error {
  readonly reason: 'protected_work' | 'connection_changed' | 'mode_changed';
  constructor(reason: 'protected_work' | 'connection_changed' | 'mode_changed', message: string) {
    super(message); this.name = 'SyncInterruptedError'; this.reason = reason;
  }
}
