import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppData, Question, QuizResult } from '../types';
import { BackButton } from '../components/BackButton';
import { CategoryNoteDrawer, type CategoryNoteDrawerHandle } from '../components/CategoryNoteDrawer';
import { runAfterSuccessfulNoteFlush } from '../components/noteExitGuard';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import { getAnswerIndexes, getAnswerText, getChoiceLabel, getChoiceText, getProgress, getVirtualLevel, makeResult } from '../utils/quiz';
import { resolveQuestionDetailedExplanation } from '../utils/questionView';
import { readClipboardText } from '../utils/nativePlatform';
import { getAnswerFeedback, playAnswerFeedback } from '../utils/answerFeedback';

type AnswerSheetState = 'expanded' | 'default' | 'hidden';

const ENABLE_TABLET_NOTES = true;
const TABLET_LANDSCAPE_QUERY = '(min-width: 768px) and (orientation: landscape)';

export type AnswerHandlerResult = {
  isCorrect: boolean;
  addedToReview: boolean;
  levelLabel?: string;
  saveStatusLabel?: string;
  savePromise: Promise<boolean>;
  retrySave?: () => Promise<boolean>;
};

interface QuizRunnerProps {
  data: AppData;
  title: string;
  subtitle?: string;
  questions: Question[];
  mode: 'quiz' | 'review';
  setId?: string;
  initialIndex?: number;
  readOnly?: boolean;
  emptyState?: {
    title: string;
    description: string;
    actionLabel?: string;
  };
  onBack: () => void;
  onAnswer: (question: Question, selectedIndexes: number[], isReviewMode: boolean) => AnswerHandlerResult;
  onToggleAmbiguous: (questionId: string) => Promise<boolean>;
  onSaveDetailedExplanation: (questionId: string, detailedExplanation: string) => Promise<void>;
  onFinish: (result: QuizResult) => void;
}

export function QuizRunner({ data, title, subtitle, questions, mode, setId, initialIndex = 0, readOnly = false, emptyState, onBack, onAnswer, onToggleAmbiguous, onSaveDetailedExplanation, onFinish }: QuizRunnerProps) {
  const [currentIndex, setCurrentIndex] = useState(() => Math.min(Math.max(initialIndex, 0), Math.max(questions.length - 1, 0)));
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([]);
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [hasAnswered, setHasAnswered] = useState(false);
  const [correctCount, setCorrectCount] = useState(0);
  const sessionAnswersRef = useRef<NonNullable<QuizResult['sessionAnswers']>>([]);
  const submittedQuestionRef = useRef<string | null>(null);
  const [feedback, setFeedback] = useState<'correct' | 'relearned' | 'wrong' | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const [addedReviewCount, setAddedReviewCount] = useState(0);
  const [answerSheetState, setAnswerSheetState] = useState<AnswerSheetState>('default');
  const [savedLevelLabel, setSavedLevelLabel] = useState('');
  const [answerMessage, setAnswerMessage] = useState('');
  const [answerSaveState, setAnswerSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const answerRetryRef = useRef<(() => Promise<boolean>) | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [isTabletLandscape, setIsTabletLandscape] = useState(false);
  const [noteDrawerMounted, setNoteDrawerMounted] = useState(false);
  const [noteTransitionError, setNoteTransitionError] = useState('');
  const noteDrawerRef = useRef<CategoryNoteDrawerHandle>(null);
  const noteTransitionRef = useRef(false);
  const quizRunnerMountedRef = useRef(true);
  const noteFeatureAvailable = ENABLE_TABLET_NOTES && !readOnly && Boolean(setId);
  const noteFeatureEnabled = noteFeatureAvailable && isTabletLandscape;
  const noteAreaOpen = noteFeatureEnabled && noteOpen;

  const requestNoteTransition = useCallback(async (proceed: () => void) => {
    if (noteTransitionRef.current) return false;
    if (!noteOpen || !noteDrawerRef.current) {
      setNoteTransitionError('');
      proceed();
      return true;
    }
    noteTransitionRef.current = true;
    setNoteTransitionError('');
    const completed = await runAfterSuccessfulNoteFlush(
      () => noteDrawerRef.current?.flush() ?? Promise.resolve(),
      () => {
        noteTransitionRef.current = false;
        proceed();
      },
    );
    if (!completed) {
      noteTransitionRef.current = false;
      setNoteTransitionError('ノートを保存できませんでした。操作をもう一度お試しください。');
    }
    return completed;
  }, [noteOpen]);

  const handleQuizBack = useCallback(() => {
    void requestNoteTransition(onBack);
  }, [onBack, requestNoteTransition]);

  useEffect(() => {
    if (!ENABLE_TABLET_NOTES) return;

    const query = window.matchMedia(TABLET_LANDSCAPE_QUERY);
    const update = () => setIsTabletLandscape(query.matches);
    update();

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }

    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  useEffect(() => {
    quizRunnerMountedRef.current = true;
    return () => {
      quizRunnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (noteFeatureEnabled) setNoteDrawerMounted(true);
  }, [noteFeatureEnabled]);

  useEffect(() => {
    if (!noteFeatureEnabled && noteOpen) {
      const drawer = noteDrawerRef.current;
      if (drawer) {
        void drawer.close().then((completed) => {
          if (quizRunnerMountedRef.current) {
            setNoteTransitionError(completed ? '' : 'ノートを保存できませんでした。操作をもう一度お試しください。');
          }
        });
      }
      else setNoteOpen(false);
    }
  }, [noteFeatureEnabled, noteOpen]);

  useEffect(() => {
    document.body.classList.toggle('quiz-note-open', noteAreaOpen);
    return () => document.body.classList.remove('quiz-note-open');
  }, [noteAreaOpen]);

  const currentQuestion = questions[currentIndex];
  const currentDetailedExplanation = useMemo(
    () => resolveQuestionDetailedExplanation(data.questions, currentQuestion),
    [currentQuestion, data.questions],
  );
  const visibleQuestionIdRef = useRef(currentQuestion?.id ?? '');
  visibleQuestionIdRef.current = currentQuestion?.id ?? '';
  const progress = currentQuestion ? getProgress(data, currentQuestion.id) : null;
  const answered = hasAnswered;
  const answerIndexes = useMemo(() => (currentQuestion ? getAnswerIndexes(currentQuestion) : []), [currentQuestion]);
  const answerText = useMemo(() => (currentQuestion ? getAnswerText(currentQuestion) : ''), [currentQuestion]);
  const isMultipleAnswer = answerIndexes.length > 1;
  const instructionInfo = useMemo(() => getQuestionInstructionInfo(currentQuestion), [currentQuestion]);
  const progressPercent = questions.length === 0 ? 0 : ((currentIndex + 1) / questions.length) * 100;
  const registeredQuestionNumber = useMemo(() => {
    if (!currentQuestion) return currentIndex + 1;
    const sameSetQuestions = data.questions.filter((question) => question.setId === currentQuestion.setId);
    const registeredIndex = sameSetQuestions.findIndex((question) => question.id === currentQuestion.id);
    return registeredIndex >= 0 ? registeredIndex + 1 : currentIndex + 1;
  }, [currentIndex, currentQuestion, data.questions]);
  const choiceLengthInfo = useMemo(() => {
    const maxLength = Math.max(0, ...(currentQuestion?.choices.map((choice) => choice.length) ?? []));
    return {
      longChoice: maxLength > 42,
      veryLongChoice: maxLength > 72,
    };
  }, [currentQuestion?.choices]);

  const questionTextClass = useMemo(() => {
    const length = currentQuestion?.question.length ?? 0;
    if (length >= 180) return 'text-[16px]';
    if (length >= 100) return 'text-[17px]';
    return 'text-[18px]';
  }, [currentQuestion?.question]);

  useEffect(() => {
    if (answerSaveState !== 'saving' && answerSaveState !== 'error') return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [answerSaveState]);

  if (questions.length === 0 || !currentQuestion) {
    return (
      <Layout>
        <div className="quiz-runner flex h-full flex-col">
          <QuizHeader title={title} onBack={handleQuizBack} />
          {noteTransitionError ? (
            <div role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-center text-sm font-bold text-red-800">
              {noteTransitionError}
            </div>
          ) : null}
          <MissingResourceState
            title={emptyState?.title ?? '出題できる問題がありません'}
            description={emptyState?.description ?? 'この条件で出題できる問題がありません。問題セットへ戻って条件を確認してください。'}
            actionLabel={emptyState?.actionLabel ?? '問題セットへ戻る'}
            onAction={handleQuizBack}
          />
        </div>
      </Layout>
    );
  }

  const handleChoice = (index: number) => {
    if (answered) return;
    setAnswerMessage('');
    if (isMultipleAnswer) {
      setSelectedIndexes((current) => (
        current.includes(index)
          ? current.filter((item) => item !== index)
          : [...current, index].sort((a, b) => a - b)
      ));
      return;
    }
    setSelectedIndexes([index]);
  };

  const submitAnswer = (indexes: number[]) => {
    if (answered || submittedQuestionRef.current === currentQuestion.id) return;
    submittedQuestionRef.current = currentQuestion.id;
    const normalizedIndexes = Array.from(new Set(indexes)).sort((a, b) => a - b);
    const previousCorrect = progress?.lastAnswerCorrect;
    const result = onAnswer(currentQuestion, normalizedIndexes, mode === 'review');
    const kind = getAnswerFeedback(previousCorrect, result.isCorrect);
    setFeedback(kind);
    playAnswerFeedback(kind);
    sessionAnswersRef.current.push({ question: currentQuestion, selectedIndexes: normalizedIndexes, correct: result.isCorrect, relearned: kind === 'relearned' });
    const answeredQuestionId = currentQuestion.id;
    setSelectedIndexes(normalizedIndexes);
    setLastCorrect(result.isCorrect);
    setHasAnswered(true);
    setAnswerSheetState('default');
    answerRetryRef.current = result.retrySave ?? null;
    if (result.saveStatusLabel) {
      setSavedLevelLabel(result.saveStatusLabel);
    } else {
      setSavedLevelLabel(result.levelLabel ? `\u4fdd\u5b58\u4e2d\u2026\u30fb${result.levelLabel}` : '\u4fdd\u5b58\u4e2d\u2026');
    }
    setAnswerSaveState('saving');
    const settleSave = (savePromise: Promise<boolean>) => void savePromise.then((saved) => {
      if (visibleQuestionIdRef.current !== answeredQuestionId) return;
      setAnswerSaveState(saved ? 'saved' : 'error');
      if (!result.saveStatusLabel) {
        setSavedLevelLabel(saved
          ? (result.levelLabel ? `\u4fdd\u5b58\u6e08\u307f\u30fb${result.levelLabel}` : '\u4fdd\u5b58\u6e08\u307f')
          : (result.levelLabel ? `\u7aef\u672b\u306b\u672a\u4fdd\u5b58\u30fb${result.levelLabel}` : '\u7aef\u672b\u306b\u672a\u4fdd\u5b58'));
      }
    }).catch(() => {
      if (visibleQuestionIdRef.current !== answeredQuestionId) return;
      setAnswerSaveState('error');
      setSavedLevelLabel(result.levelLabel ? `\u7aef\u672b\u306b\u672a\u4fdd\u5b58\u30fb${result.levelLabel}` : '\u7aef\u672b\u306b\u672a\u4fdd\u5b58');
    });
    settleSave(result.savePromise);
    setCorrectCount((value) => value + (result.isCorrect ? 1 : 0));
    setWrongCount((value) => value + (result.isCorrect ? 0 : 1));
    setAddedReviewCount((value) => value + (result.addedToReview ? 1 : 0));
  };

  const handleSubmitAnswer = () => {
    if (selectedIndexes.length === 0) {
      setAnswerMessage('\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044');
      return;
    }
    submitAnswer(selectedIndexes);
  };

  const handleUnknown = () => {
    setAnswerMessage('');
    submitAnswer([]);
  };

  const handleNext = () => {
    if (answerSaveState !== 'saved') return;
    void requestNoteTransition(() => {
      if (currentIndex + 1 >= questions.length) {
        onFinish({
          ...makeResult(mode, title, setId, correctCount, wrongCount, addedReviewCount),
          sessionAnswers: sessionAnswersRef.current,
          retry: {
            questionIds: questions.slice(initialIndex).map((question) => question.id),
            subtitle,
          },
        });
        return;
      }
      setCurrentIndex((value) => value + 1);
      setSelectedIndexes([]);
      setLastCorrect(null);
      setHasAnswered(false);
      submittedQuestionRef.current = null;
      setFeedback(null);
      setAnswerSheetState('default');
      setSavedLevelLabel('');
      setAnswerSaveState('idle');
      answerRetryRef.current = null;
      setAnswerMessage('');
    });
  };

  const handleRetryAnswerSave = () => {
    const retrySave = answerRetryRef.current;
    if (!retrySave || answerSaveState === 'saving') return;
    const answeredQuestionId = currentQuestion.id;
    setAnswerSaveState('saving');
    setSavedLevelLabel('\u4fdd\u5b58\u3092\u518d\u8a66\u884c\u4e2d\u2026');
    void retrySave().then((saved) => {
      if (visibleQuestionIdRef.current !== answeredQuestionId) return;
      setAnswerSaveState(saved ? 'saved' : 'error');
      setSavedLevelLabel(saved ? '\u4fdd\u5b58\u6e08\u307f' : '\u7aef\u672b\u306b\u672a\u4fdd\u5b58');
    }).catch(() => {
      if (visibleQuestionIdRef.current !== answeredQuestionId) return;
      setAnswerSaveState('error');
      setSavedLevelLabel('\u7aef\u672b\u306b\u672a\u4fdd\u5b58');
    });
  };

  const handleAmbiguous = () => onToggleAmbiguous(currentQuestion.id);

  return (
    <Layout>
      <div className={`quiz-runner relative flex h-full flex-col overflow-hidden${noteAreaOpen ? ' quiz-runner--note-open' : ''}`}>
        <QuizHeader title={title} current={currentIndex + 1} total={questions.length} onBack={handleQuizBack} />
        {noteTransitionError ? (
          <div role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-center text-sm font-bold text-red-800">
            {noteTransitionError}
          </div>
        ) : null}

        <ProgressBand
          label={mode === 'review' ? `\u5fa9\u7fd2 Level ${getVirtualLevel(progress ?? undefined)}` : subtitle ?? '\u767b\u9332\u9806'}
          percent={progressPercent}
        />

        <main key={currentQuestion.id} className="quiz-runner__main quiz-runner__question-stage flex min-h-0 flex-1 flex-col">
          <section className="quiz-runner__question-panel flex h-[clamp(104px,17dvh,132px)] shrink-0 items-center justify-center overflow-hidden px-5 py-3 text-center">
            <div className="min-h-0 w-full">
              <div className="quiz-question-kicker">QUESTION {currentIndex + 1}</div>
              {currentQuestion.category ? (
                <div className="quiz-runner__question-category mb-1 truncate text-xs font-semibold">{currentQuestion.category}</div>
              ) : null}
              {(instructionInfo.hasMultiple || instructionInfo.hasNegative) ? (
                <div className="mb-2 flex flex-wrap justify-center gap-1.5">
                  {instructionInfo.hasMultiple ? <span className="question-instruction-badge">{'\u8907\u6570\u9078\u629e'}</span> : null}
                  {instructionInfo.hasNegative ? <span className="question-instruction-badge question-instruction-badge--negative">{'\u5426\u5b9a\u554f\u984c\uff1a\u8aa4\u308a\u3092\u9078\u3076'}</span> : null}
                </div>
              ) : null}
              <div className={['quiz-runner__question-text mx-auto max-h-[96px] overflow-y-auto whitespace-pre-wrap break-words font-semibold leading-[1.45] no-scrollbar', questionTextClass].join(' ')}>
                <span className="sr-only">{registeredQuestionNumber}. </span><HighlightedQuestionText text={currentQuestion.question} phrases={instructionInfo.highlightPhrases} />
              </div>
            </div>
          </section>

          <section className={`quiz-runner__choices flex min-h-0 flex-1 flex-col justify-center gap-2.5 px-6 py-3${answered ? ' quiz-runner__choices--answered' : ''}`}>
            {currentQuestion.choices.map((_, index) => (
              <QuizChoiceButton
                key={`${currentQuestion.id}_${index}`}
                text={getChoiceText(currentQuestion, index)}
                label={getChoiceLabel(index)}
                multiple={isMultipleAnswer}
                choiceCount={currentQuestion.choices.length}
                longChoice={choiceLengthInfo.longChoice}
                veryLongChoice={choiceLengthInfo.veryLongChoice}
                disabled={answered}
                isSelected={selectedIndexes.includes(index)}
                isCorrectChoice={answerIndexes.includes(index)}
                answered={answered}
                onClick={() => handleChoice(index)}
              />
            ))}
          </section>

          <section
            className={`quiz-runner__answer-actions shrink-0 px-5 pb-[max(14px,env(safe-area-inset-bottom))] ${answered ? 'quiz-runner__answer-actions--spacer' : ''}`}
            aria-hidden={answered}
          >
            {!answered && answerMessage ? (
              <p className="quiz-runner__answer-message mb-2 text-center text-sm font-bold">{answerMessage}</p>
            ) : null}
            <div className="quiz-runner__answer-action-grid grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleUnknown}
                disabled={answered}
                className="quiz-runner__unknown-button"
              >
                {'\u308f\u304b\u3089\u306a\u3044'}
              </button>
              <button
                type="button"
                onClick={handleSubmitAnswer}
                disabled={answered || selectedIndexes.length === 0}
                aria-disabled={selectedIndexes.length === 0}
                className={`quiz-runner__submit-button${selectedIndexes.length > 0 ? ' quiz-runner__submit-button--ready' : ''}`}
              >
                {selectedIndexes.length ? '解答する' : '選択してください'}
              </button>
            </div>
          </section>
        </main>

        {noteFeatureAvailable && noteDrawerMounted && setId ? (
          <CategoryNoteDrawer
            ref={noteDrawerRef}
            problemSetId={setId}
            category={currentQuestion.category}
            open={noteOpen}
            onOpenChange={setNoteOpen}
          />
        ) : null}

        {answered ? createPortal(
          <>
          {feedback && feedback !== 'wrong' ? <div key={currentQuestion.id} className={`quiz-feedback quiz-feedback--${feedback}`} aria-hidden="true" /> : null}
          <AnswerPanel
            isCorrect={lastCorrect === true}
            relearned={feedback === 'relearned'}
            answer={answerText}
            explanation={currentQuestion.explanation}
            detailedExplanation={currentDetailedExplanation}
            questionId={currentQuestion.id}
            savedLevelLabel={savedLevelLabel}
            answerSaveState={answerSaveState}
            readOnly={readOnly}
            isAmbiguous={progress?.isAmbiguous ?? false}
            isLast={currentIndex + 1 >= questions.length}
            state={answerSheetState}
            onExpand={() => setAnswerSheetState('expanded')}
            onDefault={() => setAnswerSheetState('default')}
            onHide={() => setAnswerSheetState('hidden')}
            onToggleAmbiguous={handleAmbiguous}
            onSaveDetailedExplanation={(value) => onSaveDetailedExplanation(currentQuestion.id, value)}
            onRetryAnswerSave={answerRetryRef.current ? handleRetryAnswerSave : undefined}
            onNext={handleNext}
          />
          </>,
          document.body,
        ) : null}
      </div>
    </Layout>
  );
}

function QuizHeader({ title, current, total, onBack }: { title: string; current?: number; total?: number; onBack: () => void }) {
  return (
    <header className="quiz-runner__header flex shrink-0 items-center px-4">
      <BackButton onClick={onBack} />
      <h1 className="quiz-runner__title min-w-0 flex-1 truncate px-3 text-center">{title}</h1>
      <div className="quiz-runner__counter flex h-9 min-w-[72px] shrink-0 items-center justify-center px-2">
        {current && total ? `${current}/${total}` : ''}
      </div>
    </header>
  );
}

function ProgressBand({ label, percent }: { label: string; percent: number }) {
  return (
    <section className="quiz-runner__progress-band flex h-9 shrink-0 items-center gap-3 py-1 pl-4 pr-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="quiz-runner__progress-label shrink-0 truncate text-xs font-bold">{label}</span>
          <div className="quiz-runner__progress-track h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
            <div className="quiz-runner__progress-value h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function QuizChoiceButton({
  text,
  label,
  multiple,
  choiceCount,
  longChoice,
  veryLongChoice,
  disabled,
  isSelected,
  isCorrectChoice,
  answered,
  onClick,
}: {
  text: string;
  label: string;
  multiple: boolean;
  choiceCount: number;
  longChoice: boolean;
  veryLongChoice: boolean;
  disabled: boolean;
  isSelected: boolean;
  isCorrectChoice: boolean;
  answered: boolean;
  onClick: () => void;
}) {
  let stateClass = '';
  const densityClass = choiceCount >= 5 ? ' quiz-choice--compact' : '';
  const textSizeClass = veryLongChoice
    ? ' quiz-choice--very-long'
    : longChoice
      ? ' quiz-choice--long'
      : '';

  if (!answered && isSelected) {
    stateClass = ' quiz-choice--selected';
  } else if (answered && isCorrectChoice) {
    stateClass = ' quiz-choice--correct';
  } else if (answered && isSelected && !isCorrectChoice) {
    stateClass = ' quiz-choice--wrong';
  } else if (answered) {
    stateClass = ' quiz-choice--muted';
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={!answered ? isSelected : undefined}
      className={`quiz-choice${densityClass}${textSizeClass}${stateClass}`}
    >
      <span className={`quiz-choice__label${multiple ? ' quiz-choice__label--multiple' : ''}`} aria-hidden="true">
        {answered && isCorrectChoice ? '✓' : answered && isSelected ? '×' : isSelected ? '●' : ''}
      </span>
      <span className="sr-only">選択肢 {label}{answered && isCorrectChoice ? ' 正解' : answered && isSelected ? ' 不正解' : ''}</span>
      <span className="quiz-choice__text">{text}</span>
    </button>
  );
}

const MULTIPLE_INSTRUCTION_PHRASES = [
  '\u6b63\u3057\u3044\u3082\u306e\u3092\u3059\u3079\u3066\u9078\u3079',
  '\u6b63\u3057\u3044\u3082\u306e\u3092\u5168\u3066\u9078\u3079',
  '\u3059\u3079\u3066\u9078\u3079',
  '\u5168\u3066\u9078\u3079',
  '\u3059\u3079\u3066\u9078\u3073\u306a\u3055\u3044',
  '\u5168\u3066\u9078\u3073\u306a\u3055\u3044',
  '\u8a72\u5f53\u3059\u308b\u3082\u306e\u3092\u3059\u3079\u3066\u9078\u3079',
  '\u3042\u3066\u306f\u307e\u308b\u3082\u306e\u3092\u3059\u3079\u3066\u9078\u3079',
];

const NEGATIVE_INSTRUCTION_PHRASES = [
  '\u8aa4\u3063\u305f\u3082\u306e\u3092\u9078\u3079',
  '\u8aa4\u3063\u3066\u3044\u308b\u3082\u306e\u3092\u9078\u3079',
  '\u6b63\u3057\u304f\u306a\u3044\u3082\u306e\u3092\u9078\u3079',
  '\u9069\u5207\u3067\u306a\u3044\u3082\u306e\u3092\u9078\u3079',
  '\u4e0d\u9069\u5207\u306a\u3082\u306e\u3092\u9078\u3079',
  '\u3042\u3066\u306f\u307e\u3089\u306a\u3044\u3082\u306e\u3092\u9078\u3079',
  '\u8a72\u5f53\u3057\u306a\u3044\u3082\u306e\u3092\u9078\u3079',
  '\u8aa4\u308a\u306f\u3069\u308c\u304b',
  '\u6b63\u3057\u304f\u306a\u3044\u306e\u306f\u3069\u308c\u304b',
  '\u9069\u5207\u3067\u306a\u3044\u306e\u306f\u3069\u308c\u304b',
];

function getQuestionInstructionInfo(question: Question | undefined) {
  const text = question?.question ?? '';
  const multiplePhrases = MULTIPLE_INSTRUCTION_PHRASES.filter((phrase) => text.includes(phrase));
  const negativePhrases = NEGATIVE_INSTRUCTION_PHRASES.filter((phrase) => text.includes(phrase));
  const hasMultipleAnswers = Array.isArray(question?.answerIndexes) && question.answerIndexes.length > 1;

  return {
    hasMultiple: hasMultipleAnswers || multiplePhrases.length > 0,
    hasNegative: negativePhrases.length > 0,
    highlightPhrases: Array.from(new Set([...multiplePhrases, ...negativePhrases])),
  };
}

function HighlightedQuestionText({ text, phrases }: { text: string; phrases: string[] }) {
  if (phrases.length === 0) return <>{text}</>;
  return (
    <>
      {splitTextByPhrases(text, phrases).map((part, index) => (
        part.highlight ? <span key={`${part.text}_${index}`} className="question-instruction-highlight">{part.text}</span> : part.text
      ))}
    </>
  );
}

function splitTextByPhrases(text: string, phrases: string[]) {
  const sortedPhrases = [...phrases].sort((a, b) => b.length - a.length);
  const parts: { text: string; highlight: boolean }[] = [];
  let buffer = '';
  let index = 0;

  while (index < text.length) {
    const phrase = sortedPhrases.find((item) => text.startsWith(item, index));
    if (phrase) {
      if (buffer) {
        parts.push({ text: buffer, highlight: false });
        buffer = '';
      }
      parts.push({ text: phrase, highlight: true });
      index += phrase.length;
      continue;
    }
    buffer += text[index];
    index += 1;
  }

  if (buffer) parts.push({ text: buffer, highlight: false });
  return parts;
}

function AnswerPanel({
  questionId,
  isCorrect,
  relearned,
  answer,
  explanation,
  detailedExplanation,
  savedLevelLabel,
  answerSaveState,
  readOnly,
  isAmbiguous,
  isLast,
  state,
  onExpand,
  onDefault,
  onHide,
  onToggleAmbiguous,
  onSaveDetailedExplanation,
  onRetryAnswerSave,
  onNext,
}: {
  questionId: string;
  isCorrect: boolean;
  relearned: boolean;
  answer: string;
  explanation: string;
  detailedExplanation: string;
  savedLevelLabel: string;
  answerSaveState: 'idle' | 'saving' | 'saved' | 'error';
  readOnly: boolean;
  isAmbiguous: boolean;
  isLast: boolean;
  state: AnswerSheetState;
  onExpand: () => void;
  onDefault: () => void;
  onHide: () => void;
  onToggleAmbiguous: () => Promise<boolean>;
  onSaveDetailedExplanation: (value: string) => Promise<void>;
  onRetryAnswerSave?: () => void;
  onNext: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [panelPage, setPanelPage] = useState<'answer' | 'detail'>('answer');
  const [detailText, setDetailText] = useState(detailedExplanation);
  const [savedDetailText, setSavedDetailText] = useState(detailedExplanation);
  const [isEditingDetail, setIsEditingDetail] = useState(false);
  const [detailMessage, setDetailMessage] = useState('');
  const [detailMessageTone, setDetailMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [isSavingDetail, setIsSavingDetail] = useState(false);
  const [isSavingAmbiguous, setIsSavingAmbiguous] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  const detailOpenRef = useRef<HTMLButtonElement | null>(null);
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const detailEditRef = useRef<HTMLButtonElement | null>(null);
  const detailInputRef = useRef<HTMLTextAreaElement | null>(null);
  const detailPageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef(0);
  const dragFrameRef = useRef<number | null>(null);
  const dragStartYRef = useRef(0);
  const dragStartTimeRef = useRef(0);
  const lastPointerYRef = useRef(0);
  const lastPointerTimeRef = useRef(0);
  const velocityYRef = useRef(0);
  const startHeightRef = useRef(320);
  const detailRailRef = useRef<HTMLDivElement | null>(null);
  const detailSwipeStartRef = useRef<{ x: number; y: number; id: number; width: number; axis: 'x' | 'y' | null } | null>(null);
  const suppressSwipeClickRef = useRef(false);
  const wasDragGestureRef = useRef(false);
  const activeQuestionIdRef = useRef(questionId);
  const committedDetailRef = useRef<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => sheetRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [questionId]);

  useEffect(() => {
    if (activeQuestionIdRef.current !== questionId) {
      activeQuestionIdRef.current = questionId;
      setDetailText(detailedExplanation);
      setSavedDetailText(detailedExplanation);
      setIsEditingDetail(false);
      setDetailMessage('');
      setDetailMessageTone('neutral');
      setIsSavingDetail(false);
      committedDetailRef.current = null;
      return;
    }

    if (committedDetailRef.current !== null) {
      if (detailedExplanation === committedDetailRef.current) committedDetailRef.current = null;
      else return;
    }

    if (!isEditingDetail && detailText === savedDetailText && detailedExplanation !== savedDetailText) {
      setDetailText(detailedExplanation);
      setSavedDetailText(detailedExplanation);
      setDetailMessage('');
      setDetailMessageTone('neutral');
    }
  }, [questionId, detailedExplanation, detailText, isEditingDetail, savedDetailText]);

  useEffect(() => {
    setPanelPage('answer');
  }, [questionId]);

  const getBaseSheetHeight = (targetState: AnswerSheetState) => {
    if (targetState === 'hidden') return 64;

    const rootStyle = getComputedStyle(document.documentElement);
    const safeTop = Number.parseFloat(rootStyle.getPropertyValue('--safe-top')) || 0;
    const safeBottom = Number.parseFloat(rootStyle.getPropertyValue('--safe-bottom')) || 0;
    const viewportHeight = Math.max(0, window.innerHeight - safeTop - safeBottom);
    const isMobile = window.matchMedia('(max-width: 899px)').matches;

    if (targetState === 'default') {
      if (!isMobile) return 320;
      if (window.matchMedia('(max-width: 380px) and (max-height: 720px)').matches) return 272;
      return Math.max(240, Math.min(320, viewportHeight - 128));
    }

    const availableHeight = isMobile ? viewportHeight - 104 : viewportHeight - 88;
    return Math.max(320, isMobile ? availableHeight : Math.min(760, availableHeight));
  };

  const clampDragOffset = (deltaY: number) => {
    const startHeight = startHeightRef.current;
    const hiddenHeight = getBaseSheetHeight('hidden');
    const expandedHeight = getBaseSheetHeight('expanded');
    const minDelta = startHeight - expandedHeight;
    const maxDelta = startHeight - hiddenHeight;
    const resistance = 0.22;

    if (deltaY < minDelta) return minDelta + (deltaY - minDelta) * resistance;
    if (deltaY > maxDelta) return maxDelta + (deltaY - maxDelta) * resistance;
    return deltaY;
  };

  const snapByDrag = (dragOffset: number, velocityY: number) => {
    const FAST_SWIPE_VELOCITY = 0.45;
    const MIN_SWIPE_DISTANCE = 18;
    if (dragOffset <= -MIN_SWIPE_DISTANCE && velocityY <= -FAST_SWIPE_VELOCITY) {
      onExpand();
      return;
    }
    if (dragOffset >= MIN_SWIPE_DISTANCE && velocityY >= FAST_SWIPE_VELOCITY) {
      onHide();
      return;
    }

    const draggedHeight = startHeightRef.current - dragOffset;
    const states: AnswerSheetState[] = ['expanded', 'default', 'hidden'];
    let nearestState = states[0];
    let nearestDistance = Math.abs(getBaseSheetHeight(nearestState) - draggedHeight);

    for (const candidate of states.slice(1)) {
      const distance = Math.abs(getBaseSheetHeight(candidate) - draggedHeight);
      if (distance < nearestDistance) {
        nearestState = candidate;
        nearestDistance = distance;
      }
    }

    if (nearestState === 'expanded') onExpand();
    else if (nearestState === 'hidden') onHide();
    else onDefault();
  };

  const resetDrag = (deferHeightReset = false) => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }

    draggingRef.current = false;
    setIsDragging(false);
    dragOffsetRef.current = 0;

    const clearInlineHeight = () => {
      sheetRef.current?.style.removeProperty('height');
    };

    if (deferHeightReset) requestAnimationFrame(clearInlineHeight);
    else clearInlineHeight();
  };

  const cancelDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.type === 'pointerleave' && event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    if (!draggingRef.current) return;
    resetDrag();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && !target.closest('.answer-sheet__drag-area') && target.closest('button, a, input, textarea, select, [role="button"]')) return;

    const now = performance.now();
    wasDragGestureRef.current = false;
    dragStartYRef.current = event.clientY;
    dragStartTimeRef.current = now;
    lastPointerYRef.current = event.clientY;
    lastPointerTimeRef.current = now;
    velocityYRef.current = 0;
    startHeightRef.current = sheetRef.current?.getBoundingClientRect().height ?? getBaseSheetHeight(state);
    draggingRef.current = true;
    setIsDragging(true);
    dragOffsetRef.current = 0;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    if (Math.abs(event.clientY - dragStartYRef.current) > 5) wasDragGestureRef.current = true;

    const now = performance.now();
    const elapsed = now - lastPointerTimeRef.current;
    if (elapsed > 0) velocityYRef.current = (event.clientY - lastPointerYRef.current) / elapsed;
    lastPointerYRef.current = event.clientY;
    lastPointerTimeRef.current = now;
    dragOffsetRef.current = clampDragOffset(event.clientY - dragStartYRef.current);

    if (dragFrameRef.current === null) {
      dragFrameRef.current = requestAnimationFrame(() => {
        dragFrameRef.current = null;
        if (!sheetRef.current || !draggingRef.current) return;
        sheetRef.current.style.height = String(getDraggedSheetHeight()) + 'px';
      });
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;

    const elapsed = performance.now() - dragStartTimeRef.current;
    const totalVelocityY = elapsed > 0 ? (event.clientY - dragStartYRef.current) / elapsed : velocityYRef.current;
    const velocityY = Math.abs(velocityYRef.current) >= 0.45 ? velocityYRef.current : totalVelocityY;
    snapByDrag(dragOffsetRef.current, velocityY);
    resetDrag(true);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const getDraggedSheetHeight = () => {
    const expandedHeight = getBaseSheetHeight('expanded');
    const maxHeight = Math.max(expandedHeight, window.innerHeight - 40);
    return Math.max(48, Math.min(maxHeight, startHeightRef.current - dragOffsetRef.current));
  };

  const dragProps = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: cancelDrag,
    onPointerLeave: cancelDrag,
  };

  const openDetailPage = () => {
    if (state !== 'expanded') onExpand();
    setPanelPage('detail');
    requestAnimationFrame(() => detailBackRef.current?.focus());
  };

  const handleDetailPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressSwipeClickRef.current = false;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea:not(.answer-sheet__detail-input), select, [contenteditable="true"], pre, table')) return;
    detailSwipeStartRef.current = { x: event.clientX, y: event.clientY, id: event.pointerId, width: detailRailRef.current?.clientWidth || 1, axis: null };
  };

  const settleDetailSwipe = () => {
    const rail = detailRailRef.current;
    if (!rail) return;
    rail.style.removeProperty('transition');
    requestAnimationFrame(() => rail.style.removeProperty('transform'));
  };

  const handleDetailPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = detailSwipeStartRef.current;
    if (!start || start.id !== event.pointerId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (!start.axis) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8) return;
      start.axis = Math.abs(deltaX) > Math.abs(deltaY) * 1.15 ? 'x' : 'y';
      if (start.axis === 'x') {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString().trim()) {
          start.axis = 'y';
          return;
        }
        if (draggingRef.current) resetDrag();
        event.currentTarget.setPointerCapture(event.pointerId);
        suppressSwipeClickRef.current = true;
      }
    }
    if (start.axis !== 'x') return;
    event.preventDefault();
    event.stopPropagation();
    const rail = detailRailRef.current;
    if (rail) {
      const position = (panelPage === 'detail' ? -start.width : 0) + deltaX;
      rail.style.transition = 'none';
      rail.style.transform = `translateX(${Math.max(-start.width, Math.min(0, position))}px)`;
    }
  };

  const handleDetailPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = detailSwipeStartRef.current;
    if (!start || start.id !== event.pointerId) return;
    detailSwipeStartRef.current = null;
    if (start.axis !== 'x') return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const deltaX = event.clientX - start.x;
    if (Math.abs(deltaX) >= Math.max(44, start.width * 0.2)) {
      if (panelPage === 'answer' && deltaX < 0) openDetailPage();
      if (panelPage === 'detail' && deltaX > 0) handleLeaveDetailPage();
    }
    settleDetailSwipe();
  };

  const handleClipboardRead = async () => {
    try {
      const value = await readClipboardText();
      if (!value.trim()) {
        setDetailMessage('\u30af\u30ea\u30c3\u30d7\u30dc\u30fc\u30c9\u304c\u7a7a\u3067\u3059\u3002\u5165\u529b\u4e2d\u306e\u5185\u5bb9\u306f\u305d\u306e\u307e\u307e\u3067\u3059');
        setDetailMessageTone('error');
        return;
      }
      if (
        detailText.trim()
        && value !== detailText
        && !window.confirm('\u5165\u529b\u4e2d\u306e\u8a73\u7d30\u89e3\u8aac\u3092\u30af\u30ea\u30c3\u30d7\u30dc\u30fc\u30c9\u306e\u5185\u5bb9\u3067\u7f6e\u304d\u63db\u3048\u307e\u3059\u304b\uff1f')
      ) {
        setDetailMessage('\u30af\u30ea\u30c3\u30d7\u30dc\u30fc\u30c9\u304b\u3089\u306e\u7f6e\u304d\u63db\u3048\u3092\u30ad\u30e3\u30f3\u30bb\u30eb\u3057\u307e\u3057\u305f');
        setDetailMessageTone('neutral');
        return;
      }
      setDetailText(value);
      setDetailMessage('\u30af\u30ea\u30c3\u30d7\u30dc\u30fc\u30c9\u304b\u3089\u8aad\u307f\u8fbc\u307f\u307e\u3057\u305f');
      setDetailMessageTone('success');
    } catch {
      setDetailMessage('\u30af\u30ea\u30c3\u30d7\u30dc\u30fc\u30c9\u3092\u8aad\u307f\u8fbc\u3081\u307e\u305b\u3093\u3067\u3057\u305f');
      setDetailMessageTone('error');
    }
  };

  const handleSaveDetail = async () => {
    if (isSavingDetail || detailText === savedDetailText) return;
    const nextValue = detailText.trim() ? detailText : '';
    setIsSavingDetail(true);
    setDetailMessage(nextValue ? '\u8a73\u7d30\u89e3\u8aac\u3092\u4fdd\u5b58\u4e2d\u3067\u3059\u2026' : '\u8a73\u7d30\u89e3\u8aac\u3092\u524a\u9664\u4e2d\u3067\u3059\u2026');
    setDetailMessageTone('neutral');
    try {
      await onSaveDetailedExplanation(nextValue);
      committedDetailRef.current = nextValue;
      setDetailText(nextValue);
      setSavedDetailText(nextValue);
      setIsEditingDetail(false);
      setDetailMessage(nextValue ? '\u8a73\u7d30\u89e3\u8aac\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f' : '\u8a73\u7d30\u89e3\u8aac\u3092\u524a\u9664\u3057\u307e\u3057\u305f');
      setDetailMessageTone('success');
      if (detailPageRef.current) detailPageRef.current.scrollTop = 0;
      requestAnimationFrame(() => {
        if (nextValue) detailEditRef.current?.focus();
        else detailBackRef.current?.focus();
      });
    } catch {
      setDetailMessage('\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u901a\u4fe1\u3084\u7a7a\u304d\u5bb9\u91cf\u3092\u78ba\u8a8d\u3057\u3066\u3001\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044');
      setDetailMessageTone('error');
    } finally {
      setIsSavingDetail(false);
    }
  };

  const handleToggleAmbiguous = async () => {
    if (isSavingAmbiguous) return;
    setIsSavingAmbiguous(true);
    try {
      await onToggleAmbiguous();
    } finally {
      setIsSavingAmbiguous(false);
    }
  };

  const handleCancelDetailEdit = () => {
    if (isSavingDetail) return;
    setDetailText(savedDetailText);
    setIsEditingDetail(false);
    setDetailMessage('');
    setDetailMessageTone('neutral');
    requestAnimationFrame(() => {
      if (savedDetailText.trim()) detailEditRef.current?.focus();
      else detailInputRef.current?.focus();
    });
  };

  const hasUnsavedDetail = detailText !== savedDetailText;

  useEffect(() => {
    if (!hasUnsavedDetail) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedDetail]);

  const confirmDiscardDetail = () => (
    !hasUnsavedDetail
    || window.confirm('\u8a73\u7d30\u89e3\u8aac\u306e\u5909\u66f4\u304c\u4fdd\u5b58\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002\u5909\u66f4\u3092\u7834\u68c4\u3057\u3066\u79fb\u52d5\u3057\u307e\u3059\u304b\uff1f')
  );

  const handleLeaveDetailPage = () => {
    if (isSavingDetail || !confirmDiscardDetail()) return;
    if (hasUnsavedDetail) handleCancelDetailEdit();
    setPanelPage('answer');
    requestAnimationFrame(() => detailOpenRef.current?.focus());
  };

  const handleNextWithDraftCheck = () => {
    if (answerSaveState !== 'saved' || isSavingDetail || !confirmDiscardDetail()) return;
    onNext();
  };

  const handleDragHandleClick = () => {
    if (wasDragGestureRef.current) {
      wasDragGestureRef.current = false;
      return;
    }
    if (state === 'expanded') onDefault();
    else onExpand();
  };

  const detailSwipeProps = {
    onPointerDownCapture: handleDetailPointerDown,
    onPointerMoveCapture: handleDetailPointerMove,
    onPointerUpCapture: handleDetailPointerUp,
    onPointerCancelCapture: () => { detailSwipeStartRef.current = null; settleDetailSwipe(); },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (suppressSwipeClickRef.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        suppressSwipeClickRef.current = false;
      }
    },
  };

  const hasSavedDetail = savedDetailText.trim().length > 0;
  const detailEditingDisabled = readOnly || answerSaveState !== 'saved';
  const canSaveDetail = !detailEditingDisabled && hasUnsavedDetail && (detailText.trim().length > 0 || hasSavedDetail) && !isSavingDetail;

  const answerPage = (
    <div
      className="answer-sheet__content-page"
      aria-hidden={panelPage !== 'answer'}
      inert={panelPage !== 'answer'}
    >
      <div className="answer-sheet__answer-box">
        <p className="answer-sheet__label">{'\u6b63\u89e3'}</p>
        <p className="answer-sheet__answer-text">{answer}</p>
      </div>
      <div className="answer-sheet__explanation-block">
        <p className="answer-sheet__label">{'\u89e3\u8aac'}</p>
        <ExplanationContent text={explanation} className="answer-sheet__explanation-text" />
        {(
          <button
            ref={detailOpenRef}
            type="button"
            className={'answer-sheet__detail-open' + (hasUnsavedDetail ? ' answer-sheet__detail-open--unsaved' : '')}
            onClick={openDetailPage}
          >
            詳細解答 <span aria-hidden="true">›</span>
          </button>
        )}
      </div>
    </div>
  );

  const detailPage = (
    <div
      ref={detailPageRef}
      className="answer-sheet__content-page answer-sheet__detail-page"
      aria-hidden={panelPage !== 'detail'}
      inert={panelPage !== 'detail'}
    >
      <div className="answer-sheet__detail-heading">
        <button ref={detailBackRef} type="button" className="answer-sheet__detail-back" onClick={handleLeaveDetailPage} disabled={isSavingDetail}>
          {'\u2039'} {'\u89e3\u7b54\u306b\u623b\u308b'}
        </button>
        <h2>詳細解答</h2>
        {hasSavedDetail && !isEditingDetail && !detailEditingDisabled ? (
          <button
            type="button"
            className="answer-sheet__detail-edit"
            ref={detailEditRef}
             onClick={() => {
               setIsEditingDetail(true);
               setDetailMessage('');
               setDetailMessageTone('neutral');
               if (detailPageRef.current) detailPageRef.current.scrollTop = 0;
               requestAnimationFrame(() => detailInputRef.current?.focus());
            }}
          >
            {'\u7de8\u96c6'}
          </button>
        ) : <span className="answer-sheet__detail-heading-spacer" aria-hidden="true" />}
      </div>
      {detailMessage ? (
        <p
          className={'answer-sheet__detail-message answer-sheet__detail-message--' + detailMessageTone}
          role={detailMessageTone === 'error' ? 'alert' : 'status'}
          aria-live={detailMessageTone === 'error' ? 'assertive' : 'polite'}
        >
          {detailMessage}
        </p>
      ) : null}
      {(hasSavedDetail && !isEditingDetail) || detailEditingDisabled ? (
        <div className="answer-sheet__detail-reading">
          {hasSavedDetail
            ? <ExplanationContent text={savedDetailText} className="answer-sheet__explanation-text" />
            : <p className="answer-sheet__detail-empty">{'詳細解説は登録されていません'}</p>}
        </div>
      ) : (
        <div className="answer-sheet__detail-editor" aria-busy={isSavingDetail} data-no-page-swipe>
          {(
            <button type="button" className="answer-sheet__clipboard-button" onClick={() => void handleClipboardRead()} disabled={isSavingDetail}>
              クリップボードから貼り付け
            </button>
          )}
           <textarea
            ref={detailInputRef}
            className="answer-sheet__detail-input"
            value={detailText}
            onChange={(event) => {
              setDetailText(event.target.value);
              setDetailMessage('');
              setDetailMessageTone('neutral');
            }}
            aria-label={'\u8a73\u7d30\u89e3\u8aac'}
             disabled={isSavingDetail}
           />
          <button
            type="button"
            className={'answer-sheet__detail-save' + (!detailText.trim() && hasSavedDetail ? ' answer-sheet__detail-save--delete' : '')}
            onClick={() => void handleSaveDetail()}
            disabled={!canSaveDetail}
          >
            {isSavingDetail
              ? '\u4fdd\u5b58\u4e2d\u2026'
              : (!detailText.trim() && hasSavedDetail ? '\u8a73\u7d30\u89e3\u8aac\u3092\u524a\u9664' : '\u8a73\u7d30\u89e3\u8aac\u3092\u4fdd\u5b58')}
          </button>
          {(hasSavedDetail || hasUnsavedDetail) ? (
            <button type="button" className="answer-sheet__detail-cancel" onClick={handleCancelDetailEdit} disabled={isSavingDetail}>
              {hasSavedDetail ? '\u5909\u66f4\u3092\u53d6\u308a\u6d88\u3059' : '\u5165\u529b\u3092\u30af\u30ea\u30a2'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  if (state === 'hidden') {
    return (
      <section ref={sheetRef} tabIndex={-1} aria-label={'\u56de\u7b54\u7d50\u679c'} className={'answer-sheet answer-sheet--hidden ' + (isDragging ? 'answer-sheet--dragging' : '')} {...dragProps}>
        <p className="sr-only" role="status" aria-live="polite">{isCorrect ? '\u6b63\u89e3\u3067\u3059' : '\u4e0d\u6b63\u89e3\u3067\u3059'}{`\u3002\u6b63\u89e3\u306f${answer}\u3067\u3059`}</p>
        <div className="answer-sheet__hidden-handle" />
        <div className="answer-sheet__hidden-bar">
          {relearned ? <span className="answer-sheet__relearned">覚え直した</span> : null}
          <span className={'answer-sheet__hidden-result ' + (isCorrect ? 'answer-sheet__hidden-result--correct' : 'answer-sheet__hidden-result--wrong')}>{isCorrect ? '\u6b63\u89e3' : '\u4e0d\u6b63\u89e3'}</span>
          <button type="button" className="answer-sheet__hidden-open" onClick={onDefault}>{'\u89e3\u7b54\u3092\u898b\u308b'}</button>
          <button type="button" className="answer-sheet__hidden-next" onClick={handleNextWithDraftCheck} disabled={answerSaveState !== 'saved' || isSavingDetail}>{isLast ? '\u7d50\u679c\u3078' : '\u6b21\u3078'}</button>
        </div>
      </section>
    );
  }

  return (
    <section ref={sheetRef} tabIndex={-1} aria-label={'\u56de\u7b54\u7d50\u679c'} className={'answer-sheet answer-sheet--' + state + ' ' + (isDragging ? 'answer-sheet--dragging' : '')} {...detailSwipeProps}>
      <p className="sr-only" role="status" aria-live="polite">{isCorrect ? '\u6b63\u89e3\u3067\u3059' : '\u4e0d\u6b63\u89e3\u3067\u3059'}{`\u3002\u6b63\u89e3\u306f${answer}\u3067\u3059`}</p>
      <div className="answer-sheet__drag-capture" aria-hidden="true" {...dragProps} />
      <button
        type="button"
        className="answer-sheet__drag-area"
        aria-label={state === 'expanded' ? '\u89e3\u7b54\u30d1\u30cd\u30eb\u3092\u6a19\u6e96\u30b5\u30a4\u30ba\u306b\u3059\u308b' : '\u89e3\u7b54\u30d1\u30cd\u30eb\u3092\u5e83\u3052\u308b'}
        aria-expanded={state === 'expanded'}
        onClick={handleDragHandleClick}
        {...dragProps}
      >
        <div className="answer-sheet__drag-handle" />
      </button>
      <div className="answer-sheet__fixed" {...dragProps}>
        <div>
          {relearned ? <span className="answer-sheet__relearned">覚え直した</span> : null}
          <div className={'answer-sheet__result ' + (isCorrect ? 'answer-sheet__result--correct' : 'answer-sheet__result--wrong')}>{isCorrect ? '\u6b63\u89e3' : '\u4e0d\u6b63\u89e3'}</div>
          {savedLevelLabel ? <p className="answer-sheet__saved">{savedLevelLabel}</p> : null}
        </div>
          <button type="button" onClick={onHide} className="answer-sheet__hide-button" disabled={answerSaveState !== 'saved' || isSavingDetail || isSavingAmbiguous}>{'\u3057\u307e\u3046'}</button>
      </div>
      <div className="answer-sheet__scroll answer-sheet__scroll--pages">
          <div ref={detailRailRef} className={'answer-sheet__content-rail ' + (panelPage === 'detail' ? 'answer-sheet__content-rail--detail' : '')}>
            {answerPage}
            {detailPage}
          </div>
      </div>
      {answerSaveState === 'error' && onRetryAnswerSave ? (
        <button type="button" className="answer-sheet__retry-save" onClick={onRetryAnswerSave}>回答の保存を再試行</button>
      ) : null}
      <div className={'answer-sheet__actions' + (readOnly ? ' answer-sheet__actions--single' : '')}>
        {!readOnly ? (
          <button type="button" onClick={() => void handleToggleAmbiguous()} disabled={answerSaveState !== 'saved' || isSavingDetail || isSavingAmbiguous} className={'answer-sheet__action answer-sheet__action--secondary' + (isAmbiguous ? ' answer-sheet__action--ambiguous' : '')}>
            {isSavingAmbiguous ? '\u4fdd\u5b58\u4e2d\u2026' : (isAmbiguous ? '\u66d6\u6627\u3092\u89e3\u9664' : '\u66d6\u6627\u3068\u3057\u3066\u767b\u9332')}
          </button>
        ) : null}
        <button type="button" onClick={handleNextWithDraftCheck} disabled={answerSaveState !== 'saved' || isSavingDetail || isSavingAmbiguous} className="answer-sheet__action answer-sheet__action--primary">{isLast ? '\u7d50\u679c\u3078' : '\u6b21\u3078'}</button>
      </div>
    </section>
  );
}

function ExplanationContent({ text, className }: { text: string; className: string }) {
  return (
    <div className={className + ' answer-sheet__markdown'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={sanitizeMarkdownUrl}
        components={{
          table: ({ children }) => (
            <div
              className="answer-sheet__markdown-table-wrap"
              data-no-page-swipe
              role="region"
              aria-label={'\u6a2a\u306b\u30b9\u30af\u30ed\u30fc\u30eb\u3067\u304d\u308b\u8868'}
              tabIndex={0}
            >
              <table className="answer-sheet__markdown-table">{children}</table>
            </div>
          ),
          a: ({ href, children }) => href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" data-no-page-swipe>{children}</a>
          ) : <span>{children}</span>,
          input: ({ node: _node, ...props }) => <input {...props} disabled data-no-page-swipe />,
          img: ({ src, alt }) => src
            ? <img src={src} alt={alt ?? ''} loading="lazy" data-no-page-swipe />
            : <span>{alt ?? ''}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function sanitizeMarkdownUrl(url: string) {
  const value = url.trim();
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith('#')) return value;
  return '';
}
