import type { AppData, MaterialReference, Question } from '../types';
import { useEffect, useRef, useState } from 'react';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { StudyIcon } from '../components/UiIcons';
import { getQuestionsBySet } from '../utils/quiz';
import { usePhoneLayout } from '../utils/usePhoneLayout';
import { detailBody, NOTES_EVENT, readWeaknessNotes, unexplainedNotes, makeExplanationRequest, rememberExplanationRequest, explanationPrompt, type WeaknessNote } from '../utils/weaknessNotes';
import { writePreparedClipboardText } from '../utils/nativePlatform';
import { ClipboardCopyError } from '../utils/clipboardCopy';
import { ClipboardCopyFallback } from '../components/ClipboardCopyFallback';
import { normalizeExplanationMarkdown } from '../utils/explanationMarkdown';
import { ExplanationReader } from '../components/WeaknessDetail';
import { WeaknessMemoList } from '../components/WeaknessMemoList';
import { MaterialsDrawer } from '../components/MaterialsDrawer';
import { useMaterialsNavigation, type MaterialsExitGuard } from '../hooks/useMaterialsNavigation';
import type { ReferenceLink } from '../utils/referenceLinking';
import './NoteOverviewScreen.css';

export function NoteOverviewScreen({ data, setId, onBack, onOpenDetail, onImport, registerExitGuard, onLinkPage, onLinkBatch }: {
  data: AppData; setId: string; onBack: () => void; onOpenDetail: (questionId: string) => void; onImport: () => void;
  registerExitGuard?: (guard: MaterialsExitGuard | null) => void;
  onLinkPage?: (questionId: string, reference: MaterialReference, linked: boolean) => Promise<void>;
  onLinkBatch?: (links: ReferenceLink[]) => Promise<void>;
}) {
  const phone = usePhoneLayout();
  const materials = useMaterialsNavigation(registerExitGuard);
  const [materialQuestionId, setMaterialQuestionId] = useState('');
  const materialQuestion = data.questions.find(question => question.id === materialQuestionId);
  const [launcherTarget, setLauncherTarget] = useState<HTMLSpanElement | null>(null);
  const [notes, setNotes] = useState<WeaknessNote[]>([]);
  const [notesError, setNotesError] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [copyError, setCopyError] = useState('');
  const [copyText, setCopyText] = useState('');
  const [copyFallback, setCopyFallback] = useState(false);
  const copyLock = useRef(false);
  useEffect(() => {
    const load = () => { try { setNotes(readWeaknessNotes()); setNotesError(false); } catch { setNotesError(true); } };
    load();
    window.addEventListener(NOTES_EVENT, load); window.addEventListener('storage', load);
    return () => { window.removeEventListener(NOTES_EVENT, load); window.removeEventListener('storage', load); };
  }, []);
  const set = data.problemSets.find((item) => item.id === setId);
  const questions = getQuestionsBySet(data, setId);
  const detailedQuestions = questions.filter(question => normalizeExplanationMarkdown(detailBody(question)).trim() || question.detailedAnswer?.imageIds.length);
  const moveToMaterial = (question: Question) => materials.transition(async () => {
    setMaterialQuestionId(question.id);
    await materials.drawer.current?.openReference(question.materialReferences?.[0]);
  });
  const pending = unexplainedNotes(data, notes, setId);
  const copyPending = async () => {
    if (copyLock.current) return;
    copyLock.current = true; setCopying(true); setCopyMessage(''); setCopyError(''); setCopyText(''); setCopyFallback(false);
    try {
      const request = makeExplanationRequest(unexplainedNotes(data, readWeaknessNotes(), setId), data);
      const text = explanationPrompt(request, { tables: true, images: false, examples: false });
      const ready = rememberExplanationRequest(request).then(() => { setCopyText(text); return text; });
      await writePreparedClipboardText(ready);
      setCopyMessage(`${request.targets.length}問分をコピーしました`);
    } catch (error) { if (error instanceof ClipboardCopyError) setCopyFallback(true); else setCopyError(error instanceof Error ? error.message : 'コピーできませんでした。'); }
    finally { copyLock.current = false; setCopying(false); }
  };
  return <Layout><main className="library-page note-overview materials-study-page">
    <header className="library-page__header"><BackButton onClick={() => void materials.transition(onBack)} /><h1>追加解説・メモ一覧</h1><span ref={setLauncherTarget} /></header>
    <MaterialsDrawer ref={materials.drawer} problemSetId={setId} setIds={data.problemSets.map(item => item.id)} questionId={materialQuestionId} references={materialQuestion?.materialReferences} questions={questions} onLinkBatch={onLinkBatch} onLinkPage={onLinkPage && materialQuestionId ? (reference, linked) => onLinkPage(materialQuestionId, reference, linked) : undefined} launcherTarget={launcherTarget} open={materials.open} onOpenChange={materials.setOpen} />
    {materials.error ? <p role="alert">{materials.error}</p> : null}
    {set ? <>
      <h2 className="note-overview-title">{set.title}</h2>
      <div className="note-overview-copy">
        <div className="note-overview-actions">
          <button type="button" aria-label="未解説メモのプロンプトをコピー" disabled={copying || notesError || !pending.length} onClick={() => void copyPending()}>{copying ? 'コピー中…' : '依頼文をコピー'}</button>
          <button type="button" onClick={() => void materials.transition(onImport)}>AIの回答を取り込む</button>
        </div>
        {copyMessage ? <p role="status">{copyMessage}</p> : null}
        {copyError ? <p role="alert">{copyError}</p> : null}
        {copyFallback && copyText ? <ClipboardCopyFallback text={copyText} onCopied={() => { setCopyFallback(false); setCopyMessage('依頼文をコピーしました'); }} /> : null}
      </div>
      <>
        {notesError ? <p role="alert">メモを読み込めませんでした。解説は下に表示しています。</p> : null}
        <div className="note-explanation-list">
          {detailedQuestions.map(question => {
            const memos = notes.filter(note => note.questionId === question.id && !note.draft && note.body.trim());
            const number = questions.findIndex(item => item.id === question.id) + 1;
            return <article key={question.id} className="note-explanation-item" aria-label={`Q${number}のメモと解説`}>
              <header className="note-explanation-item__header">
                <span className="note-explanation-item__question"><span>Q{number}</span><button type="button" className="material-reference-jump" disabled={!question.materialReferences?.length} title={question.materialReferences?.length ? '参照資料のページへ移動' : '参照ページが未設定です'} aria-label={`Q${number}の資料のページへ移動`} onClick={() => void moveToMaterial(question)}>移動</button></span>
                <button type="button" onClick={() => void materials.transition(() => onOpenDetail(question.id))}>編集・追加</button>
              </header>
              <h3>{question.question}</h3>
              {memos.length ? <section className="note-explanation-item__memos" aria-label="メモ">
                <WeaknessMemoList notes={memos}/>
              </section> : null}
              <section className="note-explanation-item__answer" aria-label="追加解説・メモ">
                <h4>解説</h4>
                <ExplanationReader questionId={question.id} text={detailBody(question)} imageIds={question.detailedAnswer?.imageIds ?? []}/>
              </section>
            </article>;
          })}
        </div>
        {!detailedQuestions.length ? <p>追加解説・メモはまだありません</p> : null}
      </>
      {!phone ? <div className="note-overview-tablet-notes"><button className="library-row" onClick={() => void materials.drawer.current?.openReference()}>
        <span className="library-icon"><StudyIcon size={18} /></span>
        <span className="library-row__body"><strong>資料を開く</strong></span><span aria-hidden="true">›</span>
      </button></div> : null}
    </> : <p>問題セットが見つかりません</p>}
  </main></Layout>;
}
