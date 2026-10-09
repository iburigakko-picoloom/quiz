import { useState, type ReactNode } from 'react';
import type { CloudProblemSet,CloudQuestion } from '../utils/cloudService';
import { displayGroupDate, GroupEmpty } from './GroupLearningUi';
import { FolderOutlineIcon, GroupIcon, HistoryIcon, ProblemSetIcon } from './UiIcons';

export function SharedSetDetail({ set, location, busy, onCopy, onPractice, onReport, progress }: {
  set: CloudProblemSet; location: string; busy: boolean; progress?: ReactNode;
  onCopy: () => void; onPractice: () => void; onReport: () => void;
}) {
  return <section className="group-set-detail" aria-label="問題セット詳細">
    {location ? <p className="group-breadcrumb"><FolderOutlineIcon size={17} />{location}</p> : null}
    <article className="group-panel group-set-summary"><div className="group-set-summary__top"><span className="group-folder-card__icon"><ProblemSetIcon size={44} /></span><div><h2>{set.title}</h2><div className="group-set-summary__meta"><span><ProblemSetIcon size={16} />{set.questionCount}問</span><span><GroupIcon size={16} />取り込み {set.importCount === undefined ? `${set.addCount}件` : `${set.importCount}人`}</span><span><HistoryIcon size={16} />最終更新 {displayGroupDate(set.updatedAt)}</span></div></div></div>
      {set.description ? <p className="group-muted">{set.description}</p> : null}
      <button type="button" className="group-primary group-import-button" disabled={busy} onClick={onCopy}>取り込む</button>
    </article>
    <SharedQuestionPreview questions={set.questions??[]}/>
    {progress}
    <div className="group-detail-minor-actions"><button type="button" className="group-secondary" disabled={busy} onClick={onPractice}>このまま解く</button><button type="button" className="group-text-link" disabled={busy} onClick={onReport}>誤りを報告</button></div>
  </section>;
}

export function SharedQuestionPreview({questions}:{questions:CloudQuestion[]}){
  const [allQuestions,setAllQuestions]=useState(false),[expanded,setExpanded]=useState<number|null>(null);
  return <article className="group-panel shared-question-preview"><div className="group-panel__heading"><h2>問題プレビュー</h2>{questions.length>3?<button type="button" className="group-text-link" onClick={()=>setAllQuestions(value=>!value)}>{allQuestions?'3問だけ見る':`すべて見る（${questions.length}問）`}</button>:null}</div>
    <div className="group-preview-list">{questions.slice(0,allQuestions?questions.length:3).map((q,i)=><article className="group-preview-card" key={q.logicalId??i}><button type="button" aria-expanded={expanded===i} onClick={()=>setExpanded(expanded===i?null:i)}><span className="group-preview-card__number">Q{i+1}</span><span><strong>{q.question.split('\n')[0].slice(0,40)||`問題 ${i+1}`}</strong>{q.question.includes('\n')?<span className="group-preview-card__text">{q.question.slice(q.question.indexOf('\n')+1)}</span>:null}<span className="group-preview-card__tags">{[q.category,q.difficulty==='advanced'?'発展':q.difficulty==='standard'?'標準':'基礎'].filter(Boolean).map(tag=><span key={tag}>{tag}</span>)}</span></span></button>{expanded===i?<div className="group-preview-card__expanded"><p>{q.question}</p><ol>{q.choices.map((choice,index)=><li key={index}>{choice}</li>)}</ol></div>:null}</article>)}</div>{!questions.length?<GroupEmpty>プレビューできる問題はありません。</GroupEmpty>:null}
  </article>;
}
