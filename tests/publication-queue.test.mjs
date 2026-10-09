import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indexedDB} from 'fake-indexeddb';
import {publicationDigest,publicationParts,PublicationError,publicationFailure,uploadPublication} from '../src/utils/publicationProtocol.ts';
import {PublicationQueue} from '../src/utils/publicationQueue.ts';
import {publicationRepository,publicationScope} from '../src/utils/publicationStorage.ts';
import {prepareLocalPublication} from '../src/utils/publicationPayload.ts';
globalThis.indexedDB=indexedDB;
const identity={project:'https://example.test',userId:'owner'};
const payload=(title,n=300)=>({p_set:{local_set_id:title,title,visibility:'public'},p_questions:Array.from({length:n},(_,position)=>({position,logical_id:`q-${position}`,question:`Question ${position}`,choices:['A','B','C','D']}))});
function mockServer(){const jobs=new Map(),counts={parts:0,commits:0};let loseFinish=false;
  return {jobs,counts,loseFinish:()=>{loseFinish=true;},rpc:async(name,args)=>{
    let job=jobs.get(args.p_job_id);
    if(name==='quiz_publish_begin'){if(!job){job={state:'uploading',uploaded:0,total:args.p_total,metadata:args.p_set};jobs.set(args.p_job_id,job);}return {...job};}
    if(name==='quiz_publish_part'){counts.parts++;if(args.p_start===job.uploaded)job.uploaded+=args.p_questions.length;return {...job};}
    if(name==='quiz_publish_finish'){if(job.state!=='completed'){counts.commits++;job.state='completed';job.is_current=true;job.result={id:'shared-'+args.p_job_id,share_token:'token',version_id:'version',visibility:'public'};}if(loseFinish){loseFinish=false;throw publicationFailure('network');}return {...job};}
    if(name==='quiz_publish_cancel'){if(job)job.state='cancelled';return true;}
    return {...job};
  }};
}
test('payload captures public content and randomization only, preserving folder namespace and excluding learning data',()=>{
  const value=prepareLocalPublication({data:{folders:[{id:'f',name:'English'}],problemSets:[{id:'s',folderId:'f',title:'Set'}],questions:[{id:'q',setId:'s',question:'Q',choices:['A','B','C','D'],answerIndex:0,distractors:['E'],shuffleChoices:false}],progress:[{secret:'progress'}],answerLogs:[{secret:'log'}]},setId:'s',visibility:'public',authorName:'Owner',includeFolder:true,publicationInfo:{audience:'Test',description:''}});
  assert.deepEqual(value.p_set.folder_path,[{id:'f',name:'English'}]);assert.deepEqual(value.p_questions[0].distractors,['E']);assert.equal(value.p_questions[0].shuffle_choices,false);assert.ok(!JSON.stringify(value).includes('secret'));
});
test('chunks respect both question and byte limits and incomplete cursor acknowledgements fail closed',async()=>{
  const parts=publicationParts(payload('large',10000).p_questions);assert.equal(parts.length,40);assert.ok(parts.every(p=>p.questions.length<=250));
  const big=publicationParts(payload('large',8).p_questions.map(q=>({...q,explanation:'x'.repeat(150000)})));assert.ok(big.length>=3);
  const p=payload('bad',1);await assert.rejects(uploadPublication(p,'id',await publicationDigest(p),async()=>({state:'uploading',uploaded:10,total:1})),/公開状態/);
});
test('lost commit acknowledgement is retried idempotently; changing a frozen snapshot is rejected',async()=>{
  const server=mockServer();server.loseFinish();const p=payload('lost'),digest=await publicationDigest(p);const result=await uploadPublication(p,'op',digest,server.rpc);assert.equal(server.counts.commits,1);assert.equal(server.counts.parts,2);
  assert.deepEqual(await uploadPublication(p,'op',digest,server.rpc),result);assert.equal(server.counts.commits,1);
  await assert.rejects(uploadPublication({...p,p_questions:[...p.p_questions,{position:300}]},'op',digest,server.rpc),/保存した公開データ/);
});
test('failed set does not stop the folder queue; only that set is retried with the same operation',async()=>{
  const repository=publicationRepository({...identity,userId:'folder-owner'}),scope=publicationScope({...identity,userId:'folder-owner'}),server=mockServer();let fail=true;const applied=[];
  const queue=new PublicationQueue({repository,scope,rpc:async(name,args)=>{if(name==='quiz_publish_part'&&server.jobs.get(args.p_job_id)?.metadata.title==='failed'&&fail)throw publicationFailure('57014','canceling statement due to statement timeout');return server.rpc(name,args);},apply:async(job)=>{applied.push(job.title);}});
  const ids=await queue.enqueue([{payload:payload('failed')},{payload:payload('later')}]);await queue.run();
  assert.deepEqual(queue.jobs.map(job=>job.state),['failed','completed']);assert.deepEqual(applied,['later']);assert.equal(queue.jobs[0].errorCode,'timeout');
  fail=false;await queue.retry(ids[0]);await queue.run();assert.deepEqual(queue.jobs.map(job=>job.state),['completed','completed']);assert.deepEqual(applied,['later','failed']);assert.equal(server.counts.commits,2);
});
test('app restart restores publishing state from IndexedDB and resumes acknowledged server prefix',async()=>{
  const owner={...identity,userId:'restart'},repository=publicationRepository(owner),scope=publicationScope(owner),server=mockServer(),p=payload('restart',600),digest=await publicationDigest(p),id='00000000-0000-4000-8000-000000000099';
  await repository.enqueue([{job:{id,scope,digest,title:'restart',localSetId:'restart',state:'publishing',phase:'uploading',uploaded:0,total:600,createdAt:new Date().toISOString()},payload:p}]);
  await server.rpc('quiz_publish_begin',{p_job_id:id,p_total:600,p_set:p.p_set});await server.rpc('quiz_publish_part',{p_job_id:id,p_start:0,p_questions:p.p_questions.slice(0,250)});
  const queue=new PublicationQueue({repository,scope,rpc:server.rpc,apply:async()=>{}});await queue.restore();await queue.run();assert.equal(queue.jobs[0].state,'completed');assert.equal(server.counts.parts,3);assert.equal(server.counts.commits,1);
  assert.equal((await publicationRepository({...identity,userId:'another'}).list()).length,0);await assert.rejects(publicationRepository({...identity,userId:'another'}).payload(id));
});
test('publication completed before local-save failure stays complete and can reapply without republishing',async()=>{
  const owner={...identity,userId:'local-failure'},repository=publicationRepository(owner),scope=publicationScope(owner),server=mockServer();let fail=true;
  const queue=new PublicationQueue({repository,scope,rpc:server.rpc,apply:async()=>{if(fail)throw new Error('storage denial');}});const [id]=await queue.enqueue([{payload:payload('local-failure',4)}]);await queue.run();assert.equal(queue.jobs[0].state,'completed');assert.ok(queue.jobs[0].warning);assert.equal(queue.jobs[0].applied,false);
  fail=false;await queue.retry(id);await queue.run();assert.equal(queue.jobs[0].applied,true);assert.equal(server.counts.commits,1);
});
test('another-account/withdrawn result never authorizes local reflection',async()=>{
  const p=payload('withdrawn',4),server=mockServer();await uploadPublication(p,'op',await publicationDigest(p),server.rpc);server.jobs.get('op').is_current=false;await assert.rejects(uploadPublication(p,'op',await publicationDigest(p),server.rpc),error=>error instanceof PublicationError&&error.code==='withdrawn');
});
test('withdrawing publication cancels the in-flight job and prevents late local reflection',async()=>{
  const owner={...identity,userId:'withdraw'},repository=publicationRepository(owner),server=mockServer(),applied=[];let release,start;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{start=resolve;});
  const queue=new PublicationQueue({repository,scope:publicationScope(owner),rpc:async(name,args)=>{if(name==='quiz_publish_part'){start();await waiting;}return server.rpc(name,args);},apply:async job=>{applied.push(job.id);}});
  await queue.enqueue([{payload:payload('withdraw',4)}]);await started;await queue.cancelForSet('withdraw');release();await queue.run();assert.equal(server.counts.commits,0);assert.deepEqual(applied,[]);assert.equal(queue.jobs[0].errorCode,'cancelled');
});

test('withdrawing a folder cancels its pending jobs while independent set publications continue',async()=>{
  const owner={...identity,userId:'withdraw-folder'},repository=publicationRepository(owner),server=mockServer(),applied=[];let release,start;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{start=resolve;});
  const queue=new PublicationQueue({repository,scope:publicationScope(owner),rpc:async(name,args)=>{if(name==='quiz_publish_part'&&server.jobs.get(args.p_job_id)?.metadata.title==='folder-set'){start();await waiting;}return server.rpc(name,args);},apply:async job=>{applied.push(job.title);}});
  await queue.enqueue([{payload:payload('folder-set',4),publicFolderId:'folder'},{payload:payload('independent-set',4)}]);await started;
  await queue.cancelForFolder('folder');release();await queue.run();
  assert.deepEqual(queue.jobs.map(job=>job.state),['failed','completed']);assert.equal(queue.jobs[0].errorCode,'cancelled');assert.equal(server.counts.commits,1);assert.deepEqual(applied,['independent-set']);
});
test('a local preparation failure does not block valid folder contents',async()=>{
  const owner={...identity,userId:'prepare'},repository=publicationRepository(owner),server=mockServer();const queue=new PublicationQueue({repository,scope:publicationScope(owner),rpc:server.rpc,apply:async()=>{}});
  await queue.enqueue([{payload:payload('empty',0),preparationError:'問題がないセットは共有できません。'},{payload:payload('valid',4)}]);await queue.run();assert.deepEqual(queue.jobs.map(job=>job.state),['failed','completed']);assert.equal(server.counts.commits,1);
});

test('folder queue preserves selection order when creation timestamps fall in the same millisecond',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1791504000000});
  const owner={...identity,userId:'fifo'},repository=publicationRepository(owner),server=mockServer();const applied=[];
  const queue=new PublicationQueue({repository,scope:publicationScope(owner),rpc:server.rpc,apply:async job=>{applied.push(job.title);}});
  await queue.enqueue(['one','two','three'].map(title=>({payload:payload(title,4)})));await queue.run();
  assert.deepEqual(applied,['one','two','three']);assert.equal(new Set(queue.jobs.map(job=>job.createdAt)).size,3);
});

test('a job queued while the preceding batch is finishing starts without reopening the screen',async()=>{
  const owner={...identity,userId:'finish-race'},base=publicationRepository(owner),server=mockServer(),applied=[];let queue,release,notify,blocked=false;
  const finishing=new Promise(resolve=>{notify=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  const repository={...base,list:async()=>{if(queue&&!queue.running&&server.counts.commits===1&&!blocked){blocked=true;notify();await barrier;}return base.list();}};
  queue=new PublicationQueue({repository,scope:publicationScope(owner),rpc:server.rpc,apply:async job=>{applied.push(job.title);}});
  await queue.enqueue([{payload:payload('first',4)}]);const preceding=queue.run();await finishing;
  await queue.enqueue([{payload:payload('second',4)}]);release();await preceding;await queue.run();
  assert.deepEqual(applied,['first','second']);assert.deepEqual(queue.jobs.map(job=>job.state),['completed','completed']);
});
