import type { ProblemSet } from '../types';
import { ProblemSetIcon } from './UiIcons';

interface ProblemSetCardProps {
  problemSet: ProblemSet;
  questionCount: number;
  answeredCount: number;
  reviewCount: number;
  correctRate: number;
  editMode: boolean;
  onStartOrdered: () => void;
  onStartRandom: () => void;
  onDelete: () => void;
}

export function ProblemSetCard({
  problemSet,
  questionCount,
  reviewCount,
  correctRate,
  editMode,
  onStartOrdered,
  onDelete,
}: ProblemSetCardProps) {
  return (
    <article className="quiz-folder__set-card">
      <button type="button" className="quiz-folder__set-main" disabled={editMode} onClick={onStartOrdered}>
        <span className="quiz-folder__set-icon" aria-hidden="true">
          <ProblemSetIcon />
        </span>
        <span className="quiz-folder__set-body">
          <span className="quiz-folder__set-name">{problemSet.title}</span>
          <span className="quiz-folder__set-source">{problemSet.source}</span>
          <span className="quiz-folder__set-stats">
            <span>🏷 {questionCount}</span>
            <span>🔖 {reviewCount}</span>
            <span>✅ {correctRate}%</span>
          </span>
        </span>
        {!editMode ? <span className="quiz-folder__set-arrow">›</span> : null}
      </button>

      {editMode ? (
        <button type="button" className="quiz-folder__delete-button" onClick={onDelete}>
          削除
        </button>
      ) : null}
    </article>
  );
}
