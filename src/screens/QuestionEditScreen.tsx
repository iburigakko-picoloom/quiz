import { useEffect, useRef, useState } from 'react';
import type { Question } from '../types';
import { Layout } from '../components/Layout';
import { getAnswerIndexes } from '../utils/quiz';

export function QuestionEditScreen({ question, onBack, onDirtyChange, onSave }: {
  question: Question; onBack: () => void; onDirtyChange: (dirty: boolean) => void;
  onSave: (next: Question, original: Question) => Promise<string | null>;
}) {
  const original = useRef(question);
  const [draft, setDraft] = useState(question);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const answers = getAnswerIndexes(draft);
  const dirty = JSON.stringify(original.current) !== JSON.stringify(draft);
  useEffect(() => { onDirtyChange(dirty || busy); return () => onDirtyChange(false); }, [dirty, busy, onDirtyChange]);
  const valid = draft.question.trim() && draft.choices.every((choice) => choice.trim()) && answers.length > 0;
  const save = async () => {
    if (!valid || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { const issue = await onSave(draft, original.current); if (issue) setError(issue); }
    catch { setError('保存できませんでした。入力内容を残しています。'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <Layout><main className="library-page qm-editor">
    <header className="library-page__header"><button onClick={onBack} disabled={busy}>閉じる</button><h1>問題を編集</h1></header>
    <label>分類<input value={draft.category} disabled={busy} onChange={(event) => setDraft({...draft, category:event.target.value})} /></label>
    <label>問題文<textarea value={draft.question} disabled={busy} onChange={(event) => setDraft({...draft, question:event.target.value})} /></label>
    <fieldset disabled={busy}><legend>選択肢と正解（複数選択可）</legend>{draft.choices.map((choice,index) => <div className="qm-choice-edit" key={index}>
      <input type="checkbox" checked={answers.includes(index)} aria-label={`${index + 1}番を正解にする`} onChange={(event) => {
        const next = event.target.checked ? [...answers, index].sort((a,b) => a-b) : answers.filter((value) => value !== index);
        setDraft({...draft, answerIndex:next[0] ?? -1, answerIndexes:next});
      }} />
      <input aria-label={`選択肢 ${index+1}`} value={choice} onChange={(event) => setDraft({...draft, choices:draft.choices.map((value,i) => i === index ? event.target.value : value) as Question['choices']})} />
    </div>)}<button type="button" onClick={() => {
      const choices = (draft.choices.length === 4 ? [...draft.choices, ''] : draft.choices.slice(0,4)) as Question['choices'];
      const next = answers.filter((index) => index < choices.length);
      setDraft({...draft, choices, answerIndex:next[0] ?? -1, answerIndexes:next});
    }}>{draft.choices.length === 4 ? '＋ 5番目の選択肢' : '5番目の選択肢を削除'}</button></fieldset>
    <label>解説<textarea value={draft.explanation} disabled={busy} onChange={(event) => setDraft({...draft, explanation:event.target.value})} /></label>
    {error ? <p role="alert" className="qm-wrong">{error}</p> : null}
    <button className="qm-primary" disabled={!valid || !dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
    <button className="qm-secondary" disabled={busy} onClick={onBack}>キャンセル</button>
  </main></Layout>;
}
