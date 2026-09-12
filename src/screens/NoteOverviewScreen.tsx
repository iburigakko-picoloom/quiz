import type { AppData } from '../types';
import { useEffect, useState } from 'react';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { StudyIcon } from '../components/UiIcons';
import { buildProblemCategories, normalizeProblemCategory } from './ProblemSetDetailScreen';
import { getQuestionsBySet } from '../utils/quiz';
import { usePhoneLayout } from '../utils/usePhoneLayout';
import { detailBody, NOTES_EVENT, readWeaknessNotes, type WeaknessNote } from '../utils/weaknessNotes';
import { normalizeExplanationMarkdown } from '../utils/explanationMarkdown';
import { ExplanationReader } from '../components/WeaknessDetail';
import './NoteOverviewScreen.css';

export function NoteOverviewScreen({ data, setId, onBack, onOpen, onOpenDetail }: {
  data: AppData; setId: string; onBack: () => void; onOpen: (category: string) => void; onOpenDetail: (questionId: string) => void;
}) {
  const phone = usePhoneLayout();
  const [notes, setNotes] = useState<WeaknessNote[]>([]);
  const [notesError, setNotesError] = useState(false);
  useEffect(() => {
    const load = () => { try { setNotes(readWeaknessNotes()); setNotesError(false); } catch { setNotesError(true); } };
    load();
    window.addEventListener(NOTES_EVENT, load); window.addEventListener('storage', load);
    return () => { window.removeEventListener(NOTES_EVENT, load); window.removeEventListener('storage', load); };
  }, []);
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
        {notesError ? <p role="alert">メモを読み込めませんでした。解説は下に表示しています。</p> : null}
        <div className="note-explanation-list">
          {detailedQuestions.map(question => {
            const memos = notes.filter(note => note.questionId === question.id && note.body.trim());
            const number = questions.findIndex(item => item.id === question.id) + 1;
            return <article key={question.id} className="note-explanation-item" aria-label={`Q${number}のメモと解説`}>
              <header className="note-explanation-item__header">
                <span>Q{number}</span>
                <button type="button" onClick={() => onOpenDetail(question.id)}>編集・追加</button>
              </header>
              <h3>{question.question}</h3>
              {memos.length ? <section className="note-explanation-item__memos" aria-label="メモ">
                <h4>メモ</h4>
                {memos.map(memo => <p key={memo.id}>{memo.body}</p>)}
              </section> : null}
              <section className="note-explanation-item__answer" aria-label="詳細解説">
                <h4>解説</h4>
                <ExplanationReader text={detailBody(question)}/>
              </section>
            </article>;
          })}
        </div>
        {!detailedQuestions.length ? <p>詳細解説はまだありません</p> : null}
      </> : categories.map((category) => <button key={category} className="library-row" onClick={() => onOpen(category)}>
        <span className="library-icon"><StudyIcon size={18} /></span>
        <span className="library-row__body"><strong>{category}</strong></span><span aria-hidden="true">›</span>
      </button>)}
    </> : <p>問題セットが見つかりません</p>}
  </main></Layout>;
}
