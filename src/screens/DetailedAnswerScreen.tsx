import { useEffect, useRef, useState } from 'react';
import type { Question } from '../types';
import { Layout } from '../components/Layout';
import { readClipboardText } from '../utils/nativePlatform';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function DetailedAnswerScreen({ question, editing, onBack, onEdit, onDirtyChange, onSave }: {
  question: Question; editing: boolean; onBack: () => void; onEdit: () => void;
  onDirtyChange: (value: boolean) => void; onSave: (body: string, original: Question) => Promise<string | null>;
}) {
  const original = useRef(question);
  const initial = original.current.detailedAnswer?.body ?? original.current.detailedExplanation ?? '';
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => { onDirtyChange(editing && (body !== initial || busy)); return () => onDirtyChange(false); }, [body,initial,busy,editing,onDirtyChange]);
  const save = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const issue = await onSave(body, original.current); if (issue) setError(issue); }
    catch { setError('保存できませんでした。入力内容を残しています。'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Layout><main className="library-page qm-editor">
    <header className="library-page__header"><button disabled={busy} onClick={onBack}>閉じる</button><h1>{editing ? '詳細解答を編集' : '詳細解答'}</h1>{!editing ? <button aria-label="詳細解答を編集" onClick={onEdit}>編集</button> : null}</header>
    {editing ? <>
      <button className="qm-secondary" disabled={busy} onClick={async () => {
        try { const text = await readClipboardText(); setBody((current) => current ? `${current}\n\n${text}` : text); setError(''); }
        catch { setError('クリップボードを読み取れません。本文欄へ貼り付けてください。'); }
      }}>クリップボードから貼り付け</button>
      <label>本文<textarea className="qm-detail-body" disabled={busy} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      {error ? <p role="alert" className="qm-wrong">{error}</p> : null}
      <button className="qm-secondary" disabled={busy} onClick={onBack}>キャンセル</button>
      <button className="qm-primary" disabled={busy || body === initial} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
    </> : <section className="question-detail-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{question.detailedAnswer?.body ?? question.detailedExplanation ?? ''}</ReactMarkdown></section>}
  </main></Layout>;
}
