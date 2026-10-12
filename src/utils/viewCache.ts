/** Short-lived, memory-only previews. Never use these values to authorize a write. */
export function createViewCache<T>(maxAge = 60_000, capacity = 8) {
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    read(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) { entries.delete(key); return undefined; }
      return entry.value;
    },
    write(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + maxAge });
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
    },
    clear() { entries.clear(); },
  };
}
