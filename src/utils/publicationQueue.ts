import type {CloudPublishResult} from './cloudService';
import type {PublicationPayload} from './publicationPayload';
import {publicationDigest,publicationFailure,publicationId,publicationResult,parsePublicationStatus,PublicationError,uploadPublication,type PublicationTransport} from './publicationProtocol';
import type {PublicationJob,PublicationRepository} from './publicationStorage';
export interface PublicationQueueDependencies {repository:PublicationRepository;scope:string;rpc:PublicationTransport;apply:(job:PublicationJob,result:CloudPublishResult)=>Promise<void>}
export class PublicationQueue {
  jobs:PublicationJob[]=[];running=false;revision=0;error='';private listeners=new Set<()=>void>();private task:Promise<void>|null=null;private cancelled=new Set<string>();private creationClock=0;private rerun=false;
  readonly dependencies:PublicationQueueDependencies;
  constructor(dependencies:PublicationQueueDependencies){this.dependencies=dependencies;}
  subscribe(listener:()=>void){this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  private emit(){this.revision++;this.listeners.forEach(listener=>listener());}
  private async refresh(){this.jobs=await this.dependencies.repository.list();this.emit();}
  async restore(){await this.refresh();if(this.task)return;for(const job of this.jobs.filter(job=>job.state==='publishing'))await this.dependencies.repository.update({...job,state:'queued'});await this.refresh();if(this.jobs.some(job=>job.state==='queued'||job.state==='completed'&&!job.applied&&!job.warning))void this.run();}
  async enqueue(rows:{payload:PublicationPayload;groupFolderId?:string;groupId?:string;publicFolderId?:string;publicFolderPath?:import('./sharedFolders').SharedFolderPart[];preparationError?:string}[]) {
    const existing=await this.dependencies.repository.list();
    for(const job of existing)this.creationClock=Math.max(this.creationClock,Date.parse(job.createdAt)||0);
    const entries=[];
    for(const row of rows){const payload=structuredClone(row.payload),digest=await publicationDigest(payload),id=publicationId();this.creationClock=Math.max(Date.now(),this.creationClock+1);const job:PublicationJob={id,digest,scope:this.dependencies.scope,title:String(payload.p_set.title),localSetId:String(payload.p_set.local_set_id),state:row.preparationError?'failed':'queued',error:row.preparationError,errorCode:row.preparationError?'invalid':undefined,retryable:row.preparationError?false:undefined,phase:'preparing',uploaded:0,total:payload.p_questions.length,createdAt:new Date(this.creationClock).toISOString(),groupFolderId:row.groupFolderId,groupId:row.groupId,publicFolderId:row.publicFolderId,publicFolderPath:row.publicFolderPath};entries.push({job,payload});}
    await this.dependencies.repository.enqueue(entries);await this.refresh();void this.run();return entries.map(row=>row.job.id);
  }
  async retry(id:string){const job=(await this.dependencies.repository.list()).find(job=>job.id===id);if(!job||(job.state==='failed'&&!job.retryable))return;await this.dependencies.repository.update({...job,state:job.result?'completed':'queued',error:undefined,warning:undefined});await this.refresh();void this.run();}
  async cancelForSet(localSetId:string){const jobs=(await this.dependencies.repository.list()).filter(job=>job.localSetId===localSetId&&(job.state==='queued'||job.state==='publishing'||job.state==='completed'&&!job.applied));for(const job of jobs){this.cancelled.add(job.id);await this.dependencies.rpc('quiz_publish_cancel',{p_job_id:job.id});await this.dependencies.repository.update({...job,state:'failed',error:'公開を中止しました。',errorCode:'cancelled',retryable:false,warning:undefined});await this.dependencies.repository.retirePayload(job.id);}await this.refresh();}
  async cancelForFolder(id:string){const jobs=(await this.dependencies.repository.list()).filter(job=>job.publicFolderId===id&&(job.state==='queued'||job.state==='publishing'||job.state==='completed'&&!job.applied));for(const job of jobs){this.cancelled.add(job.id);await this.dependencies.rpc('quiz_publish_cancel',{p_job_id:job.id});await this.dependencies.repository.update({...job,state:'failed',error:'フォルダの公開を中止しました。',errorCode:'cancelled',retryable:false,warning:undefined});await this.dependencies.repository.retirePayload(job.id);}await this.refresh();}
  private async save(job:PublicationJob){if(this.cancelled.has(job.id)&&job.state!=='failed')throw new PublicationError('公開を中止しました。','cancelled',false);await this.dependencies.repository.update(job);await this.refresh();}
  run():Promise<void>{if(this.task){this.rerun=true;return this.task;}
    const work=async()=>{this.running=true;this.error='';this.emit();try {
      for(;;){const jobs=await this.dependencies.repository.list();let job=jobs.find(job=>job.state==='queued'||job.state==='completed'&&!job.applied&&!job.warning);if(!job)break;
        try {if(!job.result){await this.save(job={...job,state:'publishing',error:undefined});const payload=await this.dependencies.repository.payload(job.id);
          const result=await uploadPublication(payload,job.id,job.digest,this.dependencies.rpc,async progress=>{await this.save(job={...job!,...progress,uploaded:progress.phase==='preparing'?job!.uploaded:progress.uploaded});});
          await this.save(job={...job,state:'completed',phase:'completed',uploaded:job.total,result,applied:false});
        }
        const authoritative=parsePublicationStatus(await this.dependencies.rpc('quiz_publish_status',{p_job_id:job.id}),job.total);
        job={...job,result:publicationResult(authoritative)};
        if(this.cancelled.has(job.id))throw new PublicationError('公開を中止しました。','cancelled',false);
        try {await this.dependencies.apply(job,job.result!);await this.save({...job,applied:true,warning:undefined});await this.dependencies.repository.retirePayload(job.id);}
        catch(error){await this.save({...job,warning:'公開は完了しましたが、端末への反映・フォルダへの配置を確認できません。',applied:false});console.warn('[QuizMake publication apply]',{operationId:job.id,code:error instanceof PublicationError?error.code:'apply'});}
        }catch(reason){const error=reason instanceof PublicationError?reason:publicationFailure('network',reason instanceof Error?reason.message:'');if(!error.retryable&&error.code!=='withdrawn')await this.dependencies.rpc('quiz_publish_cancel',{p_job_id:job.id}).catch(()=>{});await this.save({...job,state:'failed',error:error.message,errorCode:error.code,retryable:error.retryable});console.warn('[QuizMake publication]',{operationId:job.id,phase:job.phase,code:error.code,technical:error.technical});}
      }
    }finally{this.running=false;await this.refresh();}};
    const locked=async()=>{if(globalThis.navigator?.locks){await navigator.locks.request(`quiz-publication:${this.dependencies.scope}`,{mode:'exclusive'},work);}else await work();};
    this.task=locked().catch(error=>{this.error='公開状態を端末に保存できません。保存設定と空き容量を確認して再読み込みしてください。';this.emit();console.warn('[QuizMake publication journal]',{code:error instanceof PublicationError?error.code:'storage'});}).finally(()=>{this.task=null;if(this.rerun){this.rerun=false;void this.run();}});return this.task;
  }
}
