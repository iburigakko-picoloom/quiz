import type {PublicationJob} from '../utils/publicationStorage';
import {needsPublicationAttention} from '../utils/publicationQueue';
export function PublicationJobs({jobs,onRetry,compact=false}:{jobs:PublicationJob[];onRetry:(id:string)=>void;compact?:boolean}) {
  const visibleJobs=jobs.filter(needsPublicationAttention);
  if(!visibleJobs.length)return null;
  return <section className={`publication-jobs${compact?' publication-jobs--compact':''}`} aria-label="公開の処理状況" aria-live="polite">{visibleJobs.map(job=><article key={job.id} className={`publication-job publication-job--${job.state}`}>
    <div className="publication-job__heading"><strong>{job.title}</strong><span>{job.state==='completed'?(job.warning||job.error?'反映を確認してください':'反映中'):{queued:'公開待ち',publishing:'公開中',failed:'公開失敗'}[job.state]}</span></div>
    {job.state==='queued'||job.state==='publishing'?<><progress value={job.uploaded} max={job.total} aria-label={`${job.title}の送信済み問題数`}/><small>{job.uploaded.toLocaleString('ja-JP')} / {job.total.toLocaleString('ja-JP')}問{job.phase==='committing'?' · 公開を確定中':''}</small></>:null}
    {job.error?<p>{job.error}</p>:null}{job.warning?<p>{job.warning}</p>:null}
    {job.state==='failed'&&job.retryable||job.warning?<button type="button" onClick={()=>onRetry(job.id)}>{job.warning?'反映を再試行':'このセットを再試行'}</button>:null}
  </article>)}</section>;
}
