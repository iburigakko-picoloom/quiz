import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppData } from '../types';
import { canMoveFolder, folderChoices, moveFolder, moveProblemSet } from '../utils/folderHierarchy';

interface Props {
  data: AppData;
  kind: 'folder' | 'set';
  id: string;
  onSave: (data: AppData) => Promise<boolean>;
  onDelete: () => void;
  onAddSet?: () => void;
}

export function LibraryItemActions({ data, kind, id, onSave, onDelete, onAddSet }: Props) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  const [mode, setMode] = useState<'rename' | 'move' | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folder = kind === 'folder' ? data.folders.find((item) => item.id === id) : undefined;
  const set = kind === 'set' ? data.problemSets.find((item) => item.id === id) : undefined;
  const current = folder?.parentFolderId ?? set?.folderId ?? '';
  const choices = kind === 'folder'
    ? data.folders.filter((item) => canMoveFolder(data.folders, id, item.id))
    : folderChoices(data.folders);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const timestamp = new Date().toISOString();
      const next = mode === 'move'
        ? kind === 'folder' ? moveFolder(data, id, value || undefined) : moveProblemSet(data, id, value)
        : kind === 'folder'
          ? { ...data, folders: data.folders.map((item) => item.id === id ? { ...item, name: value.trim(), updatedAt: timestamp } : item) }
          : { ...data, problemSets: data.problemSets.map((item) => item.id === id ? { ...item, title: value.trim(), updatedAt: timestamp } : item) };
      if (await onSave(next)) { setMode(null); setOpen(false); }
      else setError('保存できませんでした。もう一度お試しください。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存できませんでした。'); }
    finally { setBusy(false); }
  };
  return <div className="library-actions">
    <button type="button" className="library-actions__trigger" aria-label={`${folder?.name ?? set?.title ?? ''}の操作`} aria-haspopup="dialog" onClick={() => { setMode(null); setError(''); setOpen(true); }}>…</button>
    {createPortal(<dialog ref={dialogRef} className="library-actions__body library-actions__dialog" aria-label={`${folder?.name ?? set?.title ?? ''}の操作`} onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => setOpen(false)}>
      {mode ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{mode === 'rename' ? '名前' : '移動先'}</label>
        {mode === 'rename' ? <input aria-label="名前" value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} autoFocus />
          : <div className="library-destinations">
            {kind === 'folder' ? <label><input type="radio" name={`move-${id}`} checked={value === ''} disabled={current === '' || busy} onChange={() => setValue('')} />ホーム直下{current === '' ? '（現在）' : ''}</label> : null}
            {choices.map((item) => <label key={item.id} className={item.parentFolderId ? 'library-destination--child' : ''}>
              <input type="radio" name={`move-${id}`} checked={value === item.id} disabled={item.id === current || busy} onChange={() => setValue(item.id)} />
              {item.name}{item.id === current ? '（現在）' : ''}
            </label>)}
          </div>}
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy || (mode === 'rename' ? !value.trim() : value === current)}>{busy ? '保存中…' : mode === 'rename' ? '保存' : 'ここに移動'}</button>
        <button type="button" disabled={busy} onClick={() => setMode(null)}>キャンセル</button>
      </form> : <>
        {onAddSet ? <button type="button" onClick={() => { setOpen(false); onAddSet(); }}>このフォルダに問題セットを追加</button> : null}
        <button type="button" onClick={() => { setValue(folder?.name ?? set?.title ?? ''); setError(''); setMode('rename'); }}>名前変更</button>
        <button type="button" onClick={() => { setValue(current); setError(''); setMode('move'); }}>移動</button>
        <button type="button" className="library-danger" onClick={() => { dialogRef.current?.close(); setOpen(false); onDelete(); }}>削除</button>
        <button type="button" onClick={() => setOpen(false)}>閉じる</button>
      </>}
    </dialog>, document.body)}
  </div>;
}
