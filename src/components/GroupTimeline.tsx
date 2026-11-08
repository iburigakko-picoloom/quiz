import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { getCachedCloudAccountIdentity, groupProgressRpc, onCloudAuthStateChange, type CloudProblemSet } from '../utils/cloudService';
import { GROUP_ACTIVITY_UPDATED, retryStudyActivities } from '../utils/groupActivityService';
import { MANUAL_ACTIVITY_UPDATED, retryManualActivities } from '../utils/groupManualActivityService';
import { manualActivityOutbox, type ManualActivityItem } from '../utils/groupManualActivityOutbox';
import { parseActivityFeed, type ActivityEntry, type ActivityFeed } from '../utils/groupActivityFeed';
import { watchGroupProgress } from '../utils/groupReflectionQueue';
import { GroupEmpty, MemberAvatar } from './GroupLearningUi';
import { ManualActivityComposer } from './ManualActivityComposer';
import { sameLocalAccount } from '../utils/accountStorage';
import { useAccountWork, useRestoredAccountWork } from '../hooks/useAccountWork';

export function GroupTimeline({groupId,groupName,userId,sets,onOpenProgress}:{groupId:string;groupName:string;userId:string;sets:CloudProblemSet[];onOpenProgress?:(set:CloudProblemSet)=>void}) {
  const workKey=`group-timeline:${groupId}:${userId}`;
  const restored=useRestoredAccountWork<{manualGeneration:string|null}>(workKey);
  const [feed,setFeed]=useState<ActivityFeed|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[more,setMore]=useState(false),[manualGeneration,setManualGeneration]=useState<string|null>(restored?.manualGeneration??null);
  useAccountWork(workKey,()=>({manualGeneration}));
  const [outbox,setOutbox]=useState<ManualActivityItem[]>([]);
  const request=useRef(0),locked=useRef(false),pageDepth=useRef(1),active=useRef(true),settingsRef=useRef<HTMLDetailsElement>(null);
  const read=useCallback(async(before?:string)=>{
    if(!active.current)return;
    const id=++request.current;
    try {
      const entries:ActivityEntry[]=[];
      let cursor=before, value:ActivityFeed|null=null, lastSize=0;
      const depth=before?1:pageDepth.current;
      for(let page=0;page<depth;page++) {
        value=parseActivityFeed(await groupProgressRpc('quiz_group_activity_read_v2',{p_group_id:groupId,p_before:cursor??null},userId));
        if(id!==request.current||!active.current)return;
        entries.push(...value.entries);lastSize=value.entries.length;
        if(lastSize<50)break;
        cursor=value.entries[lastSize-1].id;
      }
      if(!value)return;
      if(before)pageDepth.current++;
      const next=value;
      setFeed(old=>({...next,entries:before&&old?[...old.entries,...entries.filter(e=>!old.entries.some(o=>o.id===e.id))]:entries}));setMore(lastSize===50);setError('');
    }catch(reason){if(id===request.current&&active.current){setFeed(null);setError(reason instanceof Error?reason.message:'活動を読み込めません。');}}
  },[groupId,userId]);
  const readOutbox=useCallback(async()=>{
    const identity=getCachedCloudAccountIdentity();if(!identity||identity.userId!==userId||!active.current){setOutbox([]);return;}
    try {const items=await manualActivityOutbox(identity).list();if(active.current&&sameLocalAccount(getCachedCloudAccountIdentity(),identity))setOutbox(items.filter(item=>item.row.groupId===groupId));}
    catch {if(active.current)setOutbox([]);}
  },[groupId,userId]);
  useEffect(()=>{
    active.current=true;pageDepth.current=1;setFeed(null);setOutbox([]);void read();void readOutbox();
    const stop=watchGroupProgress(()=>{if(!locked.current)void read();void readOutbox();});
    const refresh=()=>{if(!locked.current)void read();void readOutbox();};
    const stopAuth=onCloudAuthStateChange((_event,session)=>{if(session?.user.id!==userId){active.current=false;request.current++;setFeed(null);setOutbox([]);setError('アカウントが変更されています。画面を閉じてください。');}});
    window.addEventListener(GROUP_ACTIVITY_UPDATED,refresh);window.addEventListener(MANUAL_ACTIVITY_UPDATED,refresh);
    return()=>{active.current=false;request.current++;stop();stopAuth();window.removeEventListener(GROUP_ACTIVITY_UPDATED,refresh);window.removeEventListener(MANUAL_ACTIVITY_UPDATED,refresh);};
  },[read,readOutbox,userId]);
  const consent=async(enabled:boolean)=>{
    if(!feed||locked.current)return;locked.current=true;setBusy(true);
    try{await groupProgressRpc('quiz_group_activity_consent',{p_group_id:groupId,p_enabled:enabled,p_expected_generation:feed.generation},userId);setConfirm(false);await read();}
    catch{setError('共有設定を変更できません。再読み込みしてください。');}
    finally{locked.current=false;setBusy(false);}
  };
  const retry=async()=>{
    const results=await Promise.allSettled([retryStudyActivities(),retryManualActivities()]);
    await readOutbox();await read();if(results.some(result=>result.status==='rejected'))setError('未送信の活動があります。接続後に再試行してください。');
  };
  const removeLocal=async(item:ManualActivityItem)=>{
    if(!window.confirm(item.status==='rejected'?'送信できなかった記録を取り消しますか？':'端末の送信待ちを削除しますか？ 既に共有済みの場合は、共有設定を停止すると表示されなくなります。'))return;
    const identity=getCachedCloudAccountIdentity();if(!identity||identity.userId!==userId)return;
    try{await manualActivityOutbox(identity).remove(item.row.id);await readOutbox();}catch{setError('記録を取り消せませんでした。');}
  };
  return <div className="group-timeline">
    <div className="group-panel__heading"><h2>タイムライン</h2></div>
    <details ref={settingsRef} className="group-timeline__settings"><summary>共有設定・更新</summary><button type="button" className="group-secondary" disabled={busy||!feed} onClick={()=>feed?.enabled?void consent(false):setConfirm(true)}>{feed?.enabled?'活動共有を停止':'活動を共有する'}</button>
    {confirm?<div className="group-panel" role="group" aria-label="活動共有の確認"><p>今後の演習終了時に、名前・教材・日時・解答した問題数をこのグループに共有します。手動の記録は内容を確認してから共有します。</p><button type="button" className="group-primary" disabled={busy} onClick={()=>void consent(true)}>同意して共有</button><button type="button" className="group-secondary" disabled={busy} onClick={()=>setConfirm(false)}>キャンセル</button></div>:null}
    <button type="button" className="group-text-link" disabled={busy} onClick={()=>void retry()}>更新・送信を再試行</button>
    </details>
    {manualGeneration?<ManualActivityComposer groupId={groupId} groupName={groupName} userId={userId} generation={manualGeneration} onClose={()=>setManualGeneration(null)} onCompleted={status=>{setManualGeneration(null);setNotice(status==='sent'?'学習を記録しました。':status==='rejected'?'共有設定が変わったため送信できませんでした。':'端末に保存しました。接続後に送信します。');void readOutbox();void read();}}/>:null}
    {notice?<p role="status">{notice}</p>:null}
    {outbox.map(item=><div className="group-panel" key={item.row.id}><strong>{item.row.title}</strong><p>{item.status==='pending'?'送信待ち':'共有設定が変わったため送信できませんでした。'}</p><button type="button" className="group-text-link" onClick={()=>void removeLocal(item)}>{item.status==='rejected'?'記録を取り消す':'端末の送信待ちを削除'}</button></div>)}
    {error?<p role="alert" className="group-error">{error}</p>:null}
    {!feed&&!error?<p role="status">読み込み中…</p>:null}
    {feed&&!feed.entries.length?<GroupEmpty>共有された学習活動はまだありません。</GroupEmpty>:null}
    {feed?.entries.map((entry,i)=>{const set=entry.set_id?sets.find(s=>s.id===entry.set_id):undefined;const day=new Date(entry.finished_at).toLocaleDateString('ja-JP');const previous=i ? new Date(feed.entries[i-1].finished_at).toLocaleDateString('ja-JP') : '';return <Fragment key={entry.id}>{day!==previous?<h3 className="group-timeline__date">{day}</h3>:null}<article className="group-timeline__row">
      <div className="group-progress-member__name"><MemberAvatar name={entry.display_name} userId={entry.user_id} self={entry.user_id===userId}/><strong>{entry.user_id===userId?'あなた':entry.display_name}</strong></div>
      <time dateTime={entry.finished_at}>{new Date(entry.finished_at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</time>
      <div>{entry.kind==='session'?<button type="button" className="group-text-link" disabled={!set} onClick={()=>set&&onOpenProgress?.(set)}>{entry.title}</button>:<strong>{entry.title}</strong>}</div>
      <p>{entry.answered!==null?`${entry.answered}問${entry.kind==='session'?'を解答':''}`:''}{entry.answered!==null&&entry.minutes!==null?'・':''}{entry.minutes!==null?`${entry.minutes}分`:''}</p>
    </article></Fragment>;})}
    {more&&feed?.entries.length?<button type="button" className="group-secondary" onClick={()=>void read(feed.entries[feed.entries.length-1].id)}>もっと見る</button>:null}
    <div className="group-timeline__compose"><button type="button" aria-label="学習を記録" disabled={!feed} onClick={()=>{if(feed?.enabled&&feed.generation)setManualGeneration(feed.generation);else if(feed){if(settingsRef.current)settingsRef.current.open=true;setConfirm(true);}}}><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z"/></svg></button></div>
  </div>;
}
