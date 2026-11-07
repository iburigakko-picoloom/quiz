import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { groupProgressRpc, type CloudProblemSet } from '../utils/cloudService';
import { GROUP_ACTIVITY_UPDATED, retryStudyActivities } from '../utils/groupActivityService';
import { watchGroupProgress } from '../utils/groupReflectionQueue';
import { GroupEmpty, MemberAvatar } from './GroupLearningUi';
type Entry={id:string;user_id:string;display_name:string;set_id:string;title:string;finished_at:string;answered:number};
type Feed={enabled:boolean;generation:string|null;entries:Entry[]};
export function GroupTimeline({groupId,userId,sets,onOpenProgress}:{groupId:string;userId:string;sets:CloudProblemSet[];onOpenProgress?:(set:CloudProblemSet)=>void}) {
  const [feed,setFeed]=useState<Feed|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[more,setMore]=useState(false);
  const request=useRef(0),locked=useRef(false),pageDepth=useRef(1);
  const read=useCallback(async(before?:string)=>{
    const id=++request.current;
    try {
      const entries:Entry[]=[];
      let cursor=before, value:Feed|null=null, lastSize=0;
      const depth=before?1:pageDepth.current;
      for(let page=0;page<depth;page++) {
        value=await groupProgressRpc('quiz_group_activity_read',{p_group_id:groupId,p_before:cursor??null},userId) as Feed;
        if(id!==request.current)return;
        if(typeof value.enabled!=='boolean'||!Array.isArray(value.entries)||value.entries.some(e=>!/^\d+$/.test(e.id)||!e.user_id||!e.set_id||!Number.isSafeInteger(e.answered)||e.answered<1||!Number.isFinite(Date.parse(e.finished_at))))throw new Error('活動を読み込めません。');
        entries.push(...value.entries);lastSize=value.entries.length;
        if(lastSize<50)break;
        cursor=value.entries[lastSize-1].id;
      }
      if(!value)return;
      if(before)pageDepth.current++;
      const next=value;
      setFeed(old=>({...next,entries:before&&old?[...old.entries,...entries.filter(e=>!old.entries.some(o=>o.id===e.id))]:entries}));setMore(lastSize===50);setError('');
    }catch(reason){if(id===request.current){setFeed(null);setError(reason instanceof Error?reason.message:'活動を読み込めません。');}}
  },[groupId,userId]);
  useEffect(()=>{pageDepth.current=1;setFeed(null);void read();const stop=watchGroupProgress(()=>{if(!locked.current)void read();});const refresh=()=>{if(!locked.current)void read();};window.addEventListener(GROUP_ACTIVITY_UPDATED,refresh);return()=>{request.current++;stop();window.removeEventListener(GROUP_ACTIVITY_UPDATED,refresh);};},[read]);
  const consent=async(enabled:boolean)=>{
    if(!feed||locked.current)return;locked.current=true;setBusy(true);
    try{await groupProgressRpc('quiz_group_activity_consent',{p_group_id:groupId,p_enabled:enabled,p_expected_generation:feed.generation},userId);setConfirm(false);await read();}
    catch{setError('共有設定を変更できません。再読み込みしてください。');}
    finally{locked.current=false;setBusy(false);}
  };
  return <div className="group-timeline">
    <div className="group-panel__heading"><h2>タイムライン</h2></div>
    <details className="group-timeline__settings"><summary>共有設定・更新</summary><button type="button" className="group-secondary" disabled={busy||!feed} onClick={()=>feed?.enabled?void consent(false):setConfirm(true)}>{feed?.enabled?'活動共有を停止':'活動を共有する'}</button>
    {confirm?<div className="group-panel" role="group" aria-label="活動共有の確認"><p>今後の演習終了時に、名前・教材・日時・解答した問題数をこのグループに共有します。</p><button type="button" className="group-primary" disabled={busy} onClick={()=>void consent(true)}>同意して共有</button><button type="button" className="group-secondary" disabled={busy} onClick={()=>setConfirm(false)}>キャンセル</button></div>:null}
    <button type="button" className="group-text-link" disabled={busy} onClick={()=>{void retryStudyActivities().then(()=>read()).catch(()=>setError('未送信の活動があります。接続後に再試行してください。'));}}>更新・送信を再試行</button>
    </details>
    {error?<p role="alert" className="group-error">{error}</p>:null}
    {!feed&&!error?<p role="status">読み込み中…</p>:null}
    {feed&&!feed.entries.length?<GroupEmpty>共有された学習活動はまだありません。</GroupEmpty>:null}
    {feed?.entries.map((entry,i)=>{const set=sets.find(s=>s.id===entry.set_id);const day=new Date(entry.finished_at).toLocaleDateString('ja-JP');const previous=i ? new Date(feed.entries[i-1].finished_at).toLocaleDateString('ja-JP') : '';return <Fragment key={entry.id}>{day!==previous?<h3 className="group-timeline__date">{day}</h3>:null}<article className="group-timeline__row">
      <div className="group-progress-member__name"><MemberAvatar name={entry.display_name} userId={entry.user_id} self={entry.user_id===userId}/><strong>{entry.user_id===userId?'あなた':entry.display_name}</strong></div>
      <time dateTime={entry.finished_at}>{new Date(entry.finished_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</time>
      <div><button type="button" className="group-text-link" disabled={!set} onClick={()=>set&&onOpenProgress?.(set)}>{entry.title}</button></div>
      <p>{entry.answered}問を解答</p>
    </article></Fragment>;})}
    {more&&feed?.entries.length?<button type="button" className="group-secondary" onClick={()=>void read(feed.entries[feed.entries.length-1].id)}>もっと見る</button>:null}
  </div>;
}
