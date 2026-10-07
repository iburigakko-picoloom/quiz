type KeyboardOverlay = EventTarget & { overlaysContent: boolean; boundingRect: DOMRect };
let activeLock: (() => void) | null = null;

export function memoDockTop(top: number, height: number, visibleBottom: number): number {
  return Math.max(8, Math.min(top, visibleBottom - height - 8));
}

/** Hold the reading surface in place; only the memo editor follows the keyboard. */
export function lockMemoKeyboard(anchor: HTMLElement, onVisibleBottom: (bottom: number) => void): () => void {
  activeLock?.();
  const root = document.documentElement;
  const height = window.innerHeight;
  const viewport = window.visualViewport;
  const keyboard = (navigator as Navigator & { virtualKeyboard?: KeyboardOverlay }).virtualKeyboard;
  const previousOverlay = keyboard?.overlaysContent;
  const previousHeight = root.style.getPropertyValue('--memo-layout-height');
  const hadClass = root.classList.contains('memo-keyboard-fixed');
  const sheet = anchor.closest<HTMLElement>('.answer-sheet');
  const previousSheetTop = sheet?.style.getPropertyValue('--memo-sheet-top') ?? '';
  const previousSheetHeight = sheet?.style.getPropertyValue('--memo-sheet-height') ?? '';
  const scroll = { x: window.scrollX, y: window.scrollY };
  const ancestors: { element: HTMLElement; top: number; left: number }[] = [];
  for (let element = anchor.parentElement; element; element = element.parentElement) {
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) ancestors.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }
  if (sheet) {
    const bounds = sheet.getBoundingClientRect();
    sheet.style.setProperty('--memo-sheet-top', `${bounds.top}px`);
    sheet.style.setProperty('--memo-sheet-height', `${bounds.height}px`);
    sheet.dataset.memoKeyboardAnchor = '';
  }
  root.style.setProperty('--memo-layout-height', `${height}px`);
  root.classList.add('memo-keyboard-fixed');
  try { if (keyboard) keyboard.overlaysContent = true; } catch { /* VisualViewport remains the fallback. */ }
  const started = performance.now();
  let released = false, frame: number | null = null, manualScroll = false;
  const update = () => {
    frame = null;
    if (released || viewport && Math.abs(viewport.scale - 1) > .01) return;
    const rect = keyboard?.boundingRect;
    const bottom = rect && rect.height > 0 ? rect.top : Math.min(height, viewport ? viewport.height + viewport.offsetTop : window.innerHeight);
    onVisibleBottom(height - bottom > 100 || rect && rect.height > 0 ? bottom : height);
    if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo(scroll.x, scroll.y);
    // Cancel the browser's focus scroll during keyboard animation, while keeping
    // subsequent deliberate scrolling and scrolling inside the textarea intact.
    if (!manualScroll && performance.now() - started < 800) {
      for (const item of ancestors) { item.element.scrollTop = item.top; item.element.scrollLeft = item.left; }
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
  const touchMove = () => { manualScroll = true; };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  keyboard?.addEventListener('geometrychange', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('touchmove', touchMove, { passive: true });
  schedule();
  const release = () => {
    if (released) return;
    released = true;
    if (frame !== null) cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    keyboard?.removeEventListener('geometrychange', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('touchmove', touchMove);
    if (!hadClass) root.classList.remove('memo-keyboard-fixed');
    if (previousHeight) root.style.setProperty('--memo-layout-height', previousHeight); else root.style.removeProperty('--memo-layout-height');
    if (sheet) {
      delete sheet.dataset.memoKeyboardAnchor;
      if (previousSheetTop) sheet.style.setProperty('--memo-sheet-top', previousSheetTop); else sheet.style.removeProperty('--memo-sheet-top');
      if (previousSheetHeight) sheet.style.setProperty('--memo-sheet-height', previousSheetHeight); else sheet.style.removeProperty('--memo-sheet-height');
    }
    try { if (keyboard && previousOverlay !== undefined) keyboard.overlaysContent = previousOverlay; } catch { /* Unsupported setting. */ }
    if (activeLock === release) activeLock = null;
  };
  activeLock = release;
  return release;
}
