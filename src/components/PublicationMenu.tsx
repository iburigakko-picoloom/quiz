import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

export function PublicationMenu({ title, busy, onRemove, onMove, onAdd }: { title: string; busy: boolean; onRemove: () => void; onMove?: () => void; onAdd?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="publication-menu-trigger" aria-label={`${title}の公開メニュー`} aria-haspopup="dialog" disabled={busy} onClick={() => setOpen(true)}>⋯</button>
    <ConfirmDialog open={open} title="公開の管理" message={title} alternateLabel={onMove ? 'フォルダを移動' : onAdd ? '問題セットを追加' : undefined} onAlternate={onMove || onAdd ? () => { setOpen(false); (onMove ?? onAdd)?.(); } : undefined} cancelLabel="閉じる" confirmLabel="公開を取り消す" busy={busy} onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); onRemove(); }} />
  </>;
}
