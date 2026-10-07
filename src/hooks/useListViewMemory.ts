import { useLayoutEffect, useRef, type RefObject } from 'react';
import { captureListPosition, readListView, restoreListPosition, saveListView } from '../utils/listViewMemory';

export function useListViewMemory<T>(key: string, state: T, container: RefObject<HTMLElement | null>) {
  const stateRef = useRef(state); stateRef.current = state;
  const focusRef = useRef<string | null>(readListView<T>(key)?.position?.focusId ?? null);
  const remember = (focusId: string | null = focusRef.current) => {
    focusRef.current = focusId;
    saveListView(key, { state: stateRef.current, position: container.current ? captureListPosition(container.current, focusId) : null });
  };
  useLayoutEffect(() => {
    const el = container.current, saved = readListView<T>(key);
    if (el && saved?.position) restoreListPosition(el, saved.position);
    return () => { if (el) saveListView(key, { state: stateRef.current, position: captureListPosition(el, focusRef.current) }); };
  }, [key, container]);
  return remember;
}
