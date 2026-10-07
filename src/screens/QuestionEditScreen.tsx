import { useEffect, useRef, useState } from 'react';
import { useAccountWork, useRestoredAccountWork } from '../hooks/useAccountWork';
import type { Question } from '../types';
import { Layout } from '../components/Layout';
import { getAnswerIndexes } from '../utils/quiz';
import { BackButton } from '../components/BackButton';
import { QuestionEditNotice } from '../components/QuestionEditNotice';

export function QuestionEditScreen({ question, onBack, onDirtyChange, onSave }: {
  question: Question; onBack: () => void; onDirtyChange: (dirty: boolean) => void;
  onSave: (next: Question, original: Question) => Promise<string | null>;
}) {
  const workKey = `question-edit:${question.id}`;
  const recovered = useRestoredAccountWork<{ original: Question; draft: Question }>(workKey);
  const original = useRef(recovered?.original ?? question);
  const [draft, setDraft] = useState(recovered?.draft ?? question);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  useAccountWork(workKey, () => ({ original: original.current, draft }), async () => { if(busyRef.current)throw new Error('問題の保存完了を待っています。'); });
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
    <header className="library-page__header"><BackButton onClick={onBack} disabled={busy} /><h1>問題を編集</h1><button disabled={!valid || !dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></header>
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
    {dirty ? <QuestionEditNotice original={original.current} next={draft} /> : null}
    {!valid ? <p role="status">保存するには、問題文・すべての選択肢・1つ以上の正解が必要です。</p> : null}
    {error ? <p role="alert" className="qm-wrong">{error}</p> : null}
    <button className="qm-primary" disabled={!valid || !dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
    <button className="qm-secondary" disabled={busy} onClick={onBack}>戻る</button>
  </main></Layout>;
}
