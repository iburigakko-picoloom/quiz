import { useState } from 'react';
import type { AppData, Question, QuizMode, QuizResult, MaterialReference } from '../types';
import { getQuestionsBySet, shuffleArray } from '../utils/quiz';
import { QuizRunner, type AnswerHandlerResult } from './QuizRunner';

interface QuizScreenProps {
  data: AppData;
  setId: string;
  mode: QuizMode;
  onBack: () => void;
  onAnswer: (question: Question, selectedIndexes: number[], isReviewMode: boolean) => AnswerHandlerResult;
  onToggleAmbiguous: (questionId: string) => Promise<boolean>;
  onSaveDetailedExplanation: (questionId: string, detailedExplanation: string) => Promise<void>;
  onLinkMaterialPage?: (questionId: string, reference: MaterialReference, linked: boolean) => Promise<void>;
  onFinish: (result: QuizResult) => void;
}

export function QuizScreen({ data, setId, mode, onBack, onAnswer, onToggleAmbiguous, onSaveDetailedExplanation, onLinkMaterialPage, onFinish }: QuizScreenProps) {
  const problemSet = data.problemSets.find((set) => set.id === setId);
  const allQuestions = getQuestionsBySet(data, setId);
  const [sessionQuestions] = useState<Question[]>(() => (mode === 'random' ? shuffleArray(allQuestions) : allQuestions));

  return (
    <QuizRunner
      data={data}
      title={problemSet?.title ?? 'クイズ'}
      subtitle={mode === 'random' ? 'ランダム出題' : '登録順出題'}
      questions={sessionQuestions}
      mode="quiz"
      setId={setId}
      emptyState={!problemSet ? {
        title: '問題セットが見つかりません',
        description: 'クイズを開始できません。この問題セットは削除されたか、リンクが正しくない可能性があります。',
        actionLabel: 'ホームへ戻る',
      } : undefined}
      onBack={onBack}
      onAnswer={onAnswer}
      onToggleAmbiguous={onToggleAmbiguous}
      onSaveDetailedExplanation={onSaveDetailedExplanation}
      onLinkMaterialPage={onLinkMaterialPage}
      onFinish={onFinish}
    />
  );
}
