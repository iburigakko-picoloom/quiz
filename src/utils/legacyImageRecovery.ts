import { getAccountStorageSession, ACCOUNT_VAULT_MANIFEST_KEY, sameLocalAccount, validateLocalAccountIdentity } from './accountStorage';
import { readAppRecordSnapshot, materializeAppRecords, appRecordKey } from './appRecordStorage';
import { describeQuestionImage, validQuestionImageDescriptor, questionImageMetadataKey, IMAGE_SYNC_STORES, type StoredQuestionImage, type QuestionImageDescriptor } from './questionImageRecords';
import { queueAuxiliaryRecordWrite } from './auxiliaryRecordStorage';
import { withCoordinatedDataRead } from './dataCoordination';
import { SyncProtocolError, SyncInterruptedError } from './syncInterruption';
import { isSyncInteractionProtected } from './syncInteraction';
import { isAutoUploadBlocked } from './autoSyncScheduler';
import { getActiveProtectedWorkReason } from './protectedWork';

const done=(tx:IDBTransaction)=>new Promise<void>((r,j)=>{tx.oncomplete=()=>r();tx.onabort=()=>j(tx.error??new Error('旧画像の移行を保存できません。'));});
async function openExisting(name:string):Promise<IDBDatabase|null>{
  return new Promise((r,j)=>{
    const request=indexedDB.open(name);let absent=false,blocked=false;
    request.onupgradeneeded=()=>{absent=true;request.transaction?.abort();};
    request.onerror=()=>absent?r(null):j(request.error);
    request.onblocked=()=>{blocked=true;j(new Error('旧画像を開けません。別のQuizMake画面を閉じてください。'));};
    request.onsuccess=()=>{if(blocked)request.result.close();else r(request.result);};
  });
}
/** Only exact IDs and owners are recovered. Original stores are never changed,
 * unclaimed/other-account archives are never read, and tombstones stay deleted. */
export async function recoverLegacyImageMetadata(db:IDBDatabase,assertCurrent:()=>Promise<void>):Promise<void>{
  const owner=getAccountStorageSession();
  if(!owner?.identity)return;
  const current=async()=>{if(owner!==getAccountStorageSession())throw new Error('画像のアカウントが変わりました。');owner.assertCurrent();if(isSyncInteractionProtected()||isAutoUploadBlocked(getActiveProtectedWorkReason()))throw new SyncInterruptedError('protected_work','操作が終わると同期を再開します。');};
  await assertCurrent();
  await withCoordinatedDataRead(['app','notes'],async()=>{
    await current();const snapshot=await readAppRecordSnapshot(db);if(!snapshot)return;
    const data=materializeAppRecords(snapshot),refs=new Map<string,string>(),ambiguous=new Set<string>();
    for(const question of data.questions)for(const id of [...(question.questionImageIds??[]),...(question.detailedAnswer?.imageIds??[])]){
      if(refs.has(id)&&refs.get(id)!==question.id)ambiguous.add(id);else refs.set(id,question.id);
    }
    const needed=new Map([...refs].filter(([id])=>!ambiguous.has(id)&&!snapshot.records.has(appRecordKey('questionImages',id))));
    if(!needed.size)return;
    const read=db.transaction('questionImageBlobs'),readDone=done(read),live=read.objectStore('questionImageBlobs').getAll();await readDone;
    const candidates=new Map<string,{image:StoredQuestionImage;descriptor:QuestionImageDescriptor}>();
    const collect=async(images:StoredQuestionImage[])=>{
      for(const image of images){
        if(needed.get(image.id)!==image.questionId||ambiguous.has(image.id))continue;
        await current();
        let descriptor:QuestionImageDescriptor;try{descriptor=await describeQuestionImage(image);if(!validQuestionImageDescriptor(descriptor))continue;}catch{continue;}
        const previous=candidates.get(image.id);
        if(previous&&previous.descriptor.sha256!==descriptor.sha256){ambiguous.add(image.id);candidates.delete(image.id);continue;}
        if(!previous)candidates.set(image.id,{image,descriptor});
      }
    };
    await collect(live.result);
    const names=new Set([owner.databaseName('quiz-make-local-question-images-v1')]);
    const raw=globalThis.localStorage.getItem(ACCOUNT_VAULT_MANIFEST_KEY);
    if(raw)try{const manifest=JSON.parse(raw);if(manifest.version===1&&manifest.archived===true&&sameLocalAccount(validateLocalAccountIdentity(manifest.legacyOwner),owner.identity))names.add('quiz-make-local-question-images-v1');}catch{/* Unverified archives remain untouched. */}
    for(const name of names){
      await current();const original=await openExisting(name);
      try{if(original?.objectStoreNames.contains('images')){const tx=original.transaction('images'),complete=done(tx),images=tx.objectStore('images').getAll();await complete;await collect(images.result);}}
      finally{original?.close();}
    }
    if(!candidates.size)return;await current();
    const tx=db.transaction([...IMAGE_SYNC_STORES,'localProjections'],'readwrite'),complete=done(tx),state=tx.objectStore('appRecordMeta').get('state');let changed=false;
    state.onsuccess=()=>{try{
      owner.assertCurrent();if(state.result?.commitId!==snapshot.state.commitId){changed=true;tx.abort();return;}
      for(const {image,descriptor} of candidates.values()){
        const existing=tx.objectStore('appRecords').get(appRecordKey('questionImages',image.id));
        existing.onsuccess=()=>{try{owner.assertCurrent();if(existing.result!==undefined)return;tx.objectStore('questionImageBlobs').put(image,image.id);queueAuxiliaryRecordWrite(tx,'questionImages',image.id,JSON.stringify(descriptor),false);tx.objectStore('localProjections').put(JSON.stringify(descriptor),questionImageMetadataKey(image.id));}catch{tx.abort();}};
      }
    }catch{tx.abort();}};
    try{await complete;}catch(error){if(changed)throw new SyncProtocolError('local_changed','旧画像の確認中に端末が更新されました。');throw error;}
    await current();
  },{requireCrossContext:true});
  await assertCurrent();
}
