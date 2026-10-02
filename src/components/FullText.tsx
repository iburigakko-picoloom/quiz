import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registerTransientDialog } from '../utils/transientDialog';
import './FullText.css';

export function FullText({ text, label = '全文表示' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    const unregister = registerTransientDialog(() => setOpen(false));
    return () => { unregister(); previous?.focus({ preventScroll: true }); };
  }, [open]);
  return <><button type="button" className="full-text-open" data-no-page-swipe onClick={() => setOpen(true)}>{label}</button>
    {open ? createPortal(<dialog ref={dialog} className="full-text-dialog" aria-labelledby={titleId} data-no-page-swipe onCancel={() => setOpen(false)}>
      <header><h2 id={titleId}>問題・選択肢の全文</h2><button type="button" onClick={() => setOpen(false)}>戻る</button></header>
      <div className="full-text-dialog__body">{text}</div>
    </dialog>, document.body) : null}</>;
}
