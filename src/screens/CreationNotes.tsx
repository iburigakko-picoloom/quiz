import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { readClipboardText, writeClipboardText } from '../utils/nativePlatform';
import { changeWeaknessNotes, detailBody, explanationPrompt, finishExplanationBatch, makeExplanationRequest, NOTES_EVENT, readExplanationBatch, readWeaknessNotes, rememberExplanationRequest, type ExplanationBatch, type WeaknessNote } from '../utils/weaknessNotes';
import { ExplanationReader, WeaknessDetail } from '../components/WeaknessDetail';
import { ChevronRightIcon, ProblemSetIcon } from '../components/UiIcons';


export function CreationNotes({ data, purpose, onApplyBatch, onSaveDetail, onDirtyChange, onBackRef, onCreateQuestions }: {
  purpose: 'questions'|'answer';
  data: AppData; onApplyBatch: (batch: ExplanationBatch)=>Promise<void>; onSaveDetail:(questionId:string,body:string)=>Promise<void>;
  onDirtyChange:(dirty:boolean)=>void;
  onCreateQuestions:(context:string)=>void;
  onBackRef: { current: (()=>boolean) | null };
}) {
  const pendingEdits = useRef(0);
  const [notes,setNotes]=useState<WeaknessNote[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [view,setView]=useState<'list'|'set'|'question'|'prompt'|'import'>('list');
  const [history,setHistory]=useState<(typeof view)[]>([]);
  const [direction,setDirection]=useState<'forward'|'back'>('forward');
  // Orphan memos stay hidden, but are retained: a restore may bring their questions back.
  const [setId,setSetId]=useState(''),[selectedId,setSelectedId]=useState(''),[selected,setSelected]=useState<string[]>([]),[showAll,setShowAll]=useState(false);
  const [tables,setTables]=useState(true),[images,setImages]=useState(false),[examples,setExamples]=useState(true);
  const [paste,setPaste]=useState(''),[batch,setBatch]=useState<ExplanationBatch|null>(null),[stage,setStage]=useState<'paste'|'review'>('paste'),[failed,setFailed]=useState(false);
  const note=notes.find(n=>n.id===selectedId),question=data.questions.find(q=>q.id===note?.questionId);
  useEffect(()=>{const load=()=>{if(pendingEdits.current)return;try{setNotes(readWeaknessNotes());}catch{setError('メモを読み込めません。再読み込みしてください。');}};load();window.addEventListener(NOTES_EVENT,load);window.addEventListener('storage',load);return()=>{window.removeEventListener(NOTES_EVENT,load);window.removeEventListener('storage',load);};},[]);
  useEffect(()=>{onDirtyChange(failed||busy||Boolean(paste));return()=>onDirtyChange(false);},[failed,busy,paste,onDirtyChange]);
  const change=async(fn:(items:WeaknessNote[])=>WeaknessNote[])=>{try{const saved=await changeWeaknessNotes(fn);if(pendingEdits.current<=1)setNotes(saved);setFailed(false);setError('');return true;}catch{setFailed(true);setError('保存できません。入力内容を控えて再保存してください。');return false;}};
  const update=async(next:WeaknessNote)=>{pendingEdits.current+=1;onDirtyChange(true);setNotes(items=>items.map(n=>n.id===next.id?next:n));try{const ok=await change(items=>items.map(n=>n.id===next.id?{...n,body:next.body}:n));if(!ok)setNotes(items=>items.map(n=>n.id===next.id?next:n));if(pendingEdits.current===1)onDirtyChange(!ok);}finally{pendingEdits.current-=1;}};
  const go=(next:typeof view)=>{if(busy||failed||pendingEdits.current)return;if(paste&&next!=='import'&&!window.confirm('取り込み前の回答を閉じますか？'))return;if(next!=='import'){setPaste('');setBatch(null);}setDirection(next==='list'||history.includes(next)?'back':'forward');setMessage('');setError('');setHistory(items=>next==='list'?[]:items.includes(next)?items.slice(0,items.lastIndexOf(next)):[...items,view]);setView(next);};
  useEffect(()=>{onBackRef.current=()=>{
    if(busy||failed||pendingEdits.current)return true;
    if(view==='list')return false;
    setDirection('back');
    if(view==='import'&&stage==='review'){setStage('paste');return true;}
    if(paste&&!window.confirm('取り込み前の回答を閉じますか？'))return true;
    setPaste('');setBatch(null);setMessage('');setError('');
    setView(history[history.length-1]??'list');setHistory(items=>items.slice(0,-1));return true;
  };return()=>{onBackRef.current=null;};});
  const copy=async()=>{if(busy)return;setBusy(true);try{const fresh=readWeaknessNotes();const picked=selected.map(id=>{const n=fresh.find(n=>n.id===id);if(!n)throw new Error('選択したメモが削除されました。選び直してください。');return n;});const request=makeExplanationRequest(picked,data);await rememberExplanationRequest(request);await writeClipboardText(explanationPrompt(request,{tables,images,examples}));setMessage('依頼文をコピーしました');}catch(e){setError(e instanceof Error?e.message:'コピーできませんでした。');}finally{setBusy(false);}};
  const parse=()=>{try{setBatch(readExplanationBatch(paste));setStage('review');setError('');}catch(e){setError(e instanceof Error?e.message:'読み取れませんでした。');setBatch(null);}};
  const createQuestions=()=>{
    if(busy||failed)return;
    try {
      const fresh=readWeaknessNotes();
      const picked=selected.map(id=>{const n=fresh.find(n=>n.id===id&&n.questionId);if(!n)throw new Error('メモが削除されました。選び直してください。');return n;});
      const request=makeExplanationRequest(picked,data);
      onCreateQuestions(JSON.stringify(request.targets.map(t=>({疑問:t.memoBodies,元の問題:t.question,選択肢:t.choices,正解位置:t.answerIndexes,元の解説:t.explanation,詳細解説:t.previousExplanation})),null,2));
    }catch(e){setError(e instanceof Error?e.message:'メモを読み込めませんでした。');}
  };
  const apply=async()=>{if(!batch||busy)return;setBusy(true);setError('');try{const verified=readExplanationBatch(paste);await onApplyBatch(verified);await finishExplanationBatch(verified);setPaste('');setBatch(null);setMessage(`${verified.replies.length}件を反映しました`);setHistory(setId?['list']:[]);setView(setId?'set':'list');}catch(e){setError(e instanceof Error?e.message:'保存できませんでした。回答を残しています。');}finally{setBusy(false);}};
  const inSet=notes.filter(n=>n.questionId&&data.questions.some(q=>q.id===n.questionId&&q.setId===setId)&&n.body.trim());
  const title=view==='set'?data.problemSets.find(s=>s.id===setId)?.title:view==='prompt'?'AIへの依頼':view==='import'?'回答を取り込む':view==='question'?'解説・メモ':null;
  const chooseAll=(id:string)=>{setSetId(id);const ns=notes.filter(n=>n.questionId&&n.body.trim()&&!n.draft&&n.resolvedBody!==n.body&&data.questions.some(q=>q.id===n.questionId&&q.setId===id));setSelected(ns.map(n=>n.id));go('set');};
  return <section key={view} className={`weakness-workspace weakness-workspace--${direction}${view==='list'?' weakness-workspace--list':''}`} aria-label="苦手メモ">
    {title?<div className="weakness-toolbar"><h2>{title}</h2></div>:null}
    {error?<div role="alert" className="weakness-error">{error}{failed&&note?<button type="button" onClick={()=>update(note)}>再保存</button>:null}</div>:null}
    {message?<p className="weakness-status" role="status">{message}</p>:null}
    {view==='list'?<>
        {data.problemSets.filter(s=>notes.some(n=>n.questionId&&data.questions.some(q=>q.id===n.questionId&&q.setId===s.id))).map(s=>{const ns=notes.filter(n=>data.questions.some(q=>q.id===n.questionId&&q.setId===s.id));return <button type="button" key={s.id} className="weakness-row" onClick={()=>chooseAll(s.id)}><ProblemSetIcon size={32}/><span><strong>{s.title}</strong><small>未解説 {ns.filter(n=>n.body.trim()&&n.resolvedBody!==n.body).length} · 解説あり {ns.filter(n=>n.resolvedBody===n.body&&n.body.trim()).length}</small></span><ChevronRightIcon/></button>;})}
        {!notes.some(n=>n.questionId&&data.questions.some(q=>q.id===n.questionId))?<p className="weakness-muted">学習中に残した疑問がここにまとまります。</p>:null}
      {purpose==='answer'?<div className="weakness-import-dock"><button type="button" className="weakness-import-card" onClick={()=>{setSetId('');setStage('paste');go('import');}}><span>AIの回答を取り込む</span><ChevronRightIcon size={20}/></button></div>:null}
    </>:null}
    {view==='set'?<>
      <div className="weakness-step">① メモを選ぶ　→　② {purpose==='questions'?'問題を作る':'AIに解答を依頼'}</div>
      <label className="weakness-muted"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)}/> 解説済みも表示</label>
      {inSet.filter(n=>showAll||n.resolvedBody!==n.body).map(n=>{const q=data.questions.find(q=>q.id===n.questionId)!;return <div className="weakness-selection" key={n.id}><label><input type="checkbox" checked={selected.includes(n.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,n.id]:ids.filter(id=>id!==n.id))}/><span>{q.question.length>60?q.question.slice(0,60)+'…':q.question}</span></label><p>{n.body}</p><button type="button" className="weakness-text" onClick={()=>{setSelectedId(n.id);go('question');}}>{detailBody(q).trim()?'解説を読む・追加の疑問':'メモを開く'}</button>{n.draft?<span className="weakness-muted"> 下書き</span>:null}</div>;})}
      {!inSet.length?<p>メモはありません</p>:null}
      <div className="weakness-actions"><button type="button" className="weakness-primary" disabled={!selected.length||busy||failed} onClick={()=>purpose==='questions'?createQuestions():go('prompt')}>{purpose==='questions'?'選んだメモから問題を作る':`${selected.length}件をAIに解答してもらう`}</button></div>
    </>:null}
    {view==='question'&&question?<><WeaknessDetail key={question.id} questionId={question.id} text={detailBody(question)} onSave={body=>onSaveDetail(question.id,body)} onDirtyChange={setFailed}/>{note?<details><summary>選んだ疑問を編集</summary><textarea aria-label="保存した疑問" value={note.body} onChange={e=>update({...note,body:e.target.value})}/><button type="button" className="weakness-text" onClick={async()=>{if(window.confirm('この疑問を削除しますか？')&&await change(items=>items.filter(n=>n.id!==note.id)))go('set');}}>この疑問を削除</button></details>:null}</>:null}
    {view==='prompt'?<>
      <h3>解説に含めるもの</h3>
      {([['比較表',tables,setTables],['図・画像の依頼',images,setImages],['具体例',examples,setExamples]] as const).map(([label,value,set])=><label className="weakness-row" key={label}><span>{label}</span><input type="checkbox" checked={value} onChange={e=>set(e.target.checked)}/></label>)}
      <details><summary>選んだメモ　{selected.length}件</summary>{notes.filter(n=>selected.includes(n.id)).map(n=><p key={n.id}>{n.body}</p>)}</details>
      <p className="weakness-muted">生成された画像は、回答の取り込み後に添付できます。</p>
      <div className="weakness-actions"><button type="button" className="weakness-primary" disabled={busy} onClick={()=>void copy()}>{busy?'コピー中…':'依頼文をコピー'}</button></div>
      <button type="button" className="weakness-import-card" disabled={busy} onClick={()=>{setStage('paste');go('import');}}><span>AIの回答を取り込む</span><ChevronRightIcon size={20}/></button>
    </>:null}
    {view==='import'?<>
      <div className="weakness-tabs"><button type="button" aria-pressed={stage==='paste'} disabled={busy} onClick={()=>setStage('paste')}>貼り付け</button><button type="button" aria-pressed={stage==='review'} disabled={!batch||busy} onClick={()=>setStage('review')}>確認</button></div>
      {stage==='paste'?<><button type="button" className="weakness-text" onClick={async()=>{try{setPaste(await readClipboardText());setBatch(null);}catch{setError('回答欄へ直接貼り付けてください。');}}}>クリップボードから貼り付け</button><textarea aria-label="AIの解説JSON" value={paste} onChange={e=>{setPaste(e.target.value);setBatch(null);}}/><div className="weakness-actions"><button type="button" className="weakness-button" onClick={parse} disabled={!paste.trim()||busy}>読み取る</button></div></>:batch?<>
        <p className="weakness-status">{batch.replies.length}件を確認{batch.replies.length<batch.request.targets.length?`（依頼${batch.request.targets.length}件のうち）`:''}</p>
        {batch.replies.map(r=><details key={r.targetId}><summary>{batch.request.targets.find(t=>t.targetId===r.targetId)?.title}</summary><ExplanationReader text={r.body}/></details>)}
        <p className="weakness-muted">既存の解説・画像は残し、追加の解説を追記します。</p>
        <div className="weakness-actions"><button type="button" className="weakness-primary" disabled={busy} onClick={()=>void apply()}>{busy?'保存中…':`確認して${batch.replies.length}件を反映`}</button></div>
      </>:null}
    </>:null}
  </section>;
}
