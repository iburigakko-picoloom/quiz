import {useEffect,useRef,useState} from 'react';
import {publicationIdentity,publicationRpc,groupProgressRpc,publicLibraryRpc,getSharedProblemSet,type CloudPublishResult} from '../utils/cloudService';
import type {PublicationSource} from '../types';
import {publicationSourceFromSnapshot} from '../utils/groupStudySource';
import {publicationRepository,publicationScope,type PublicationJob} from '../utils/publicationStorage';
import {PublicationQueue} from '../utils/publicationQueue';
import type {PublicationPayload} from '../utils/publicationPayload';
import {assertAccountNetworkCurrent} from '../utils/accountStorage';
const queues=new Map<string,PublicationQueue>();
export function usePublicationQueue(userId:string,onPublished:(id:string,result:CloudPublishResult,source?:PublicationSource)=>Promise<void>) {
  const callback=useRef(onPublished);callback.current=onPublished;
  const [state,setState]=useState<{scope:string;jobs:PublicationJob[];running:boolean;revision:number;error:string}>({scope:'',jobs:[],running:false,revision:0,error:''});
  const queueRef=useRef<PublicationQueue|null>(null);
  const scope=userId?publicationScope(publicationIdentity(userId)):'';
  useEffect(()=>{
    queueRef.current=null;if(!scope)return;
    let queue=queues.get(scope);if(!queue){queue=new PublicationQueue({scope,repository:publicationRepository(publicationIdentity(userId)),rpc:(name,args)=>publicationRpc(name,args,userId),apply:async()=>{}});queues.set(scope,queue);}
    queue.dependencies.apply=async(job,result)=>{
      assertAccountNetworkCurrent(publicationIdentity(userId));
      const payload=await queue!.dependencies.repository.payload(job.id),shared=await getSharedProblemSet(result.id);
      assertAccountNetworkCurrent(publicationIdentity(userId));
      const groupIds=[...(Array.isArray(payload.p_set.group_ids)?payload.p_set.group_ids.filter((id):id is string=>typeof id==='string'):[]),...(job.groupId?[job.groupId]:[])];
      // Read the current owned publication. Retrying an older completed job must
      // not roll the owner's original back to an obsolete publication version.
      const source=publicationSourceFromSnapshot(shared,userId,job.localSetId,shared.versionId===result.versionId?groupIds:[]);
      await callback.current(job.localSetId,{...result,visibility:shared.visibility,versionId:shared.versionId},source);
      if(job.groupFolderId&&job.groupId)await groupProgressRpc('quiz_group_learning_place',{p_group_id:job.groupId,p_set_id:result.id,p_folder_id:job.groupFolderId},userId);
      if(job.publicFolderId){await publicLibraryRpc('quiz_public_folder_manage',{p_action:'add',p_id:job.publicFolderId,p_set_id:result.id,p_path:job.publicFolderPath??[]},userId);await publicLibraryRpc('quiz_public_folder_manage',{p_action:'ready',p_id:job.publicFolderId},userId);}
    };
    queueRef.current=queue;const update=()=>setState({scope,jobs:queue!.jobs,running:queue!.running,revision:queue!.revision,error:queue!.error});const stop=queue.subscribe(update);update();
    void queue.restore().catch(()=>setState(old=>({...old,error:'公開状態を端末に保存できません。空き容量とブラウザの保存設定を確認してください。'})));
    return stop;
  },[scope,userId]);
  return {jobs:state.scope===scope?state.jobs:[],running:state.scope===scope&&state.running,revision:state.scope===scope?state.revision:0,error:state.scope===scope?state.error:'',
    enqueue:async(rows:{payload:PublicationPayload;groupFolderId?:string;groupId?:string;publicFolderId?:string;publicFolderPath?:import('../utils/sharedFolders').SharedFolderPart[];preparationError?:string}[])=>{const queue=queueRef.current;if(!queue||queue.dependencies.scope!==scope)throw new Error('公開アカウントが変わりました。画面を開き直してください。');return queue.enqueue(rows);},
    retry:(id:string)=>queueRef.current?.dependencies.scope===scope?queueRef.current.retry(id):undefined,cancelForSet:(id:string)=>queueRef.current?.dependencies.scope===scope?queueRef.current.cancelForSet(id):undefined,cancelForFolder:(id:string)=>queueRef.current?.dependencies.scope===scope?queueRef.current.cancelForFolder(id):undefined};
}
