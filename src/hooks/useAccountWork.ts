import { useLayoutEffect, useRef, useState } from 'react';
import { registerAccountWork, getRestoredAccountWork, consumeRestoredAccountWork } from '../utils/accountWork';
export function useAccountWork(key: string, snapshot: () => unknown, flush?: () => Promise<void>) {
  const latest = useRef({ snapshot, flush }); latest.current = { snapshot, flush };
  useLayoutEffect(() => registerAccountWork(key, () => latest.current.snapshot(), flush ? () => latest.current.flush?.() ?? Promise.resolve() : undefined), [key, Boolean(flush)]);
}
export function useRestoredAccountWork<T>(key: string): T | undefined {
  const [value] = useState(() => getRestoredAccountWork<T>(key));
  // Consume on commit: React StrictMode invokes initializers twice before effects.
  useLayoutEffect(() => { consumeRestoredAccountWork(key); }, [key]);
  return value;
}
