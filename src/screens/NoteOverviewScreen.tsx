import type { AppData } from '../types';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { StudyIcon } from '../components/UiIcons';
import { buildProblemCategories, normalizeProblemCategory } from './ProblemSetDetailScreen';
import { getQuestionsBySet } from '../utils/quiz';
import { usePhoneLayout } from '../utils/usePhoneLayout';
import { detailBody } from '../utils/weaknessNotes';
import { normalizeExplanationMarkdown } from '../utils/explanationMarkdown';

export function NoteOverviewScreen({ data, setId, onBack, onOpen, onOpenDetail }: {
  data: AppData; setId: string; onBack: () => void; onOpen: (category: string) => void; onOpenDetail: (questionId: string) => void;
}) {
  const phone = usePhoneLayout();
  const set = data.problemSets.find((item) => item.id === setId);
  const questions = getQuestionsBySet(data, setId);
  const categories = buildProblemCategories(questions).slice(1);
  if (!categories.length) categories.push(normalizeProblemCategory(undefined));
  const detailedQuestions = questions.filter(question => normalizeExplanationMarkdown(detailBody(question)).trim() || question.detailedAnswer?.imageIds.length);
  return <Layout><main className="library-page">
    <header className="library-page__header"><BackButton onClick={onBack} /><h1>{phone ? '詳細解説一覧' : 'ノート一覧'}</h1></header>
    {set ? <>
      <h2 className="note-overview-title">{set.title}</h2>
      {phone ? <>
        {detailedQuestions.map(question => <button type="button" key={question.id} className="library-row" onClick={() => onOpenDetail(question.id)}>
          <span className="library-icon"><StudyIcon size={18}/></span>
          <span className="library-row__body"><strong>{question.question}</strong></span><span aria-hidden="true">›</span>
        </button>)}
        {!detailedQuestions.length ? <p>詳細解説はまだありません</p> : null}
      </> : categories.map((category) => <button key={category} className="library-row" onClick={() => onOpen(category)}>
        <span className="library-icon"><StudyIcon size={18} /></span>
        <span className="library-row__body"><strong>{category}</strong></span><span aria-hidden="true">›</span>
      </button>)}
    </> : <p>問題セットが見つかりません</p>}
  </main></Layout>;
}
