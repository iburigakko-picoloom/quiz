// Synthetic legacy account, real App/import gates and PostgreSQL protocol.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import {createRecordProtocolDatabase} from '../helpers/record-protocol-db.mjs';
import {normalizeAppData} from '../../src/utils/appDataValidation.ts';

const project='https://bootstrap-fixture.invalid',owner='11111111-1111-4111-8111-111111111111',syncId='e'.repeat(36),stamp='2026-10-16T00:00:00Z';
const connection={project,userId:owner,syncId},count=Number(process.env.FIXTURE_ANSWER_COUNT??1000),oldGate=process.env.FIXTURE_OLD_WAIT_GATE==='true';
process.env.VITE_SUPABASE_URL=project;process.env.VITE_SUPABASE_ANON_KEY='synthetic-public-key';process.env.VITE_DELTA_SYNC_ENABLED='true';
const data=normalizeAppData({version:1,folders:[{id:'f',name:'Legacy cloud folder',createdAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Legacy set',source:'',createdAt:stamp}],questions:[{id:'q',setId:'s',question:'Synthetic question',choices:['a','b','c','d'],answerIndex:0,explanation:'',createdAt:stamp}],progress:[],answerLogs:Array.from({length:count},(_,i)=>({id:'answer-'+String(i).padStart(6,'0'),questionId:'q',setId:'s',folderId:'f',selectedIndex:0,isCorrect:true,answeredAt:stamp}))}).data;
const pg=await createRecordProtocolDatabase();
await pg.exec(await readFile(new URL('../../supabase/migrations/20261005154212_quiz_whole_commit.sql',import.meta.url),'utf8'));
await pg.exec(await readFile(new URL('../../supabase/migrations/20261015232702_quiz_delta_sync.sql',import.meta.url),'utf8'));
await pg.query('insert into public.quiz_sync_data(sync_id,data,updated_at,creator_hash) values($1,$2,$3,private.quiz_sync_actor_hash())',[syncId,JSON.stringify({version:1,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data)},indexedDbNotes:{}}),stamp]);
await pg.query('select public.quiz_sync_v2_open($1,$2)',[syncId,stamp]);
const requests=[],errors=[];
const user={id:owner,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',is_anonymous:false,user_metadata:{},app_metadata:{},created_at:stamp};
const fixtureApi={name:'bootstrap-api',configureServer(server){server.middlewares.use('/fixture-api',async(req,res)=>{
  try{
    const path=new URL(req.url,'http://fixture.invalid').pathname;let raw='';for await(const part of req)raw+=part;let result=[];
    if(path==='/auth/v1/user')result=user;
    else if(path.endsWith('/quiz_sync_resolve_account'))result={code:'ok',created:false,syncId};
    else if(path.endsWith('/quiz_delta_sync')){
      const args=JSON.parse(raw);requests.push(args.p_action);
      result=(await pg.query('select public.quiz_delta_sync($1,$2,$3) result',[syncId,args.p_action,JSON.stringify(args.p_request)])).rows[0].result;
    }else if(path.includes('/rpc/'))throw Error('Unexpected RPC '+path);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
});}};
const server=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true,watch:{ignored:['**/tmp/**']}},plugins:[fixtureApi,...(oldGate?[{name:'previous-import-gate',enforce:'pre',transform(code,id){if(id.endsWith('/src/App.tsx'))return code.replace('isSyncDisplaySafe(screen.name) && !guideReturn','isSyncDisplaySafe(screen.name) && !guideReturn && !waitingWorker').replace('storageReady && !guideReturn','storageReady && !guideReturn && !waitingWorker');}}]:[])]});
await server.listen();
const {webkit}=await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE,'index.mjs')).href),browser=await webkit.launch({headless:true}),output=`tmp/delta-bootstrap-${Date.now()}`;
const token=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:owner,iss:project+'/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
const page=await browser.newPage({viewport:{width:1024,height:768}});
async function waitForState(predicate,timeout=count<100?30000:600000){const end=Date.now()+timeout;let logged=0;while(Date.now()<end){let timer;try{if(await Promise.race([page.evaluate(predicate),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('IndexedDB state read timed out')),120000);})]))return;}finally{clearTimeout(timer);}if(requests.length&&Date.now()-logged>10000){logged=Date.now();console.log('fixture progress: '+JSON.stringify({requests:requests.length,checkpointPages:requests.filter(x=>x==='checkpoint').length,last:await page.evaluate(()=>window.bootstrapProgress?.slice(-1)[0])}));}await new Promise(r=>setTimeout(r,500));}throw Error('Timed out waiting for persisted migration state');}
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'||m.text().startsWith('fixture timing'))console.log('browser: '+m.text());});
try{
  await page.addInitScript(({user,token,project})=>{
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(names,mode,options){const started=performance.now(),tx=transaction.call(this,names,mode,options);if(Array.from(typeof names==='string'?[names]:names).includes('deltaStage'))tx.addEventListener('complete',()=>console.log('fixture timing stage '+mode+' '+Math.round(performance.now()-started)));return tx;};
    localStorage.setItem('sb-bootstrap-fixture-auth-token',JSON.stringify({user,access_token:token,refresh_token:'synthetic',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer'}));
    // Real HTTP to the local fixture avoids WebKit interception overhead on
    // hundreds of RPCs. Application authentication/ownership guards still run.
    const nativeFetch=window.fetch.bind(window);let announced=false;
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
      if(url.origin!==project)return nativeFetch(input,init);
      const started=performance.now(),response=await nativeFetch('/fixture-api'+url.pathname+url.search,init);
      if(url.pathname.endsWith('/quiz_delta_sync'))console.log('fixture timing fetch '+JSON.parse(init?.body??'{}').p_action+' '+Math.round(performance.now()-started));
      if(!announced&&url.pathname.endsWith('/quiz_delta_sync')&&JSON.parse(init?.body??'{}').p_action==='checkpoint'){
        announced=true;window.dispatchEvent(new CustomEvent('quiz-make-sw-update',{detail:{worker:{state:'installed',postMessage(){}}}}));
      }
      return response;
    };
  },{user,token,project});
  await page.route('https://**/*',route=>route.abort());
  await page.route('**/bootstrap-empty.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('http://127.0.0.1:5197/quiz/bootstrap-empty.html');
  console.log('fixture: preparing legacy local account');
  await page.evaluate(async({connection,data})=>{
    const {activateAccountStorage,accountLocalStorage,AccountStorageSession,accountNamespace}=await import('/quiz/src/utils/accountStorage.ts');
    const identity={project:connection.project,userId:connection.userId};
    activateAccountStorage(new AccountStorageSession(localStorage,{identity,namespace:accountNamespace(identity),legacyUnclaimed:false}));
    accountLocalStorage.setItem('quiz-make-welcome-v1','done');accountLocalStorage.setItem('quizMake:sync:id',connection.syncId);accountLocalStorage.setItem('quizMake:sync:recordV2OptIn',connection.syncId);
    const storage=await import('/quiz/src/storage.ts');
    if(!await storage.saveAppDataAsync({...data,answerLogs:[],folders:data.folders.map(f=>({...f,name:'Unconfirmed local original'}))}))throw Error('seed failed');
    await(await import('/quiz/src/utils/recordSyncOutbox.ts')).bindRecordSyncConnection(await storage.openAppDb(),connection);
    (await import('/quiz/src/utils/accountSync.ts')).writeAccountSyncMarker({project:connection.project,userId:connection.userId},connection.syncId);
  },{connection,data:{...data,answerLogs:[]}});
  console.log('fixture: local account saved '+await page.evaluate(async()=>{const s=await import('/quiz/src/storage.ts');return JSON.stringify({db:(await s.openAppDb()).name,folders:(await s.loadAppDataAsync()).folders.length});}));
  await page.goto('http://127.0.0.1:5197/quiz/');
  console.log('fixture: app loaded');
  // Do not open storage before AccountStorageGate establishes the owner: that
  // would cache the unscoped DB in the test itself before App is mounted.
  await waitForState(async()=>Boolean((await import('/quiz/src/utils/accountStorage.ts')).getAccountStorageSession()));
  await page.evaluate(async connection=>{
    const status=await import('/quiz/src/utils/syncAttemptStatus.ts');window.bootstrapProgress=[];
    window.addEventListener(status.SYNC_ATTEMPT_EVENT,()=>{const current=status.readSyncAttemptStatus(connection);if(current)window.bootstrapProgress.push({phase:current.phase,step:current.step,percent:current.overallPercent,label:current.progress?.label,received:current.progress?.completed});});
  },connection);
  console.log('fixture: app state '+await page.evaluate(async()=>{const s=await import('/quiz/src/storage.ts');return JSON.stringify({db:(await s.openAppDb()).name,folders:(await s.loadAppDataAsync()).folders.length,account:(await import('/quiz/src/utils/accountSync.ts')).getAccountSyncState()});}));
  if(oldGate){
    await waitForState(async()=>{const db=await(await import('/quiz/src/storage.ts')).openAppDb();return (await(await import('/quiz/src/utils/blobVault.ts')).readMeta(db,'deltaCheckpoint'))?.complete;});
    await page.waitForTimeout(5500);
    assert.equal(await page.evaluate(async()=>{const db=await(await import('/quiz/src/storage.ts')).openAppDb();return Boolean(await(await import('/quiz/src/utils/blobVault.ts')).readMeta(db,'deltaCursor'));}),false);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('quiz-make-sw-update',{detail:{worker:null}})));
  }
  await waitForState(async()=>{const db=await(await import('/quiz/src/storage.ts')).openAppDb();return Boolean(await(await import('/quiz/src/utils/blobVault.ts')).readMeta(db,'deltaEnabled'));});
  const result=await page.evaluate(async()=>{
    const storage=await import('/quiz/src/storage.ts'),vault=await import('/quiz/src/utils/blobVault.ts'),db=await storage.openAppDb(),data=await storage.loadAppDataAsync();
    const tx=db.transaction('appRecordConflicts'),candidates=await vault.idbResult(tx.objectStore('appRecordConflicts').getAll());
    return {answers:data.answerLogs.length,folder:data.folders[0].name,rescue:candidates.some(c=>c.local?.raw?.includes('Unconfirmed local original')),checkpoint:await vault.readMeta(db,'deltaCheckpoint'),progress:window.bootstrapProgress};
  });
  assert.equal(result.answers,count);assert.equal(result.folder,'Legacy cloud folder');assert.equal(result.rescue,true);assert.equal(result.checkpoint,undefined);assert.deepEqual(errors,[]);
  assert.ok(result.progress.some(p=>p.percent>0&&p.percent<100));
  const enabled=(await pg.query('select delta_enabled from private.quiz_sync_heads where sync_id=$1',[syncId])).rows[0].delta_enabled;assert.equal(enabled,true);
  await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/home.png`,fullPage:true});
  await writeFile(`${output}/verified.json`,JSON.stringify({engine:'webkit',oldGate,count,...result,requests,errors},null,2));
  console.log(JSON.stringify({output,oldGate,count,answers:result.answers,rescue:result.rescue,requests:requests.length,checkpointRequests:requests.filter(x=>x==='checkpoint').length,errors}));
}catch(error){console.error((await page.locator('body').innerText()).slice(-7000));console.error(JSON.stringify({requests:requests.slice(-10),errors,state:await page.evaluate(async()=>({progress:window.bootstrapProgress?.slice(-10),identity:(await import('/quiz/src/utils/cloudService.ts')).getCachedCloudAccountIdentity(),namespace:(await import('/quiz/src/utils/accountStorage.ts')).getAccountStorageSession()?.namespace,settings:(await import('/quiz/src/utils/syncService.ts')).getAutoSyncSettings(),databases:await indexedDB.databases()}))}));throw error;}
finally{await browser.close();await server.close();await pg.close();}
