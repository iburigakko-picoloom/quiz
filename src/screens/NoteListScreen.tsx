import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import { BackButton } from '../components/BackButton';
import { CategoryNotePanel, type CategoryNotePanelHandle } from '../components/CategoryNoteDrawer';
import { runAfterSuccessfulNoteFlush } from '../components/noteExitGuard';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import { buildProblemCategories, normalizeProblemCategory } from './ProblemSetDetailScreen';
import { getQuestionsBySet } from '../utils/quiz';
import './NoteListScreen.css';

interface NoteListScreenProps {
  data: AppData;
  setId: string;
  onBack: () => void;
  initialCategory?: string;
  onOpenQuestions?: () => void;
  registerExitGuard?: (guard: ((proceed: () => void) => Promise<boolean>) | null) => void;
}

export function NoteListScreen({ data, setId, onBack, initialCategory, onOpenQuestions, registerExitGuard }: NoteListScreenProps) {
  const problemSet = data.problemSets.find((set) => set.id === setId);
  const questions = useMemo(() => getQuestionsBySet(data, setId), [data, setId]);
  const noteCategories = useMemo(() => {
    const categories = buildProblemCategories(questions).filter((category) => category !== 'すべて');
    if (categories.length > 0) return categories;
    return [normalizeProblemCategory(questions[0]?.category)];
  }, [questions]);
  const [selectedCategory, setSelectedCategory] = useState(() => initialCategory ?? noteCategories[0] ?? '未分類');
  const [isTabletLandscape, setIsTabletLandscape] = useState(() => getIsTabletLandscape());
  const [isLeavingNote, setIsLeavingNote] = useState(false);
  const [transitionError, setTransitionError] = useState('');
  const notePanelRef = useRef<CategoryNotePanelHandle>(null);
  const noteTransitionQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingNoteTransitionsRef = useRef(0);
  const mountedRef = useRef(true);
  const tabletLandscapeRef = useRef(isTabletLandscape);
  const desiredTabletLandscapeRef = useRef(isTabletLandscape);

  const requestNoteTransition = useCallback((proceed: () => void): Promise<boolean> => {
    pendingNoteTransitionsRef.current += 1;
    setIsLeavingNote(true);
    setTransitionError('');

    const finishTransition = () => {
      pendingNoteTransitionsRef.current = Math.max(0, pendingNoteTransitionsRef.current - 1);
      if (mountedRef.current && pendingNoteTransitionsRef.current === 0) setIsLeavingNote(false);
    };
    const execute = async () => {
      if (!mountedRef.current) {
        finishTransition();
        return false;
      }
      const completed = await runAfterSuccessfulNoteFlush(
        () => notePanelRef.current?.flush() ?? Promise.resolve(),
        () => {
          finishTransition();
          if (mountedRef.current) setTransitionError('');
          proceed();
        },
      );
      if (!completed) {
        finishTransition();
        if (mountedRef.current) setTransitionError('ノートを保存できませんでした。操作をもう一度お試しください。');
      }
      return completed;
    };
    const queued = noteTransitionQueueRef.current.then(execute, execute);
    noteTransitionQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, []);

  useEffect(() => {
    registerExitGuard?.(requestNoteTransition);
    return () => registerExitGuard?.(null);
  }, [registerExitGuard, requestNoteTransition]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!noteCategories.includes(selectedCategory)) {
      void requestNoteTransition(() => setSelectedCategory(noteCategories[0] ?? '未分類'));
    }
  }, [noteCategories, requestNoteTransition, selectedCategory]);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px) and (orientation: landscape)');
    const update = () => {
      const nextLandscape = query.matches;
      desiredTabletLandscapeRef.current = nextLandscape;
      if (nextLandscape === tabletLandscapeRef.current) return;
      if (nextLandscape) {
        tabletLandscapeRef.current = true;
        setIsTabletLandscape(true);
        return;
      }
      void requestNoteTransition(() => {
        if (desiredTabletLandscapeRef.current) return;
        tabletLandscapeRef.current = false;
        setIsTabletLandscape(false);
      });
    };
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [requestNoteTransition]);

  if (!problemSet) {
    return (
      <Layout>
        <div className="quiz-notes">
          <header className="quiz-notes__header">
            <div className="quiz-notes__header-slope" />
            <BackButton onClick={onBack} className="quiz-notes__back-button" />
            <div className="quiz-notes__title-wrap"><h1>ノート一覧</h1></div>
          </header>
          <MissingResourceState
            title="問題セットが見つかりません"
            description="ノート一覧を表示できません。この問題セットは削除されたか、リンクが正しくない可能性があります。"
            onAction={onBack}
          />
        </div>
      </Layout>
    );
  }

  const title = problemSet.title;

  return (
    <Layout>
      <div className="quiz-notes">
        <header className="quiz-notes__header">
          <div className="quiz-notes__header-slope" />
          <BackButton
            onClick={() => void requestNoteTransition(onBack)}
            className="quiz-notes__back-button"
            disabled={isLeavingNote}
          />
          <div className="quiz-notes__title-wrap">
            <h1>{initialCategory ? selectedCategory : 'ノート一覧'}</h1>
            <p>{title}</p>
          </div>
          {onOpenQuestions ? <button type="button" className="note-detail-questions" disabled={isLeavingNote} onClick={() => void requestNoteTransition(onOpenQuestions)}>問題一覧</button> : null}
        </header>

        {transitionError ? <div className="quiz-notes__transition-error" role="alert">{transitionError}</div> : null}

        <main className={`quiz-notes__body${initialCategory ? ' quiz-notes__body--detail' : ''}`}>
          {isTabletLandscape ? (
            <>
              {!initialCategory ? <aside className="quiz-notes__categories" aria-label="分類別ノート">
                <div className="quiz-notes__section-title">
                  <span>分類</span>
                  <strong>{noteCategories.length}</strong>
                </div>
                <div className="quiz-notes__category-list">
                  {noteCategories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className={`quiz-notes__category${selectedCategory === category ? ' quiz-notes__category--active' : ''}`}
                      disabled={isLeavingNote}
                      onClick={() => {
                        if (selectedCategory !== category) {
                          void requestNoteTransition(() => setSelectedCategory(category));
                        }
                      }}
                    >
                      <span>{category}</span>
                      <b aria-hidden="true">›</b>
                    </button>
                  ))}
                </div>
              </aside> : null}

              <section className="quiz-notes__panel-wrap">
                <CategoryNotePanel
                  key={selectedCategory}
                  ref={notePanelRef}
                  problemSetId={setId}
                  category={selectedCategory}
                  className="quiz-notes__panel"
                  onClose={() => void requestNoteTransition(onBack)}
                />
              </section>
            </>
          ) : (
            <section className="quiz-notes__unsupported">
              <h2>ノート</h2>
              <p>ノート機能はタブレット横画面で表示されます。</p>
            </section>
          )}
        </main>
      </div>
    </Layout>
  );
}

function getIsTabletLandscape() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(min-width: 768px) and (orientation: landscape)').matches;
}
