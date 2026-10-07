/** A guard stopped a still-safe operation; this is not a transport failure. */
export class SyncInterruptedError extends Error {
  readonly reason: 'protected_work' | 'connection_changed' | 'mode_changed';
  constructor(reason: 'protected_work' | 'connection_changed' | 'mode_changed', message: string) {
    super(message); this.name = 'SyncInterruptedError'; this.reason = reason;
  }
}

export class SyncLocalPersistenceError extends Error {
  readonly code = 'local_persistence_failed';
  constructor(message: string) { super(message); this.name = 'SyncLocalPersistenceError'; }
}

export class SyncProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message); this.name = 'SyncProtocolError';
    this.code = /^[a-z_]{1,64}$/u.test(code) ? code : 'invalid_response';
  }
}
