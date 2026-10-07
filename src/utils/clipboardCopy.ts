export class ClipboardCopyError extends Error {
  constructor() { super('自動コピーが使えません。文章を選択してコピーしてください。'); this.name = 'ClipboardCopyError'; }
}

function copySelectedText(value: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = value; textarea.readOnly = true; textarea.tabIndex = -1;
  textarea.setAttribute('aria-hidden', 'true');
  Object.assign(textarea.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', fontSize: '16px', pointerEvents: 'none' });
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true }); textarea.select(); textarea.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    textarea.remove();
    focused?.focus({ preventScroll: true });
    if (selection && ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}

/** Invoked in the click handler, before awaiting persistence or other work. */
export async function copyBrowserText(value: string | Promise<string>): Promise<void> {
  if (typeof value === 'string') {
    // The synchronous route keeps the current tap on browsers that reject
    // clipboard permission. Never retry only after an asynchronous rejection.
    if (copySelectedText(value)) return;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
    } catch { /* The caller can offer a visible text selection. */ }
    throw new ClipboardCopyError();
  }
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const contents = value.then(text => new Blob([text], { type: 'text/plain' }));
    // Some browsers reject before they observe the promised content. The
    // preparation failure is still propagated by awaiting the original value.
    void contents.catch(() => undefined);
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': contents })]); await value; return; }
    catch {
      const text = await value;
      if (copySelectedText(text)) return;
      throw new ClipboardCopyError();
    }
  }
  // Older browsers can use the prepared-text retry button with a fresh tap.
  await copyBrowserText(await value);
}
