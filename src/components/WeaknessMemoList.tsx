import { useRef, useState } from 'react';
import { deleteWeaknessNote, type WeaknessNote } from '../utils/weaknessNotes';
import './WeaknessNotes.css';
import { writeClipboardText } from '../utils/nativePlatform';
import { ClipboardCopyFallback } from './ClipboardCopyFallback';

export function WeaknessMemoList({ notes, disabled = false, onDeleted }: { notes: WeaknessNote[]; disabled?: boolean; onDeleted?: (id: string) => void }) {
  const [deleting, setDeleting] = useState('');
  const [error, setError] = useState('');
  const [copying, setCopying] = useState(''), [copyText, setCopyText] = useState(''), [copyMessage, setCopyMessage] = useState('');
  const lock = useRef(false);
  const remove = async (note: WeaknessNote) => {
    if (disabled || lock.current || !window.confirm(`このメモを削除しますか？\n\n${note.body.slice(0,120)}\n\n追加解説・メモと画像は残ります。`)) return;
    lock.current = true; setDeleting(note.id); setError('');
    try { await deleteWeaknessNote(note); onDeleted?.(note.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'メモを削除できませんでした。'); }
    finally { lock.current = false; setDeleting(''); }
  };
  const copy = async (note: WeaknessNote) => {
    if (copying || deleting) return;
    setCopying(note.id); setCopyText(''); setCopyMessage('');
    try { await writeClipboardText(note.body); setCopyMessage('メモをコピーしました'); }
    catch { setCopyText(note.body); }
    finally { setCopying(''); }
  };
  return <div className="weakness-saved-memos">
    {notes.map((note, index) => <article key={note.id} className="weakness-saved-memo">
      <header><strong>メモ {index + 1}</strong><span>{note.resolvedBody === note.body ? '回答済み' : '未回答'}</span><button type="button" className="weakness-saved-memo__copy" disabled={Boolean(copying || deleting)} aria-label={`メモ${index + 1}をコピー`} onClick={() => void copy(note)}>{copying === note.id ? 'コピー中…' : 'コピー'}</button><button type="button" disabled={disabled || Boolean(deleting || copying)} aria-label={`メモ${index + 1}を削除`} onClick={() => void remove(note)}>{deleting === note.id ? '削除中…' : '削除'}</button></header>
      <p>{note.body}</p>
    </article>)}
    {error && <p className="weakness-error" role="alert">{error}</p>}
    {copyMessage ? <p className="weakness-muted" role="status">{copyMessage}</p> : null}
    {copyText ? <ClipboardCopyFallback text={copyText} onCopied={() => { setCopyText(''); setCopyMessage('メモをコピーしました'); }} /> : null}
  </div>;
}
