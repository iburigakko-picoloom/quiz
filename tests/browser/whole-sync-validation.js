import { cloudClient, getCloudAccessToken } from '../../src/utils/cloudService.ts';
import { AccountStorageSession, accountGenerationKey, accountNamespace, activateAccountStorage } from '../../src/utils/accountStorage.ts';
import { saveAppDataAsync, loadAppDataAsync, openAppDb } from '../../src/storage.ts';
import { normalizeAppData } from '../../src/utils/appDataValidation.ts';
import { createRecordSyncRpc } from '../../src/utils/recordSyncNetwork.ts';
import { runWholeRecordSync } from '../../src/utils/wholeSyncEngine.ts';
import { prepareRecordChunks } from '../../src/utils/recordChunks.ts';
import { chooseWholeConflict, readWholeMeta, readWholeBaseline } from '../../src/utils/wholeSyncStorage.ts';
import { withCoordinatedDataMutation } from '../../src/utils/dataCoordination.ts';
import { validateFileBackup } from '../../src/utils/backupPayload.ts';
import { buildWholeIncomingFile } from '../../src/utils/wholeSyncIncoming.ts';
import { listWholeRecovery, getWholeRecovery } from '../../src/utils/wholeRecovery.ts';
import { wholeHash } from '../../src/utils/wholeSyncDigest.ts';
import { createQuestionImageTransport, verifyQuestionImageBlob } from '../../src/utils/questionImageCloud.ts';
import { prepareQuestionImageOutbox, prepareStagedQuestionImages } from '../../src/utils/recordQuestionImageSync.ts';
import { saveQuestionImage, readQuestionImages, describeQuestionImage } from '../../src/utils/questionImageRecords.ts';
import { createMaterialTransport } from '../../src/utils/materialCloud.ts';

const config={url:import.meta.env.VITE_SUPABASE_URL,anonKey:import.meta.env.VITE_SUPABASE_ANON_KEY};
const params=new URLSearchParams(location.search), stamp='2026-10-07T00:00:00Z';
const sourceRevision=document.querySelector('meta[name="quiz-source-revision"]')?.content??'local';
const normalizedSeed=normalizeAppData({version:1,folders:[{id:'qa-folder',name:'Common',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'qa-set',folderId:'qa-folder',title:'Synthetic sync validation',source:'Synthetic',visibility:'private',createdAt:stamp,updatedAt:stamp}],questions:[],progress:[],answerLogs:[]});
if(!normalizedSeed.ok)throw new Error('試験初期状態が不正です');
const seed=normalizedSeed.data;
const check=(condition,message)=>{if(!condition)throw new Error(message)};
const access=async()=>{const result=await getCloudAccessToken();check(result.ok,'既存アカウントへのログインを確認できません');return result};
const randomHex=()=>Array.from(crypto.getRandomValues(new Uint8Array(15)),b=>b.toString(16).padStart(2,'0')).join('');
const question=id=>({id,setId:'qa-set',question:'Synthetic question',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'Synthetic',category:'QA',difficulty:'basic',sourcePage:'',createdAt:stamp,updatedAt:stamp});
const isDevice=params.has('device');

if(isDevice){
  document.querySelector('#start').remove();document.querySelector('p').remove();document.querySelector('h1').textContent='検証端末 '+params.get('device');
  const output=document.querySelector('#result'), generation=params.get('generation'), syncId=params.get('syncId'), nonce=params.get('nonce');
  check(/^union-[a-f0-9-]{36}$/.test(generation??'')&&/^cafe00[0-9a-f]{30}$/.test(syncId??'')&&nonce?.length===36,'試験保存先を確認できません');
  const initial=await access(), identity={project:new URL(config.url).origin,userId:initial.userId}, values=new Map([[accountGenerationKey(identity),generation]]);
  // Only this synthetic generation uses memory settings. The real account's
  // native generation pointer and existing IndexedDB databases stay untouched.
  const memory={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()};
  const session=new AccountStorageSession(memory,{identity,namespace:accountNamespace(identity),legacyUnclaimed:false});activateAccountStorage(session);
  let db=await openAppDb();
  // A new isolated database starts empty; reload reads its durable records.
  if(!(await loadAppDataAsync()).folders.length)check(await saveAppDataAsync(seed),'試験初期状態を保存できません');
  const connection={...identity,syncId};let offline=false,lose='',rpcCalls=0,cas=null;
  const assertCurrent=()=>{session.assertNetworkCurrent(identity)};
  const real=createRecordSyncRpc({...config,connection,assertCurrent,access:async()=>{const a=await access();check(a.userId===identity.userId,'アカウントが変わりました');return a},fetch:async(...args)=>{rpcCalls++;return fetch(...args)}});
  const rpc={...real,whole:async(name,body)=>{if(offline)throw new Error('QA offline boundary');const result=await real.whole(name,body);if(lose===name){lose='';throw new Error('QA lost '+name+' response after server result')}return result}};
  const guard={assertCurrent:async()=>assertCurrent(),device:JSON.stringify({version:1,id:params.get('device')==='A'?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'QA '+params.get('device')}),apply:op=>withCoordinatedDataMutation(['app','notes'],()=>op(),{requireCrossContext:true}),
    prepareOutgoing:async()=>{const a=await access();const media=await prepareQuestionImageOutbox(db,createQuestionImageTransport(config,a),guard.assertCurrent);if(media.more)return {more:true};await prepareRecordChunks(db,connection)},
    prepareMedia:async()=>{const a=await access();await prepareStagedQuestionImages(db,createQuestionImageTransport(config,a),guard.assertCurrent)},
    incoming:async rows=>{const a=await access();return buildWholeIncomingFile(db,rows,createMaterialTransport(config,a),guard.assertCurrent)}};
  const once=()=>runWholeRecordSync(db,connection,rpc,guard);
  const settle=async()=>{for(let i=0;i<50;i++){const r=await once();if(r.status!=='more')return r}throw new Error('試験が規定回数内に完了しません')};
  const snapshot=async()=>{const data=await loadAppDataAsync(),status=await real.whole('status'),baseline=await readWholeBaseline(db,connection), conflict=await readWholeMeta(db,'wholeConflict',connection),frozen=await readWholeMeta(db,'wholeFrozen',connection);return {name:data.folders[0]?.name,questions:data.questions.length,explanationLength:data.questions.find(q=>q.id==='qa-image-question')?.explanation.length??0,revision:status.revision,baseline:baseline?.serverRevision,conflict:conflict?{revision:conflict.revision,local:conflict.local,remote:conflict.remote}:null,frozen:frozen?{id:frozen.id,nextPart:frozen.nextPart??0,parts:frozen.parts.length}:null}};
  const operations={
    once,settle,snapshot,
    edit:async({name})=>{const prior=await loadAppDataAsync();check(await saveAppDataAsync({...prior,folders:[{...prior.folders[0],name,updatedAt:new Date().toISOString()}]}),'編集を保存できません');return snapshot()},
    fault:async({kind})=>{offline=kind==='offline';lose=kind==='part'||kind==='finish'?kind:'';return {fault:kind}},
    choose:async({choice})=>{const shown=await readWholeMeta(db,'wholeConflict',connection);check(shown,'全体競合がありません');await chooseWholeConflict(db,connection,shown,choice);return settle()},
    copies:async()=>{const copies=await listWholeRecovery(),names=[];for(const c of copies){const file=JSON.parse(await getWholeRecovery(c.id));check((await validateFileBackup(file)).ok,'復旧コピーが不完全です');names.push(JSON.parse(file.localStorage['quiz-make-app-data-v1']).folders[0].name)}return {count:copies.length,names}},
    old:async()=>{const before=(await real.whole('status')).revision;const p=await real.push([]),r=await real.pull(0);check(p.code==='whole_required'&&r.code==='whole_required','古い経路の拒否を確認できません');check((await real.whole('status')).revision===before,'旧経路で版が変わりました');return {push:p.code,pull:r.code,revision:before}},
    finishExisting:async({id})=>{check(/^[a-f0-9-]{36}$/.test(id),'試験UUIDが不正です');const result=await real.whole('finish',{p_operation_id:id});check(result.code==='ok','中断した試験の確定を確認できません');return {code:result.code,revision:result.revision}},
    prepareCas:async({name})=>{const prior=await loadAppDataAsync(),status=await real.whole('status'),id=crypto.randomUUID(),raw=JSON.stringify([{key:'["folders","qa-folder"]',collection:'folders',id:'qa-folder',raw:JSON.stringify({...prior.folders[0],name}),position:0}]),manifest={p_operation_id:id,p_expected_revision:status.revision,p_parts:1,p_records:1,p_digest:await wholeHash(await wholeHash(raw)),p_device:guard.device,p_replace:false};const started=await real.whole('begin',manifest);cas={id,revision:status.revision,manifest,busy:started.code==='busy'};if(cas.busy)return {code:'busy',revision:status.revision};check(started.code==='ok','CASを開始できません');const body={p_commit_id:id,p_operation_id:crypto.randomUUID(),p_number:0,p_raw:raw},duplicates=await Promise.all([real.whole('part',body),real.whole('part',body)]);check(duplicates.every(r=>r.code==='ok'),'重複パーツが安全に処理されません');return {code:'ok',revision:status.revision,duplicates:duplicates.map(r=>r.code)}},
    finishCas:async()=>{check(cas,'CAS未準備');const result=cas.busy?await real.whole('begin',cas.manifest):await real.whole('finish',{p_operation_id:cas.id});if(result.code==='conflict')await real.whole('abort',{p_operation_id:cas.id});return {code:result.code,revision:result.revision}},
    addDeleteFixture:async()=>{const prior=await loadAppDataAsync();check(await saveAppDataAsync({...prior,questions:[...prior.questions,question('qa-delete-question')]}),'削除試験を保存できません');return settle()},
    deleteFixture:async()=>{const prior=await loadAppDataAsync();check(await saveAppDataAsync({...prior,questions:prior.questions.filter(q=>q.id!=='qa-delete-question')}),'削除試験を保存できません');return settle()},
    large:async()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#388075';ctx.fillRect(0,0,64,64);ctx.fillStyle='#fff';ctx.font='9px monospace';ctx.fillText(syncId.slice(-10),2,32);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));check(blob,'画像を生成できません');await saveQuestionImage({id:'qa-image',questionId:'qa-image-question',name:'Synthetic.png',type:'image/png',blob,addedAt:stamp});const prior=await loadAppDataAsync(),questions=Array.from({length:40},(_,index)=>({...question(index===0?'qa-image-question':'qa-volume-question-'+index),...(index===0?{questionImageIds:['qa-image']}:{}),explanation:'Q'.repeat(655360)}));check(await saveAppDataAsync({...prior,questions}),'大容量問題集を保存できません');return snapshot()},
    image:async()=>{const data=await loadAppDataAsync(),q=data.questions.find(q=>q.id==='qa-image-question'),images=await readQuestionImages(q.id,q.questionImageIds);check(images.length===1,'画像が不足しています');const descriptor=await describeQuestionImage(images[0]);check(await verifyQuestionImageBlob(images[0].blob,descriptor),'画像ハッシュが不一致です');const bodyBytes=data.questions.reduce((sum,q)=>sum+q.explanation.length,0);check(data.questions.length===40&&bodyBytes===25*1024*1024,'問題数・本文長が不一致です');return {sha256:descriptor.sha256,imageBytes:descriptor.size,bodyBytes,questions:40}},
    fence:async()=>{const before=await snapshot(),requests=rpcCalls;session.fenceNetwork();let denied=false;try{await real.whole('status')}catch{denied=true}session.resumeNetwork(identity);check(denied&&rpcCalls===requests,'アカウント切替ガードの外へ送信しました');check(JSON.stringify(await snapshot())===JSON.stringify(before),'切替ガードでデータが変わりました');return {blockedBeforeFetch:true}},
  };
  window.addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==parent||event.data?.nonce!==nonce||!Object.hasOwn(operations,event.data?.action))return;const {id,action,args}=event.data;try{const result=await operations[action](args??{});parent.postMessage({nonce,id,ok:true,result},location.origin)}catch(error){parent.postMessage({nonce,id,ok:false,error:error instanceof Error?error.message:'試験失敗'},location.origin)}});
  output.textContent='独立したIndexedDBを使用しています';parent.postMessage({nonce,ready:true,device:params.get('device'),sourceRevision},location.origin);
}else{
  const output=document.querySelector('#result'),button=document.querySelector('#start'),client=cloudClient,frames={},pending=new Map(),results=[],resume=['cas','large'].includes(params.get('resume'));let counter=0,trial=null;
  if(resume){button.textContent='中断した試験の続き';output.textContent='既存の合成データと検証用保存領域で、同時接続以降の試験を再開します';}
  const report=(name,detail={})=>{results.push({name,passed:true,...detail});output.textContent=JSON.stringify({status:'実行中',results},null,2)};
  window.addEventListener('message',event=>{if(!trial||event.origin!==location.origin||event.data?.nonce!==trial.nonce||!Object.values(frames).some(f=>f.contentWindow===event.source))return;if(event.data.ready){frames[event.data.device].ready?.(event.data.sourceRevision);return}const waiting=pending.get(event.data.id);if(waiting){pending.delete(event.data.id);clearTimeout(waiting.timer);event.data.ok?waiting.resolve(event.data.result):waiting.reject(new Error(event.data.error))}});
  const command=(device,action,args={})=>new Promise((resolve,reject)=>{output.textContent=JSON.stringify({status:'実行中',awaiting:device+'.'+action,results},null,2);const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(new Error('検証端末の応答待ち: '+action))},180000);pending.set(id,{resolve,reject,timer});frames[device].contentWindow.postMessage({id,nonce:trial.nonce,action,args},location.origin)});
  const mount=async(device,reload=false)=>{if(frames[device])frames[device].remove();const f=document.createElement('iframe');f.title='検証端末 '+device;frames[device]=f;const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('検証端末の初期化待ち')),60000);f.ready=revision=>{clearTimeout(timer);revision===sourceRevision?resolve():reject(new Error('検証端末の配信版が一致しません'))}});f.src=location.pathname+'?'+new URLSearchParams({device,generation:trial[device],syncId:trial.syncId,nonce:trial.nonce,reload:String(reload),build:sourceRevision});document.querySelector('#devices').append(f);await ready};
  const status=()=>command('A','snapshot');
  button.addEventListener('click',async()=>{button.disabled=true;try{
    const owner=await access();if(!resume){trial={syncId:'cafe00'+randomHex(),A:'union-'+crypto.randomUUID(),B:'union-'+crypto.randomUUID(),nonce:crypto.randomUUID()};
    // Persist only tiny trial identifiers, never tokens or synthetic bodies.
    localStorage.setItem('quizMakeWholeQa:v1',JSON.stringify(trial));
    const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(seed)},indexedDbNotes:{}};
    const created=await client.rpc('quiz_sync_upsert_v2',{p_sync_id:trial.syncId,p_data:payload,p_updated_at:stamp,p_expected_updated_at:null,p_force:false});check(!created.error&&created.data?.[0]?.result_code==='ok','独立した試験データを作成できません');
    const opened=await client.rpc('quiz_sync_v2_open',{p_sync_id:trial.syncId,p_expected_updated_at:created.data[0].updated_at});check(!opened.error&&opened.data?.code==='ok','試験データを開始できません');
    await Promise.all([mount('A'),mount('B')]);check((await command('A','settle')).status==='done','A共通祖先');check((await command('B','settle')).status==='done','B共通祖先');report('実認証・独立した2保存領域・共通祖先');
    await command('A','edit',{name:'Local only'});await command('A','settle');await command('B','settle');check((await command('B','snapshot')).name==='Local only','片側の反映');report('端末だけの変更・クラウドだけの変更');
    await command('A','edit',{name:'Offline persisted'});await command('A','fault',{kind:'offline'});let failed=false;try{await command('A','once')}catch{failed=true}check(failed,'切断の検出');await mount('A',true);await command('A','settle');await command('B','settle');check((await command('B','snapshot')).name==='Offline persisted','復帰後の反映');report('通信切断の注入・再読み込み・IndexedDBから復帰');
    await command('A','edit',{name:'Cloud selected'});await command('B','edit',{name:'Device archived'});await command('A','settle');check((await command('B','settle')).status==='conflict','双方変更の競合');await command('B','choose',{choice:'remote'});check((await command('B','copies')).names.includes('Device archived'),'端末の復旧コピー');report('双方変更・クラウド選択・不採用端末の完全コピー');
    await command('A','edit',{name:'Cloud archived'});await command('B','edit',{name:'Device selected'});await command('A','settle');check((await command('B','settle')).status==='conflict','双方変更の競合');await command('B','fault',{kind:'part'});failed=false;try{await command('B','choose',{choice:'local'})}catch{failed=true}check(failed,'送信応答欠落');const beforePart=await command('B','snapshot');check(beforePart.frozen,'パーツ原本の保存');await mount('B',true);check((await command('B','snapshot')).frozen.id===beforePart.frozen.id,'再起動でUUIDが変わりました');await command('B','settle');await command('A','settle');check((await command('B','copies')).names.includes('Cloud archived'),'クラウドの復旧コピー');report('端末選択・不採用クラウドの完全コピー・パーツ応答欠落と再送');
    const beforeFinish=await status();await command('A','edit',{name:'Finish response lost'});await command('A','fault',{kind:'finish'});failed=false;try{await command('A','once')}catch{failed=true}check(failed,'確定応答欠落');const frozen=await status();check(frozen.frozen&&frozen.revision===beforeFinish.revision+1,'送信結果の保持');await mount('A',true);await command('A','settle');check((await status()).revision===frozen.revision,'再送が再確定しました');await command('B','settle');report('確定応答欠落・再起動・同一UUIDで領収書確認');
    }else{trial=JSON.parse(localStorage.getItem('quizMakeWholeQa:v1'));check(/^cafe00[0-9a-f]{30}$/.test(trial?.syncId),'以前の検証用同期先を確認できません');await Promise.all([mount('A',true),mount('B',true)]);if(params.get('commit'))await command('A','finishExisting',{id:params.get('commit')});if(params.get('resume')!=='large'){await command('A','settle');await command('B','settle');}}
    if(params.get('resume')!=='large'){
    const raceStart=(await status()).revision,devices=['A','B'],prepared=await Promise.all(devices.map(d=>command(d,'prepareCas',{name:'CAS '+d})));check(prepared.map(r=>r.code).sort().join(',')==='busy,ok','同時開始の保護');const winner=devices[prepared.findIndex(r=>r.code==='ok')],loser=devices[prepared.findIndex(r=>r.code==='busy')];const duplicateFinish=await Promise.all([command(winner,'finishCas'),command(winner,'finishCas')]);check(duplicateFinish.every(r=>r.code==='ok'&&r.revision===raceStart+1),'重複確定が安全に処理されません');check((await command(loser,'finishCas')).code==='conflict','古いCASが受理されました');check((await status()).revision===raceStart+1,'同時確定が複数版進みました');await command('A','settle');await command('B','settle');report('実際の複数接続・重複パーツと確定・古いCAS拒否', {beginCodes:prepared.map(r=>r.code)});
    report('古いクライアントのpush/pull拒否',await command('A','old'));
    await command('A','addDeleteFixture');await command('B','settle');await command('A','deleteFixture');await command('B','edit',{name:'Old device edit'});check((await command('B','settle')).status==='conflict','古い端末の変更検出');await command('B','choose',{choice:'remote'});check((await command('B','snapshot')).questions===0,'削除が復活しました');report('削除・古い端末の編集・クラウド選択で削除を保持');
    report('アカウント切替時の送信フェンス（同一アカウント内の模擬切替）',await command('A','fence'));
    const renewed=await client.auth.refreshSession();check(!renewed.error&&renewed.data.user.id===owner.userId,'同一アカウントの認証更新');await command('A','settle');await command('B','settle');report('実Authのセッション更新後に所有者を再検証');
    }
    await command('A','large');await command('A','settle');await command('B','settle');const [imageA,imageB]=await Promise.all([command('A','image'),command('B','image')]);check(JSON.stringify(imageA)===JSON.stringify(imageB),'大容量本文・画像が不一致です');await mount('B',true);check(JSON.stringify(await command('B','image'))===JSON.stringify(imageA),'再読み込み後の画像・本文');report('40問・本文合計25 MiB・実Storage画像・SHA256・再起動後読み戻し',imageA);
    output.textContent=JSON.stringify({status:'成功',syncId:trial.syncId,results,limitations:['同一ブラウザ内の独立したIndexedDBを2端末として使用','通信切断はアプリの通信境界に注入','別アカウントの実Authと物理Android端末は未実施','試験データと復旧コピーは保持し、自動削除しない']},null,2);
  }catch(error){output.textContent=JSON.stringify({status:'保護停止',syncId:trial?.syncId,results,error:error instanceof Error?error.message:'試験失敗'},null,2)} });
}
