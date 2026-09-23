import { useMemo, useState } from 'react';
import type { AppData, Question } from '../types';
import { BackButton } from '../components/BackButton';
import { ActionMenu } from '../components/ActionMenu';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import {
  getQuestionsBySet,
  getReviewQuestions,
  indexProgress,
  matchesReviewLevel,
  shuffleArray,
  type ReviewLevelFilter,
} from '../utils/quiz';
import { ALL_CATEGORIES, buildProblemCategories, filterQuestionsByCategory } from '../utils/questionSelection';
import { useLocalDay } from '../hooks/useLocalDay';
import './ProblemSetDetailScreen.css';

type CategoryFilter = 'all' | string;

const REVIEW_FILTERS: { value: ReviewLevelFilter; label: string }[] = [
  { value: 'all', label: '\u5168Level' },
  { value: 'level0', label: 'Level 0' },
  { value: 'level1', label: 'Level 1' },
  { value: 'level2', label: 'Level 2' },
  { value: 'level3', label: 'Level 3' },
  { value: 'ambiguous', label: '\u66d6\u6627' },
];

interface ProblemSetDetailScreenProps {
  data: AppData;
  setId: string;
  onBack: () => void;
  onEdit: () => void;
  onCopy?: () => void;
  onOpenProblemList: () => void;
  onOpenNoteList: () => void;
  onOpenMaterials?: () => void;
  onShare: () => void;
  onToggleStudyCompleted: (setId: string) => Promise<boolean>;
  onStartSession: (params: {
    questions: Question[];
    mode: 'quiz' | 'review';
    initialIndex?: number;
    title: string;
    subtitle?: string;
    setId: string;
  }) => void;
}

export function ProblemSetDetailScreen({
  data,
  setId,
  onBack,
  onEdit,
  onCopy,
  onOpenProblemList,
  onOpenNoteList,
  onOpenMaterials,
  onShare,
  onToggleStudyCompleted,
  onStartSession,
}: ProblemSetDetailScreenProps) {
  const problemSet = data.problemSets.find((set) => set.id === setId);
  const day = useLocalDay();
  const questions = useMemo(() => getQuestionsBySet(data, setId), [data, setId]);
  const progressById = useMemo(() => indexProgress(data.progress), [data.progress]);
  const allReviewQuestions = useMemo(() => getReviewQuestions(data, questions), [data, questions, day]);
  const [startCategory, setStartCategory] = useState<CategoryFilter>('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewLevelFilter>('all');
  const [completionBusy, setCompletionBusy] = useState(false);
  const [completionError, setCompletionError] = useState('');

  const categories = useMemo(() => buildProblemCategories(questions), [questions]);
  const startQuestions = useMemo(() => filterQuestionsByCategory(questions, startCategory), [questions, startCategory]);
  const filteredStartQuestions = useMemo(
    () => startQuestions.filter((question) => matchesReviewLevel(progressById.get(question.id), reviewFilter)),
    [progressById, startQuestions, reviewFilter],
  );
  const selectedReviewQuestions = useMemo(
    () => getReviewQuestions(data, startQuestions, reviewFilter),
    [data, startQuestions, reviewFilter, day],
  );

  const toggleCompletion = async () => {
    if (completionBusy) return;
    setCompletionBusy(true);
    setCompletionError('');
    try {
      if (!await onToggleStudyCompleted(setId)) setCompletionError('学習状態を保存できませんでした');
    } catch {
      setCompletionError('学習状態を保存できませんでした');
    } finally {
      setCompletionBusy(false);
    }
  };

  if (!problemSet) {
    return (
      <Layout>
        <div className="quiz-detail">
          <DetailHeader title="Quiz make" onBack={onBack} />
          <MissingResourceState
            title="問題セットが見つかりません"
            description="この問題セットは削除されたか、リンクが正しくない可能性があります。"
            onAction={onBack}
          />
        </div>
      </Layout>
    );
  }

  const reachedLevelThree = questions.filter((question) => {
    const progress = progressById.get(question.id);
    return progress?.reviewLevel === 3 || progress?.isGraduated;
  }).length;
  const levelThreeRate = questions.length ? Math.round(reachedLevelThree / questions.length * 100) : 0;
  const selectedLabel = getCategoryLabel(startCategory);
  const reviewFilterLabel = getReviewFilterLabel(reviewFilter);

  const start = (order: 'ordered' | 'random' | 'review') => {
    const sessionQuestions = order === 'review' ? selectedReviewQuestions
      : order === 'random' ? shuffleArray(filteredStartQuestions) : filteredStartQuestions;
    if (sessionQuestions.length === 0) return;
    onStartSession({
      questions: sessionQuestions,
      mode: order === 'review' ? 'review' : 'quiz',
      title: problemSet.title,
      subtitle: [selectedLabel, reviewFilterLabel, { ordered: '登録順', random: 'ランダム', review: '復習' }[order]].join(' / '),
      setId,
    });
  };

  return (
    <Layout>
      <div className="quiz-detail">
        <DetailHeader title={problemSet.title} onBack={onBack} onEdit={onEdit} onCopy={onCopy} onShare={onShare} />

        <div className="quiz-detail__content-grid">
          <div className="quiz-detail__main-column">
            <section className="quiz-detail__summary" aria-label="学習状況">
              <div className="quiz-detail__metric">
                <span>{'\u554f\u984c\u6570'}</span>
                <strong>{questions.length}</strong>
              </div>
              <div className="quiz-detail__metric">
                <span>{'\u5fa9\u7fd2'}</span>
                <strong>{allReviewQuestions.length}</strong>
              </div>
              <div className="quiz-detail__metric">
                <span>Level 3到達率</span>
                <strong>{levelThreeRate}%</strong>
              </div>
            </section>
            <div className="quiz-detail__completion-row" aria-label="問題セットの学習状態">
              <span>{problemSet.isStudyCompleted ? '学習済み・復習対象外' : '学習中'}</span>
              <button type="button" onClick={() => void toggleCompletion()} disabled={completionBusy} aria-pressed={problemSet.isStudyCompleted === true}>
                {completionBusy ? '保存中…' : problemSet.isStudyCompleted ? '学習済みを解除' : '学習済みにする'}
              </button>
            </div>
            {completionError ? <p className="quiz-detail__completion-error" role="alert">{completionError}</p> : null}
            <section className="quiz-detail__start-panel" aria-labelledby="quiz-detail-start-title">
              <h2 id="quiz-detail-start-title" className="sr-only">出題条件と学習開始</h2>

              <section className="quiz-detail__filters" aria-labelledby="quiz-detail-filter-title">
                <div className="quiz-detail__filters-heading">
                  <span id="quiz-detail-filter-title">{'\u51fa\u984c\u6761\u4ef6'}</span>
                </div>
                <div className="quiz-detail__filters-body">
                  <div className="quiz-detail__segment-caption">{'\u5206\u985e'}</div>
                  <div className="quiz-detail__segments" aria-label={'\u5206\u985e\u4e00\u89a7'}>
                    {categories.map((item, index) => {
                      const value = index === 0 ? 'all' : item;
                      const active = startCategory === value || (startCategory === 'all' && index === 0);
                      return (
                        <button
                          key={item}
                          type="button"
                          className={`quiz-detail__segment-item${active ? ' quiz-detail__segment-item--active' : ''}`}
                          onClick={() => setStartCategory(value)}
                          aria-pressed={active}
                        >
                          {item}
                        </button>
                      );
                    })}
                  </div>

                  <div className="quiz-detail__segment-caption">Level</div>
                  <div className="quiz-detail__segments" aria-label={'Level\u6761\u4ef6'}>
                    {REVIEW_FILTERS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={`quiz-detail__segment-item${reviewFilter === item.value ? ' quiz-detail__segment-item--active' : ''}`}
                        onClick={() => setReviewFilter(item.value)}
                        aria-pressed={reviewFilter === item.value}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {filteredStartQuestions.length === 0 ? (
                <p className="quiz-detail__empty-condition">{'\u3053\u306e\u6761\u4ef6\u306b\u8a72\u5f53\u3059\u308b\u554f\u984c\u304c\u3042\u308a\u307e\u305b\u3093'}</p>
              ) : null}

              <div className="quiz-detail__start-actions" aria-label="学習方法">
                <button
                  type="button"
                  className="quiz-detail__start-action quiz-detail__start-action--primary"
                  disabled={filteredStartQuestions.length === 0}
                  onClick={() => start('ordered')}
                >
                  <strong>登録順で解く</strong>
                </button>
                <button
                  type="button"
                  className="quiz-detail__start-action"
                  disabled={filteredStartQuestions.length === 0}
                  onClick={() => start('random')}
                >
                  <strong>ランダムで解く</strong>
                </button>
                <button
                  type="button"
                  className="quiz-detail__start-action quiz-detail__start-action--review"
                  disabled={selectedReviewQuestions.length === 0}
                  onClick={() => start('review')}
                  aria-label={`復習する問題を${selectedReviewQuestions.length}問開始`}
                >
                  <strong>復習で解く</strong>
                  <small>{selectedReviewQuestions.length}問</small>
                </button>
              </div>
            </section>



            <section className="quiz-detail__body">
              <div className="quiz-detail__entry-grid">
                {onOpenMaterials ? <button type="button" className="quiz-detail__list-entry" onClick={onOpenMaterials}><strong>資料</strong><b aria-hidden="true">›</b></button> : null}
                <button type="button" className="quiz-detail__list-entry" onClick={onOpenProblemList}>
                  <span>
                    <strong>{'\u554f\u984c\u4e00\u89a7'}</strong>
                  </span>
                  <b aria-hidden="true">{'\u203a'}</b>
                </button>
                {(
                  <button type="button" className="quiz-detail__list-entry quiz-detail__note-list-entry" onClick={onOpenNoteList}>
                    <span>
                      <strong>詳細解説一覧</strong>
                    </span>
                    <b aria-hidden="true">{'\u203a'}</b>
                  </button>
                )}
              </div>
            </section>



          </div>
        </div>
      </div>
    </Layout>
  );
}

function DetailHeader({ title, onBack, onEdit, onShare, onCopy }: { title: string; onBack: () => void; onEdit?: () => void; onShare?: () => void; onCopy?: () => void }) {
  return (
    <header className="quiz-detail__header">
      <div className="quiz-detail__header-slope" />
      <BackButton onClick={onBack} className="quiz-detail__back-button" />
      <h1 className="quiz-detail__title">{title}</h1>
      {onEdit || onShare || onCopy ? <ActionMenu className="library-actions library-header-add">
        <summary aria-label="問題セットの操作">…</summary>
        <div className="library-actions__body">
          {onEdit ? <button type="button" onClick={onEdit}>問題セットを編集</button> : null}
          {onCopy ? <button type="button" onClick={onCopy}>問題セットをコピー</button> : null}
          {onShare ? <button type="button" onClick={onShare}>共有設定</button> : null}
        </div>
      </ActionMenu> : null}
    </header>
  );
}

function getCategoryLabel(category: string) {
  return category === 'all' ? ALL_CATEGORIES : category;
}

function getReviewFilterLabel(filter: ReviewLevelFilter) {
  return REVIEW_FILTERS.find((item) => item.value === filter)?.label ?? '\u5168Level';
}
