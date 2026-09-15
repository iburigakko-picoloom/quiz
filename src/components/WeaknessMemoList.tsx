import { useRef, useState } from 'react';
import { deleteWeaknessNote, type WeaknessNote } from '../utils/weaknessNotes';
import './WeaknessNotes.css';

export function WeaknessMemoList({ notes, disabled = false, onDeleted }: { notes: WeaknessNote[]; disabled?: boolean; onDeleted?: (id: string) => void }) {
  const [deleting, setDeleting] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);
  const remove = async (note: WeaknessNote) => {
    if (disabled || lock.current || !window.confirm(`このメモを削除しますか？\n\n${note.body.slice(0,120)}\n\n詳細解説と画像は残ります。`)) return;
    lock.current = true; setDeleting(note.id); setError('');
    try { await deleteWeaknessNote(note); onDeleted?.(note.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'メモを削除できませんでした。'); }
    finally { lock.current = false; setDeleting(''); }
  };
  return <div className="weakness-saved-memos">
    {notes.map((note, index) => <article key={note.id} className="weakness-saved-memo">
      <header><strong>メモ {index + 1}</strong><span>{note.resolvedBody === note.body ? '回答済み' : '未回答'}</span><button type="button" disabled={disabled || Boolean(deleting)} aria-label={`メモ${index + 1}を削除`} onClick={() => void remove(note)}>{deleting === note.id ? '削除中…' : '削除'}</button></header>
      <p>{note.body}</p>
    </article>)}
    {error && <p className="weakness-error" role="alert">{error}</p>}
  </div>;
}
