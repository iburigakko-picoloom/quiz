import { useMemo, useRef, useState } from 'react';
import type { AppData, ProblemSortMode, Question, QuestionProgress } from '../types';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import {
  buildAppDataView,
  sortQuestionOverviews,
  type QuestionOverview,
} from '../utils/appDataView';
import { formatDisplayDate } from '../utils/date';
import { getProgressLevelLabel } from '../utils/quiz';
import {
  buildProblemCategories,
  normalizeProblemCategory,
} from './ProblemSetDetailScreen';
import './ProblemListScreen.css';

const EMPTY_QUESTION_OVERVIEWS: readonly QuestionOverview[] = [];

interface ProblemListScreenProps {
  data: AppData;
  setId: string;
  initialSortMode?: ProblemSortMode;
  onBack: () => void;
  onOpenQuestion: (questionId: string, sortMode: ProblemSortMode) => void;
  onStartFromQuestion: (params: {
    questions: Question[];
    initialIndex: number;
    title: string;
    subtitle: string;
    setId: string;
    sortMode: ProblemSortMode;
  }) => void;
}

export function ProblemListScreen({ data, setId, initialSortMode = 'ordered', onBack, onOpenQuestion, onStartFromQuestion }: ProblemListScreenProps) {
  const contentView = useMemo(() => buildAppDataView(data), [data]);
  const problemSet = contentView.problemSetById.get(setId);
  const questionOverviews = contentView.questionsBySetId.get(setId) ?? EMPTY_QUESTION_OVERVIEWS;
  const allQuestions = useMemo(() => questionOverviews.map((item) => item.question), [questionOverviews]);
  const categories = useMemo(() => buildProblemCategories(allQuestions), [allQuestions]);
  const [sortMode, setSortMode] = useState<ProblemSortMode>(initialSortMode);
  const [activeCategory, setActiveCategory] = useState('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const groupedSections = useMemo(() => {
    const questionsByCategory = new Map<string, QuestionOverview[]>();
    for (const item of questionOverviews) {
      const category = normalizeProblemCategory(item.question.category);
      const existing = questionsByCategory.get(category);
      if (existing) existing.push(item);
      else questionsByCategory.set(category, [item]);
    }

    return categories
      .filter((category) => category !== 'すべて')
      .map((category) => ({
        category,
        questions: sortQuestionOverviews(questionsByCategory.get(category) ?? [], sortMode),
      }))
      .filter((section) => section.questions.length > 0);
  }, [categories, questionOverviews, sortMode]);

  const listQuestionOverviews = useMemo(
    () => groupedSections.flatMap((section) => section.questions),
    [groupedSections],
  );
  const listQuestions = useMemo(
    () => listQuestionOverviews.map((item) => item.question),
    [listQuestionOverviews],
  );
  const listIndexByQuestionId = useMemo(() => {
    const indexes = new Map<string, number>();
    listQuestionOverviews.forEach((item, index) => {
      if (!indexes.has(item.question.id)) indexes.set(item.question.id, index);
    });
    return indexes;
  }, [listQuestionOverviews]);
  const sortLabel = sortMode === 'level' ? 'level順' : '登録順';
  const title = problemSet?.title ?? '問題セット';

  const scrollToCategory = (category: string) => {
    setActiveCategory(category);
    if (category === 'all' || category === 'すべて') {
      listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    sectionRefs.current[category]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const startFrom = (questionId: string) => {
    const initialIndex = listIndexByQuestionId.get(questionId);
    if (initialIndex === undefined) return;
    onStartFromQuestion({
      questions: listQuestions,
      initialIndex,
      title,
      subtitle: `問題一覧 / ${sortLabel}`,
      setId,
      sortMode,
    });
  };

  if (!problemSet) {
    return (
      <Layout>
        <div className="quiz-list">
          <header className="quiz-list__header">
            <div className="quiz-list__header-slope" />
            <BackButton onClick={onBack} className="quiz-list__back-button" />
            <div className="quiz-list__title-wrap"><h1>問題一覧</h1></div>
          </header>
          <MissingResourceState
            title="問題セットが見つかりません"
            description="問題一覧を表示できません。この問題セットは削除されたか、リンクが正しくない可能性があります。"
            onAction={onBack}
          />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="quiz-list">
        <header className="quiz-list__header">
          <div className="quiz-list__header-slope" />
          <BackButton onClick={onBack} className="quiz-list__back-button" />
          <div className="quiz-list__title-wrap">
            <h1>問題一覧</h1>
            <p>{title}</p>
          </div>
        </header>

        <section className="quiz-list__meta">
          <span>{listQuestions.length}問</span>
          <span>分野別に表示</span>
        </section>

        <section className="quiz-list__sort" aria-label="並び替え">
          <button type="button" className={sortMode === 'ordered' ? 'is-active' : ''} onClick={() => setSortMode('ordered')}>
            登録順
          </button>
          <button type="button" className={sortMode === 'level' ? 'is-active' : ''} onClick={() => setSortMode('level')}>
            level順
          </button>
        </section>

        <section className="quiz-list__chips" aria-label="分野へ移動">
          {categories.map((item) => {
            const value = item === 'すべて' ? 'all' : item;
            const active = activeCategory === value || (activeCategory === 'all' && item === 'すべて');
            return (
              <button
                key={item}
                type="button"
                className={`quiz-list__chip${active ? ' quiz-list__chip--active' : ''}`}
                onClick={() => scrollToCategory(value)}
              >
                {item}
              </button>
            );
          })}
        </section>

        <section className="quiz-list__items" ref={listRef}>
          {groupedSections.length === 0 ? (
            <div className="quiz-list__empty">
              <div className="quiz-list__empty-icon" aria-hidden="true">0</div>
              <h2>問題がありません</h2>
              <button type="button" onClick={onBack}>問題セットへ戻る</button>
            </div>
          ) : groupedSections.map((section) => (
            <div
              key={section.category}
              className="quiz-list__section"
              ref={(node) => {
                sectionRefs.current[section.category] = node;
              }}
            >
              <h2 className="quiz-list__section-title">{section.category}</h2>
              {section.questions.map(({ question, number, progress }) => (
                <QuestionListCard
                  key={question.id}
                  index={number}
                  question={question}
                  progress={progress}
                  onClick={() => onOpenQuestion(question.id, sortMode)}
                  onStart={() => startFrom(question.id)}
                />
              ))}
            </div>
          ))}
        </section>
      </div>
    </Layout>
  );
}

function QuestionListCard({
  index,
  question,
  progress,
  onClick,
  onStart,
}: {
  index: number;
  question: Question;
  progress: QuestionProgress;
  onClick: () => void;
  onStart: () => void;
}) {
  const status = progress.answeredCount === 0 ? '未解答' : `${progress.correctCount}/${progress.answeredCount}`;

  return (
    <article className="quiz-list__card">
      <button type="button" className="quiz-list__card-content" onClick={onClick} aria-label={`Q${index}の詳細を開く`}>
      <div className="quiz-list__card-top">
        <span className="quiz-list__number">Q{index}</span>
        <span className="quiz-list__category">{normalizeProblemCategory(question.category)}</span>
        <span className="quiz-list__status">{status}</span>
      </div>
      <p className="quiz-list__text">{question.question}</p>
      <div className="quiz-list__badges">
        <span className="quiz-list__badge">{getProgressLevelLabel(progress)}</span>
        {progress.isAmbiguous ? <span className="quiz-list__badge quiz-list__badge--ambiguous">曖昧</span> : null}
        {progress.isReview && !progress.isGraduated ? <span className="quiz-list__badge quiz-list__badge--review">復習</span> : null}
        {progress.lastAnsweredAt ? <span className="quiz-list__last">最終 {formatDisplayDate(progress.lastAnsweredAt)}</span> : null}
      </div>
      </button>
      <div className="quiz-list__card-actions">
        <button type="button" className="quiz-list__start-here" onClick={onStart} aria-label={`Q${index}から解く`}>ここから解く <span aria-hidden="true">›</span></button>
      </div>
    </article>
  );
}
