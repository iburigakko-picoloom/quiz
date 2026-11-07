// Screen-local drill-downs are handled after dialogs and before app navigation.
let handler: (() => void) | null = null;
export function registerScreenBack(back: () => void) {
  handler = back;
  return () => { if (handler === back) handler = null; };
}
export function tryScreenBack() {
  if (!handler) return false;
  handler();
  return true;
}
