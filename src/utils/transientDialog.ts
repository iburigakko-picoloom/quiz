let closeHandler: (() => void) | null = null;
export function registerTransientDialog(close: () => void) {
  closeHandler = close;
  return () => { if (closeHandler === close) closeHandler = null; };
}
export function tryCloseTransientDialog(): boolean {
  if (!closeHandler) return false;
  const close = closeHandler; closeHandler = null; close(); return true;
}
