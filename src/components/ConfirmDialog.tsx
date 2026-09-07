import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ConfirmDialog.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  fullPage?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '\u524a\u9664\u3059\u308b',
  cancelLabel = '\u30ad\u30e3\u30f3\u30bb\u30eb',
  busy = false,
  fullPage = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  const titleId = useId();
  const messageId = useId();
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const buttons = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (buttons.length === 0) {
        event.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && busy) cardRef.current?.focus();
  }, [busy, open]);

  if (!open) return null;

  return createPortal(
    <div
      className={`confirm-dialog${fullPage ? ' confirm-dialog--full-page' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="confirm-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <h2 id={titleId} className="confirm-dialog__title">{title}</h2>
        <p id={messageId} className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__actions">
          <button ref={cancelButtonRef} type="button" className="confirm-dialog__button confirm-dialog__button--cancel" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-dialog__button confirm-dialog__button--danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
