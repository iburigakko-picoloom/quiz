import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppData, Difficulty, ProblemSet, ProblemSetCreationMethod } from '../types';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Layout } from '../components/Layout';
import { ChevronRightIcon, CopyIcon, DocumentOutlineIcon, StudyIcon } from '../components/UiIcons';
import { getDraftAnswerIndexes, parseBulkQuestionText, getDraftIssues, type BulkQuestionDraft } from '../utils/bulkQuestionParser';
import { CreationNotes } from './CreationNotes';
import {
  CHATGPT_MATERIAL_TEMPLATE_PROMPT,
  CHATGPT_PAST_EXAM_TEMPLATE_PROMPT,
  IMPORT_RESOURCE_LIMITS,
  validateImportJson,
} from '../utils/importValidator';
import { writeClipboardText } from '../utils/nativePlatform';
import {
  hasUncommittedManualQuestion,
  inspectPendingManualQuestion,
  normalizeDraftAnswers,
  normalizeEditableQuestionDraft,
  resolvePendingQuestionSave,
  type PendingManualQuestion,
  type PendingQuestionSaveDecision,
} from './createProblemSetSave';
import './CreateProblemSetScreen.css';
import { buildSimpleCreationPrompt } from '../utils/simpleCreationPrompt';

export interface CreateProblemSetSubmission {
  folderId: string;
  newFolderName: string;
  title: string;
  description: string;
  subject: string;
  audience: string;
  difficulty: Difficulty;
  source: string;
  creationMethod: ProblemSetCreationMethod;
  sourceSetId?: string;
  questions: BulkQuestionDraft[];
}

export interface LegacyImportTarget {
  folderId: string;
  newFolderName: string;
}

interface CreateProblemSetScreenProps {
  data: AppData;
  onSave: (submission: CreateProblemSetSubmission) => Promise<string | null>;
  onOpenLegacyImport: (target: LegacyImportTarget) => void;
  onDirtyChange?: (dirty: boolean) => void;
  initialFolderId?: string;
  editSetId?: string;
  copySetId?: string;
  onBack?: () => void;
}

type CreationView = 'methods' | 'manual' | 'bulk' | 'chatgpt' | 'copy' | 'other' | 'notes';

interface SetMeta {
  folderId: string;
  newFolderName: string;
  title: string;
  description: string;
  subject: string;
  audience: string;
  difficulty: Difficulty;
  source: string;
}

export function CreateProblemSetScreen({ data, onSave, onOpenLegacyImport, onDirtyChange, initialFolderId, editSetId, copySetId, onBack }: CreateProblemSetScreenProps) {
  const editingProblemSet = data.problemSets.find((problemSet) => problemSet.id === editSetId);
  const initialDraftsRef = useRef<BulkQuestionDraft[]>(createDraftsFromProblemSet(data, editingProblemSet));
  const [view, setView] = useState<CreationView>(editingProblemSet ? 'manual' : 'methods');
  const [meta, setMeta] = useState<SetMeta>(() => createInitialMeta(data, initialFolderId, editingProblemSet));
  const [drafts, setDrafts] = useState<BulkQuestionDraft[]>(() => initialDraftsRef.current);
  const [questionEditor, setQuestionEditor] = useState<BulkQuestionDraft>(() => createBlankDraft('manual-editor'));
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [sourceSetId, setSourceSetId] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState<'simple' | 'material' | 'past-exam' | ''>('');
  const [creationRequest, setCreationRequest] = useState('');
  const [aiStep, setAiStep] = useState<1 | 2>(1);
  const [aiMethod, setAiMethod] = useState<'simple' | 'material' | 'past-exam'>('simple');
  const [choiceCount, setChoiceCount] = useState<4 | 5>(4);
  const [questionCount, setQuestionCount] = useState('20');
  const [allowMultiple, setAllowMultiple] = useState(false);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const [pendingMethod, setPendingMethod] = useState<CreationView | null>(null);
  const [pendingQuestionSave, setPendingQuestionSave] = useState<PendingManualQuestion | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const [notePromptCopied, setNotePromptCopied] = useState(false);
  const initializedCopyRef = useRef<string | undefined>(undefined);
  const saveInFlightRef = useRef(false);
  const initialMetaRef = useRef(meta);
  const activeMethodRef = useRef<CreationView | null>(editingProblemSet ? 'manual' : null);
  const copiedTemplateTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTemplateTimerRef.current !== null) window.clearTimeout(copiedTemplateTimerRef.current);
  }, []);

  const reviewedDrafts = useMemo(() => drafts.map(refreshIssues), [drafts]);
  const needsReviewCount = reviewedDrafts.filter((draft) => draft.issues.length > 0).length;
  const hasUncommittedQuestion = useMemo(
    () => hasUncommittedManualQuestion(drafts, questionEditor, editingIndex),
    [drafts, editingIndex, questionEditor],
  );
  const isDirty = useMemo(() => (
    JSON.stringify(meta) !== JSON.stringify(initialMetaRef.current)
    || JSON.stringify(drafts) !== JSON.stringify(initialDraftsRef.current)
    || pasteText.trim().length > 0
    || creationRequest.trim().length > 0
    || sourceSetId !== undefined
    || hasUncommittedQuestion
    || notesDirty
  ), [creationRequest, drafts, hasUncommittedQuestion, meta, pasteText, sourceSetId, notesDirty]);
  const creationMethod: ProblemSetCreationMethod = sourceSetId
    ? 'copy'
    : view === 'chatgpt'
      ? 'chatgpt'
      : view === 'bulk'
        ? 'bulk'
      : 'manual';

  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const goTo = (next: CreationView) => {
    setError('');
    setView(next);
  };

  const resetAndStartMethod = (next: CreationView) => {
    setMeta(createInitialMeta(data, initialFolderId));
    setDrafts([]);
    setQuestionEditor(createBlankDraft('manual-editor'));
    setEditingIndex(null);
    setPasteText('');
    setCreationRequest('');
    setAiStep(1);
    setNotePromptCopied(false);
    setSourceSetId(undefined);
    setError('');
    setView(next);
    activeMethodRef.current = next;
  };

  const startMethod = (next: CreationView) => {
    if (activeMethodRef.current === next) {
      setError('');
      setView(next === 'copy' && sourceSetId ? 'manual' : next);
      return;
    }
    if (isDirty) {
      setPendingMethod(next);
      return;
    }
    resetAndStartMethod(next);
  };

  const addOrUpdateQuestion = () => {
    const nextQuestion = refreshIssues(questionEditor);
    if (nextQuestion.issues.length > 0) {
      setQuestionEditor(nextQuestion);
      setError(nextQuestion.issues.join('。'));
      return;
    }
    if (editingIndex === null) setDrafts((items) => [...items, { ...nextQuestion, id: `manual-${items.length + 1}` }]);
    else setDrafts((items) => items.map((item, index) => index === editingIndex ? { ...nextQuestion, id: item.id } : item));
    setQuestionEditor(createBlankDraft(`manual-${drafts.length + 2}`));
    setEditingIndex(null);
    setError('');
  };

  const editQuestion = (index: number) => {
    const target = reviewedDrafts[index];
    if (!target) return;
    setQuestionEditor({ ...target, choices: [...target.choices] });
    setEditingIndex(index);
    document.querySelector<HTMLElement>('.app-layout__scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const deleteQuestion = (index: number) => {
    setDrafts((items) => items.filter((_, itemIndex) => itemIndex !== index));
    if (editingIndex === index) {
      setEditingIndex(null);
      setQuestionEditor(createBlankDraft('manual-editor'));
    } else if (editingIndex !== null && editingIndex > index) {
      setEditingIndex(editingIndex - 1);
    }
  };

  const parsePastedContent = () => {
    if (!pasteText.trim()) {
      setError('貼り付ける内容を入力してください。');
      return;
    }
    const generated = parseGeneratedContent(pasteText);
    if (generated.questions.length === 0) {
      setError('問題を読み取れませんでした。問題文、選択肢、正解を分けて入力してください。');
      return;
    }
    setDrafts(generated.questions.map(normalizeEditableQuestionDraft));
    setError('');
  };

  const importJsonFile = async (file: File) => {
    setBusy(true);
    try {
      if (file.size > IMPORT_RESOURCE_LIMITS.maxFileBytes) throw new Error('8MB以内のJSONファイルを選んでください。');
      const text = await file.text();
      const result = validateImportJson(text);
      if (!result.ok) throw new Error('問題セットのJSONを読み取れませんでした。内容を確認してください。');
      setMeta((current) => ({ ...current, title: current.title.trim() ? current.title : result.value.setTitle, source: current.source || result.value.source || '' }));
      setPasteText(text);
      setDrafts(parseGeneratedContent(text).questions.map(normalizeEditableQuestionDraft));
      setAiStep(2);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ファイルを読み込めませんでした。'); }
    finally { setBusy(false); }
  };

  const persistDrafts = async (finalDrafts: BulkQuestionDraft[]) => {
    if (saveInFlightRef.current) return false;
    saveInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const saveError = await onSave({ ...meta, creationMethod, sourceSetId, questions: finalDrafts });
      if (saveError) {
        setError(saveError);
        return false;
      }
      return true;
    } catch {
      setError('問題セットを保存できませんでした。時間をおいてもう一度お試しください。');
      return false;
    } finally {
      saveInFlightRef.current = false;
      setBusy(false);
    }
  };

  const submit = async () => {
    if (saveInFlightRef.current) return;
    const metaError = getMetaError(meta);
    if (metaError) {
      setError(metaError);
      return;
    }
    const finalDrafts = reviewedDrafts.map(normalizeEditableQuestionDraft).map(refreshIssues);
    if (finalDrafts.length === 0) {
      setError('1問以上追加してください。');
      return;
    }
    if (finalDrafts.some((draft) => draft.issues.length > 0)) {
      setDrafts(finalDrafts);
      setError('確認が必要な問題を修正してください。正解は自動では決めません。');
      return;
    }
    if (view === 'manual') {
      const pending = inspectPendingManualQuestion(finalDrafts, questionEditor, editingIndex, getDraftIssues);
      if (pending) {
        setQuestionEditor(pending.draft);
        setPendingQuestionSave(pending);
        setError('');
        return;
      }
    }
    await persistDrafts(finalDrafts);
  };

  const resolveManualQuestionBeforeSave = async (decision: PendingQuestionSaveDecision) => {
    const pending = pendingQuestionSave;
    if (!pending || saveInFlightRef.current) return;
    const finalDrafts = reviewedDrafts.map(normalizeEditableQuestionDraft).map(refreshIssues);
    const resolution = resolvePendingQuestionSave(finalDrafts, pending, decision);
    if (resolution.status === 'cancel') {
      setPendingQuestionSave(null);
      return;
    }
    if (resolution.status === 'invalid') {
      setPendingQuestionSave(null);
      setQuestionEditor(pending.draft);
      setError(`入力中の問題を追加するには、${resolution.issues.join('、')}。`);
      return;
    }
    setPendingQuestionSave(null);
    const saved = await persistDrafts(resolution.drafts);
    if (saved) {
      setDrafts(resolution.drafts);
      setQuestionEditor(createBlankDraft('manual-editor'));
      setEditingIndex(null);
    }
  };

  const openLegacyImport = () => {
    const newFolderName = meta.newFolderName.trim();
    if (!meta.folderId && !newFolderName) {
      setError('追加先のフォルダ名を入力してください。');
      return;
    }
    setError('');
    onOpenLegacyImport({
      folderId: meta.folderId,
      newFolderName: meta.folderId ? '' : newFolderName,
    });
  };

  const chooseCopySource = (setId: string) => {
    const problemSet = data.problemSets.find((set) => set.id === setId);
    if (!problemSet) return;
    const copiedQuestions = data.questions
      .filter((question) => question.setId === setId)
      .map((question, index) => refreshIssues({
        id: `copy-${index + 1}`,
        question: question.question,
        choices: [...question.choices],
        distractors: question.distractors,
        shuffleChoices: question.shuffleChoices,
        answerIndex: question.answerIndex,
        answerIndexes: question.answerIndexes?.length ? [...question.answerIndexes] : [question.answerIndex],
        explanation: question.explanation,
        detailedExplanation: question.detailedAnswer?.body ?? question.detailedExplanation ?? '',
        detailedAnswer: question.detailedAnswer,
        questionImageIds: question.questionImageIds,
        category: question.category,
        sourcePage: question.sourcePage,
        difficulty: question.difficulty,
        issues: [],
      }));
    setMeta({
      folderId: problemSet.folderId,
      newFolderName: '',
      title: `${problemSet.title}のコピー`,
      description: problemSet.description ?? '',
      subject: problemSet.subject ?? '',
      audience: problemSet.audience ?? '',
      difficulty: problemSet.difficulty ?? 'basic',
      source: problemSet.source,
    });
    setDrafts(copiedQuestions);
    setSourceSetId(problemSet.id);
    activeMethodRef.current = 'copy';
    setView('manual');
    setError('');
  };

  useEffect(() => {
    if (!copySetId || initializedCopyRef.current === copySetId) return;
    initializedCopyRef.current = copySetId;
    chooseCopySource(copySetId);
  }, [copySetId]);

  const copyPromptTemplate = async (kind: 'simple' | 'material' | 'past-exam') => {
    const count = Number(questionCount);
    if (!Number.isInteger(count) || count < 1 || count > 2000) {
      setError('問題数は1〜2000の整数で入力してください。');
      return;
    }
    try {
      const template = kind === 'simple' ? buildSimpleCreationPrompt(creationRequest) : kind === 'material'
        ? CHATGPT_MATERIAL_TEMPLATE_PROMPT
        : CHATGPT_PAST_EXAM_TEMPLATE_PROMPT;
      await writeClipboardText(`${template}\n\n【今回の作成条件：上記の既定値・例より優先】\n問題数：${count}問。各問のchoicesは必ず${choiceCount}個（${choiceCount}択）。追加の誤答候補はchoicesとは別に管理してください。\n${allowMultiple ? '複数回答の問題を含めても構いません。複数回答ではanswerIndexesを使い、正解は2個以上かつ選択肢数未満にし、問題文に「すべて選べ」と明示してください。単一回答も使用できます。' : '全問を単一回答にしてください。正解は必ず1個で、answerIndexを使用してください。複数回答問題は作らないでください。'}\n資料に根拠が足りない場合は捏造して問題数を埋めないでください。`);
      setCopiedTemplate(kind);
      setError('');
      if (copiedTemplateTimerRef.current !== null) window.clearTimeout(copiedTemplateTimerRef.current);
      copiedTemplateTimerRef.current = window.setTimeout(() => setCopiedTemplate(''), 2200);
    } catch {
      setError('プロンプトをコピーできませんでした。');
    }
  };

  return (
    <Layout>
      <main className={`create-set${view === 'methods' ? ' create-set--chooser' : ''}`}>
        <header className={`create-set__header${view === 'methods' && !onBack ? ' create-set__header--root' : ''}`}>
          {view === 'methods' ? (
            onBack ? <BackButton onClick={onBack} label="前の画面へ戻る" /> : null
          ) : (
            <BackButton
              onClick={(editingProblemSet || copySetId) && onBack ? onBack : () => view === 'chatgpt' && aiStep === 2 ? setAiStep(1) : goTo('methods')}
              label={editingProblemSet || copySetId ? '問題セットへ戻る' : view === 'chatgpt' && aiStep === 2 ? 'ステップ1へ戻る' : '作成方法へ戻る'}
            />
          )}
          <div>
            <h1>{editingProblemSet ? '問題セットを編集' : getViewTitle(view, sourceSetId)}</h1>
          </div>
        </header>

        {view === 'methods' ? <MethodChooser onSelect={startMethod} /> : null}
        <div className="create-set__flow" hidden={view !== 'notes'}>
          <CreationNotes onDirtyChange={setNotesDirty} onGenerate={() => { setNotePromptCopied(true); setAiStep(2); goTo('chatgpt'); activeMethodRef.current = 'chatgpt'; }} />
        </div>

        {view === 'manual' ? (
          <div className="create-set__flow">
            {editingProblemSet ? <p className="create-set__notice">問題セットの情報と問題を編集できます。内容を変更した問題は、学習記録をリセットします。</p> : null}
            <SetMetaFields data={data} value={meta} onChange={setMeta} />
            <section className="create-set__panel">
              <div className="create-set__section-heading">
                <div><span>問題 {drafts.length + 1}</span><h2>{editingIndex === null ? '問題を追加' : `${editingIndex + 1}問目を編集中`}</h2></div>
                {editingIndex !== null ? <button type="button" className="create-set__text-button" onClick={() => { setEditingIndex(null); setQuestionEditor(createBlankDraft('manual-editor')); }}>編集をやめる</button> : null}
              </div>
              <QuestionFields value={questionEditor} onChange={setQuestionEditor} />
              <button type="button" className="create-set__primary" onClick={addOrUpdateQuestion}>
                {editingIndex === null ? '追加して次の問題へ' : '変更を反映'}
              </button>
            </section>
            <DraftList drafts={reviewedDrafts} onEdit={editQuestion} onDelete={deleteQuestion} />
            {reviewedDrafts.length > 0 ? <SaveBar count={reviewedDrafts.length} busy={busy} disabled={false} label={editingProblemSet ? '変更を保存' : '問題セットを保存'} onSave={() => void submit()} /> : null}
          </div>
        ) : null}

        {(view === 'bulk' || view === 'chatgpt') ? (
          <div className="create-set__flow">
            {view === 'chatgpt' ? (
              <nav className="create-set__steps" aria-label="生成AIで作る手順">
                <button type="button" aria-current={aiStep === 1 ? 'step' : undefined} onClick={() => setAiStep(1)}><span>STEP 1</span>問題を作る</button>
                <button type="button" aria-current={aiStep === 2 ? 'step' : undefined} onClick={() => setAiStep(2)}><span>STEP 2</span>JSONを取り込む</button>
              </nav>
            ) : null}
            {view === 'chatgpt' && aiStep === 1 ? <section className="create-set__ai-methods" aria-label="問題を作る方法">
              <nav className="create-set__method-tabs" aria-label="作成方法">{([['simple', '説明から作る'], ['material', '資料から作る'], ['past-exam', '過去問から作る']] as const).map(([method, label]) => <button type="button" key={method} aria-pressed={aiMethod === method} onClick={() => setAiMethod(method)}>{label}</button>)}<span className="create-set__method-indicator" aria-hidden="true" style={{ transform: `translateX(calc(${['simple', 'material', 'past-exam'].indexOf(aiMethod) * 100}% + ${['simple', 'material', 'past-exam'].indexOf(aiMethod) * 6}px))` }} /></nav>
              <div className="create-set__generation-options">
                <fieldset><legend>選択肢数</legend><div>{([4, 5] as const).map((count) => <button type="button" key={count} aria-pressed={choiceCount === count} onClick={() => setChoiceCount(count)}>{count}択</button>)}</div></fieldset>
                <label>問題数<input type="number" min={1} max={2000} step={1} inputMode="numeric" value={questionCount} onChange={(event) => setQuestionCount(event.target.value)} /></label>
                <label className="create-set__multiple-option"><input type="checkbox" checked={allowMultiple} onChange={(event) => setAllowMultiple(event.target.checked)} />複数回答を許可</label>
              </div>
              <article className="create-set__ai-method" hidden={aiMethod !== 'simple'}>
                <h2><span>1</span>説明から作る</h2>
                <label className="create-set__field"><span>作りたい問題集の説明</span><textarea rows={3} value={creationRequest} maxLength={2000} onChange={(event) => setCreationRequest(event.target.value)} /></label>
                <button type="button" className="create-set__ai-copy" disabled={!creationRequest.trim()} onClick={() => void copyPromptTemplate('simple')}><CopyIcon size={18} />{copiedTemplate === 'simple' ? 'コピーしました' : '依頼文を作成・コピー'}</button>
              </article>
              <article className="create-set__ai-method" hidden={aiMethod !== 'material'}>
                <h2><span>2</span>資料から作る</h2>
                <div className="create-set__ai-copy-row"><button type="button" className="create-set__ai-copy" onClick={() => void copyPromptTemplate('material')}><CopyIcon size={18} />{copiedTemplate === 'material' ? 'コピーしました' : '資料用プロンプトをコピー'}</button></div>
              </article>
              <article className="create-set__ai-method" hidden={aiMethod !== 'past-exam'}>
                <h2><span>3</span>過去問から作る</h2>
                <div className="create-set__ai-copy-row"><button type="button" className="create-set__ai-copy" onClick={() => void copyPromptTemplate('past-exam')}><CopyIcon size={18} />{copiedTemplate === 'past-exam' ? 'コピーしました' : '過去問用プロンプトをコピー'}</button></div>
              </article>
              <button type="button" className="create-set__primary" onClick={() => setAiStep(2)}>ステップ2へ <ChevronRightIcon size={18} /></button>
            </section> : null}
            {view !== 'chatgpt' || aiStep === 2 ? <>
            {notePromptCopied ? <p className="create-set__notice" role="status">依頼文をコピーしました</p> : null}
            <SetMetaFields data={data} value={meta} onChange={setMeta} />
            <section className="create-set__panel">
              <h2>{view === 'chatgpt' ? '作成されたJSONを貼り付ける' : '複数の問題'}</h2>
              <input ref={jsonFileRef} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importJsonFile(file); }} />
              <button type="button" className="create-set__ai-copy" disabled={busy} onClick={() => jsonFileRef.current?.click()}><DocumentOutlineIcon size={18} />{busy ? '読み込み中…' : 'JSONファイルを選ぶ'}</button>
              <textarea className="create-set__paste" value={pasteText} onChange={(event) => setPasteText(event.target.value)} aria-label={view === 'chatgpt' ? '問題セットJSON' : '問題の貼り付け欄'} />
              <button type="button" className="create-set__primary" onClick={parsePastedContent}>{view === 'chatgpt' ? 'JSONを読み取る' : '読み取って確認'}</button>
            </section>
            {reviewedDrafts.length > 0 ? (
              <section className="create-set__review" aria-label="読み取り結果">
                <div className="create-set__review-summary">
                  <div><strong>{reviewedDrafts.length - needsReviewCount}</strong><span>保存できる問題</span></div>
                  <div className={needsReviewCount ? 'create-set__summary-warning' : ''}><strong>{needsReviewCount}</strong><span>確認が必要</span></div>
                </div>
                {reviewedDrafts.map((draft, index) => (
                  <InlineDraftCard
                    key={draft.id}
                    index={index}
                    value={draft}
                    onChange={(next) => setDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? next : item))}
                    onDelete={() => setDrafts((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                  />
                ))}
              </section>
            ) : null}
            {reviewedDrafts.length > 0 ? <SaveBar count={reviewedDrafts.length} busy={busy} disabled={needsReviewCount > 0} onSave={() => void submit()} /> : null}
            </> : null}
          </div>
        ) : null}

        {view === 'copy' ? (
          <section className="create-set__panel create-set__copy-list">
            {data.problemSets.length === 0 ? <p>コピーできる問題セットがまだありません。</p> : data.problemSets.map((problemSet) => {
              const questionCount = data.questions.filter((question) => question.setId === problemSet.id).length;
              return (
                <button key={problemSet.id} type="button" className="create-set__method" onClick={() => chooseCopySource(problemSet.id)}>
                  <span><strong>{problemSet.title}</strong><small>{questionCount}問・コピー後に編集できます</small></span><ChevronRightIcon />
                </button>
              );
            })}
          </section>
        ) : null}

        {view === 'other' ? (
          <section className="create-set__panel create-set__other">
            <SetMetaFields data={data} value={meta} onChange={setMeta} compact />
            <button type="button" className="create-set__method" onClick={openLegacyImport}>
              <span className="create-set__method-icon"><DocumentOutlineIcon /></span><span><strong>問題セットファイルを読み込む</strong></span><ChevronRightIcon />
            </button>
          </section>
        ) : null}

        {error ? <div className="create-set__error" role="alert">{error}</div> : null}
      </main>
      <ConfirmDialog
        open={pendingMethod !== null}
        title="作成方法を切り替えますか？"
        message="現在入力している問題や貼り付け内容は破棄されます。"
        confirmLabel="破棄して切り替え"
        onCancel={() => setPendingMethod(null)}
        onConfirm={() => {
          const next = pendingMethod;
          setPendingMethod(null);
          if (next) resetAndStartMethod(next);
        }}
      />
      <PendingQuestionSaveDialog
        pending={pendingQuestionSave}
        busy={busy}
        onDecision={(decision) => void resolveManualQuestionBeforeSave(decision)}
      />
    </Layout>
  );
}

function PendingQuestionSaveDialog({
  pending,
  busy,
  onDecision,
}: {
  pending: PendingManualQuestion | null;
  busy: boolean;
  onDecision: (decision: PendingQuestionSaveDecision) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const includeButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const onDecisionRef = useRef(onDecision);
  const busyRef = useRef(busy);
  const titleId = useId();
  const messageId = useId();
  const issuesId = useId();
  const open = pending !== null;
  onDecisionRef.current = onDecision;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const preferredButton = pending?.issues.length === 0 ? includeButtonRef.current : cancelButtonRef.current;
    preferredButton?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) onDecisionRef.current('cancel');
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
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!pending) return null;
  const canInclude = pending.issues.length === 0;
  const isEditing = pending.editingIndex !== null;
  const describedBy = canInclude ? messageId : `${messageId} ${issuesId}`;

  return createPortal(
    <div
      className="create-set__pending-overlay"
      role="presentation"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onDecision('cancel');
      }}
    >
      <div
        ref={cardRef}
        className="create-set__pending-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy}
        tabIndex={-1}
      >
        <h2 id={titleId}>{isEditing ? '編集中の変更があります' : '入力中の問題があります'}</h2>
        <p id={messageId} className="create-set__pending-message">
          {isEditing
            ? 'この変更は、まだ追加済みの問題へ反映されていません。保存方法を選んでください。'
            : 'この問題は、まだ追加済みの一覧へ反映されていません。保存方法を選んでください。'}
        </p>
        <div className={`create-set__pending-status${canInclude ? '' : ' create-set__pending-status--warning'}`}>
          <strong>{canInclude ? 'この内容を保存できます' : '追加するには修正が必要です'}</strong>
          <p>{pending.draft.question.trim() || '問題文は未入力です'}</p>
          {!canInclude ? (
            <div id={issuesId}>
              <span>不足している項目</span>
              <ul>{pending.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </div>
          ) : null}
        </div>
        <div className="create-set__pending-actions">
          <button
            ref={includeButtonRef}
            type="button"
            className="create-set__pending-button create-set__pending-button--include"
            disabled={busy || !canInclude}
            onClick={() => onDecision('include')}
          >
            {isEditing ? '変更を反映して保存' : '追加して保存'}
          </button>
          <button
            type="button"
            className="create-set__pending-button create-set__pending-button--discard"
            disabled={busy}
            onClick={() => onDecision('discard')}
          >
            {isEditing ? '変更を破棄して保存' : '入力を破棄して保存'}
          </button>
          <button
            ref={cancelButtonRef}
            type="button"
            className="create-set__pending-button create-set__pending-button--cancel"
            disabled={busy}
            onClick={() => onDecision('cancel')}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MethodChooser({ onSelect }: { onSelect: (view: CreationView) => void }) {
  const methods: Array<{ view: CreationView; title: string; icon: React.ReactNode }> = [
    { view: 'chatgpt', title: '生成AIで作る', icon: <CopyIcon /> },
    { view: 'notes', title: '苦手メモ', icon: <StudyIcon /> },
  ];
  return <section className="create-set__methods" aria-label="作成方法">{methods.map((method) => <button key={method.view} type="button" className="create-set__method" onClick={() => onSelect(method.view)}><span className="create-set__method-icon">{method.icon}</span><span><strong>{method.title}</strong></span><ChevronRightIcon /></button>)}
  </section>;
}

function SetMetaFields({ data, value, onChange, compact = false }: { data: AppData; value: SetMeta; onChange: (value: SetMeta) => void; compact?: boolean }) {
  const useNewFolder = !value.folderId;
  return (
    <section className={`create-set__panel${compact ? ' create-set__panel--compact' : ''}`}>
      {!compact ? <h2>問題セットの基本情報</h2> : <h2>追加先</h2>}
      <label className="create-set__field"><span>フォルダ</span><select value={value.folderId || '__new__'} onChange={(event) => onChange({ ...value, folderId: event.target.value === '__new__' ? '' : event.target.value })}>{data.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}<option value="__new__">新しいフォルダを作る</option></select></label>
      {useNewFolder ? <label className="create-set__field"><span>新しいフォルダ名</span><input value={value.newFolderName} onChange={(event) => onChange({ ...value, newFolderName: event.target.value })} /></label> : null}
      {!compact ? <>
        <label className="create-set__field"><span>問題セット名 <b>必須</b></span><input value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} /></label>
      </> : null}
    </section>
  );
}

function QuestionFields({ value, onChange }: { value: BulkQuestionDraft; onChange: (value: BulkQuestionDraft) => void }) {
  const choices = normalizeEditableQuestionDraft(value).choices;
  const answerIndexes = getDraftAnswerIndexes({ ...value, choices });
  return (
    <div className="create-set__question-fields">
      <label className="create-set__field"><span>問題文 <b>必須</b></span><textarea value={value.question} onChange={(event) => onChange({ ...value, question: event.target.value })} /></label>
      <fieldset className="create-set__choices"><legend>選択肢と正解 <b>必須・複数選択可</b></legend>{choices.map((choice, index) => <div key={index} className="create-set__choice-row"><input type="checkbox" checked={answerIndexes.includes(index)} onChange={(event) => onChange(updateDraftAnswerSelection(value, choices, index, event.target.checked))} aria-label={`${index + 1}番を正解にする`} /><input value={choice} onChange={(event) => onChange({ ...value, choices: choices.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} aria-label={`選択肢 ${index + 1}`} />{index === 4 ? <button type="button" aria-label="5番目の選択肢を削除" onClick={() => onChange(normalizeDraftAnswers({ ...value, choices: choices.slice(0, 4) }))}>×</button> : null}</div>)}{choices.length === 4 ? <button type="button" className="create-set__text-button" onClick={() => onChange({ ...value, choices: [...choices, ''] })}>＋ 5番目の選択肢</button> : null}</fieldset>
      <label className="create-set__field"><span>解説</span><textarea value={value.explanation} onChange={(event) => onChange({ ...value, explanation: event.target.value })} /></label>
      <details>
        <summary>選択肢のランダム出題</summary>
        <label><input type="checkbox" checked={value.shuffleChoices !== false && (value.shuffleChoices === true || Boolean(value.distractors?.length))} onChange={(event) => onChange({ ...value, shuffleChoices: event.target.checked })} />誤答の抽選・位置の入れ替え</label>
        <label className="create-set__field"><span>追加の誤答候補（1行に1つ・50個まで）</span><textarea value={value.distractors?.join('\n') ?? ''} onChange={(event) => onChange({ ...value, distractors: event.target.value.split('\n'), shuffleChoices: true })} /></label>
      </details>
      <label className="create-set__field"><span>詳細解説</span><textarea value={value.detailedExplanation ?? ''} onChange={(event) => onChange({ ...value, detailedExplanation: event.target.value })} /></label>
      <label className="create-set__field"><span>難易度</span><select value={value.difficulty ?? ''} onChange={(event) => onChange({ ...value, difficulty: event.target.value || undefined })}><option value="">問題セットと同じ</option><option value="basic">基礎</option><option value="standard">標準</option><option value="advanced">発展</option></select></label>
      <div className="create-set__field-grid"><label className="create-set__field"><span>分類</span><input value={value.category} onChange={(event) => onChange({ ...value, category: event.target.value })} /></label><label className="create-set__field"><span>参照</span><input value={value.sourcePage} onChange={(event) => onChange({ ...value, sourcePage: event.target.value })} /></label></div>
      {value.issues.length > 0 ? <ul className="create-set__issues">{value.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
    </div>
  );
}

function DraftList({ drafts, onEdit, onDelete }: { drafts: BulkQuestionDraft[]; onEdit: (index: number) => void; onDelete: (index: number) => void }) {
  if (drafts.length === 0) return null;
  return <section className="create-set__panel"><div className="create-set__section-heading"><div><span>追加済み</span><h2>{drafts.length}問</h2></div></div><div className="create-set__draft-list">{drafts.map((draft, index) => { const answers = getDraftAnswerIndexes(draft).map((answerIndex) => draft.choices[answerIndex]).filter(Boolean); return <article key={draft.id} className="create-set__draft"><span>{index + 1}</span><div><strong>{draft.question}</strong><small>正解：{answers.length ? answers.join(' / ') : '未確認'}</small></div><button type="button" onClick={() => onEdit(index)}>編集</button><button type="button" className="create-set__delete" onClick={() => onDelete(index)}>削除</button></article>; })}</div></section>;
}

function InlineDraftCard({ index, value, onChange, onDelete }: { index: number; value: BulkQuestionDraft; onChange: (value: BulkQuestionDraft) => void; onDelete: () => void }) {
  return <details className={`create-set__review-card${value.issues.length ? ' create-set__review-card--warning' : ''}`} open={value.issues.length > 0}><summary><span>{index + 1}</span><div><strong>{value.question || '問題文が未入力です'}</strong><small>{value.issues.length ? `要確認：${value.issues.join('・')}` : '確認済み'}</small></div></summary><QuestionFields value={value} onChange={(next) => onChange(refreshIssues(next))} /><button type="button" className="create-set__delete-draft" onClick={onDelete}>この問題を削除</button></details>;
}

function SaveBar({ count, busy, disabled, label = '問題セットを保存', onSave }: { count: number; busy: boolean; disabled: boolean; label?: string; onSave: () => void }) {
  return <div className="create-set__save-bar"><span>{count}問</span><button type="button" className="create-set__primary" disabled={busy || disabled} onClick={onSave}>{busy ? '保存中…' : label === '問題セットを保存' ? `${count}問を保存` : label}</button></div>;
}

function createInitialMeta(data: AppData, initialFolderId?: string, problemSet?: ProblemSet): SetMeta {
  if (problemSet) {
    return {
      folderId: problemSet.folderId,
      newFolderName: '',
      title: problemSet.title,
      description: problemSet.description ?? '',
      subject: problemSet.subject ?? '',
      audience: problemSet.audience ?? '',
      difficulty: problemSet.difficulty ?? 'basic',
      source: problemSet.source,
    };
  }
  const preferredFolderId = data.folders.some((folder) => folder.id === initialFolderId)
    ? initialFolderId!
    : data.folders[0]?.id ?? '';
  return { folderId: preferredFolderId, newFolderName: data.folders.length ? '' : 'マイ問題セット', title: '', description: '', subject: '', audience: '', difficulty: 'basic', source: '' };
}

function createDraftsFromProblemSet(data: AppData, problemSet?: ProblemSet): BulkQuestionDraft[] {
  if (!problemSet) return [];
  return data.questions
    .filter((question) => question.setId === problemSet.id)
    .map((question) => refreshIssues({
      id: question.id,
      question: question.question,
      choices: [...question.choices],
      distractors: question.distractors,
      shuffleChoices: question.shuffleChoices,
      answerIndex: question.answerIndex,
      answerIndexes: question.answerIndexes?.length ? [...question.answerIndexes] : [question.answerIndex],
      explanation: question.explanation,
      detailedExplanation: question.detailedAnswer?.body ?? question.detailedExplanation ?? '',
        detailedAnswer: question.detailedAnswer,
        questionImageIds: question.questionImageIds,
      category: question.category,
      sourcePage: question.sourcePage,
      difficulty: question.difficulty,
      issues: [],
    }));
}

function createBlankDraft(id: string): BulkQuestionDraft {
  return { id, question: '', choices: ['', '', '', ''], answerIndex: null, answerIndexes: [], explanation: '', detailedExplanation: '', category: '', sourcePage: '', issues: [] };
}

function refreshIssues(draft: BulkQuestionDraft): BulkQuestionDraft {
  return { ...draft, issues: getDraftIssues(draft) };
}

function updateDraftAnswerSelection(draft: BulkQuestionDraft, choices: string[], index: number, checked: boolean): BulkQuestionDraft {
  const current = getDraftAnswerIndexes({ ...draft, choices });
  const answerIndexes = checked
    ? Array.from(new Set([...current, index])).sort((left, right) => left - right)
    : current.filter((answerIndex) => answerIndex !== index);
  return { ...draft, choices, answerIndex: answerIndexes[0] ?? null, answerIndexes };
}

function parseGeneratedContent(text: string) {
  const jsonResult = validateImportJson(text);
  if (jsonResult.ok) {
    const questions = jsonResult.value.questions.map((question, index) => refreshIssues(normalizeDraftAnswers({ id: `generated-${index + 1}`, question: question.question, choices: [...question.choices], distractors: question.distractors, shuffleChoices: question.shuffleChoices, answerIndex: question.answerIndex ?? question.answerIndexes?.[0] ?? null, answerIndexes: question.answerIndexes?.length ? [...question.answerIndexes] : undefined, explanation: question.explanation, detailedExplanation: question.detailedExplanation ?? '', category: question.category ?? '', sourcePage: question.sourcePage ?? question.reference ?? '', difficulty: question.difficulty, issues: [] })));
    return { questions };
  }
  return parseBulkQuestionText(text);
}

function getMetaError(meta: SetMeta) {
  if (!meta.folderId && !meta.newFolderName.trim()) return '追加先のフォルダ名を入力してください。';
  if (!meta.title.trim()) return '問題セット名を入力してください。';
  return '';
}

function getViewTitle(view: CreationView, sourceSetId?: string) {
  if (view === 'methods') return '問題セットを作る';
  if (view === 'manual') return sourceSetId ? 'コピーを編集' : '問題を編集';
  if (view === 'bulk') return 'CSVを確認';
  if (view === 'chatgpt') return '生成AIで作る';
  if (view === 'notes') return '苦手メモ';
  if (view === 'copy') return 'コピー元を選ぶ';
  return 'その他の方法';
}
