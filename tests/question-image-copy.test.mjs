import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';
globalThis.indexedDB=new IDBFactory();
const values=new Map();
globalThis.localStorage={get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
globalThis.window={dispatchEvent(){}};
const storage=await import('../src/storage.ts');
const images=await import('../src/utils/questionImageRecords.ts');
const localImages=await import('../src/utils/localQuestionImages.ts');
const records=await import('../src/utils/appRecordStorage.ts');
const stamp='2026-10-05T00:00:00Z';
const question={id:'source-q',setId:'s',question:'Q',choices:['a','b','c','d'],answerIndex:0,answerText:'a',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,questionImageIds:['source-image'],detailedAnswer:{body:'note',imageIds:['source-image'],updatedAt:stamp}};
const base={version:1,folders:[{id:'f',name:'F',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'S',source:'',createdAt:stamp,updatedAt:stamp}],questions:[question],progress:[],answerLogs:[]};
assert.equal(await storage.saveAppDataAsync(base),true);
const blob=new Blob([Uint8Array.from([137,80,78,71,11,22,33])],{type:'image/png'});
await images.saveQuestionImage({id:'source-image',questionId:question.id,name:'source.png',type:blob.type,blob,addedAt:stamp});
const db=await storage.openAppDb();after(()=>db.close());
async function get(store,key){const tx=db.transaction(store),req=tx.objectStore(store).get(key);await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});return req.result;}
const copied=async id=>images.prepareCopiedQuestionImages([{sourceId:question.id,question:{...question,id}}]);
const withCopy=async prepared=>({...await storage.loadAppDataAsync(),questions:[...(await storage.loadAppDataAsync()).questions,...prepared.questions]});
test('copy commits new question, independent Blob ID and image Outbox together; reload retains identical bytes',async()=>{
  const prepared=await copied('copy-q');
  const id=prepared.images[0].image.id;
  assert.notEqual(id,'source-image');assert.equal(prepared.questions[0].questionImageIds[0],id);assert.equal(prepared.questions[0].detailedAnswer.imageIds[0],id);
  assert.equal(await storage.saveAppDataAsync(await withCopy(prepared),{questionImages:prepared.images}),true);
  assert.equal((await storage.loadAppDataAsync()).questions.find(q=>q.id==='copy-q').detailedAnswer.imageIds[0],id);
  assert.deepEqual(Buffer.from(await (await images.readQuestionImages('copy-q',[id]))[0].blob.arrayBuffer()),Buffer.from(await blob.arrayBuffer()));
  assert.equal(JSON.parse((await get('appRecords',records.appRecordKey('questionImages',id))).raw).questionId,'copy-q');
  assert.ok((await records.readAppOutbox(db)).some(op=>op.collection==='questionImages'&&op.id===id&&op.raw));
  await localImages.deleteLocalQuestionImage('copy-q',id);
  assert.equal((await images.readQuestionImages(question.id,['source-image'])).length,1);
  assert.equal((await get('appRecords',records.appRecordKey('questionImages','source-image'))).raw===null,false);
});
test('wrong question cannot delete source image or retarget its image ID',async()=>{
  await localImages.deleteLocalQuestionImage('another-question','source-image');
  await assert.rejects(images.saveQuestionImage({id:'source-image',questionId:'another-question',name:'bad.png',type:blob.type,blob,addedAt:stamp}));
  assert.equal((await images.readQuestionImages(question.id,['source-image'])).length,1);
  assert.equal(JSON.parse((await get('appRecords',records.appRecordKey('questionImages','source-image'))).raw).questionId,question.id);
});
test('quota during copied Blob write aborts question, descriptors and Outbox; native fallback cannot claim success',async()=>{
  const prepared=await copied('quota-copy'),next=await withCopy(prepared);
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){if(this.name==='questionImageBlobs'&&value.questionId==='quota-copy')throw new DOMException('synthetic quota','QuotaExceededError');return put.call(this,value,...args);};
  try{assert.equal(await storage.saveAppDataAsync(next,{questionImages:prepared.images}),false);}finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await storage.loadAppDataAsync()).questions.some(q=>q.id==='quota-copy'),false);
  for(const {image} of prepared.images){assert.equal(await get('questionImageBlobs',image.id),undefined);assert.equal(await get('appRecords',records.appRecordKey('questionImages',image.id)),undefined);}
  assert.equal((await images.readQuestionImages(question.id,['source-image'])).length,1);
});
test('missing or wrong-owner source refuses preparation without recording a copy',async()=>{
  await assert.rejects(images.prepareCopiedQuestionImages([{sourceId:'not-the-owner',question:{...question,id:'bad-copy'}}]),/画像/);
  await assert.rejects(images.prepareCopiedQuestionImages([{sourceId:question.id,question:{...question,id:'missing-copy',questionImageIds:['missing'],detailedAnswer:undefined}}]),/画像/);
  assert.equal((await storage.loadAppDataAsync()).questions.some(q=>q.id==='bad-copy'||q.id==='missing-copy'),false);
});
test('source change after preparation aborts copy and does not fall back; deleting source never deletes independent copy',async()=>{
  const independent=await copied('independent-copy');assert.equal(await storage.saveAppDataAsync(await withCopy(independent),{questionImages:independent.images}),true);
  const stale=await copied('stale-copy'),next=await withCopy(stale);
  await localImages.deleteLocalQuestionImage(question.id,'source-image');
  assert.equal(await storage.saveAppDataAsync(next,{questionImages:stale.images}),false);
  assert.equal((await storage.loadAppDataAsync()).questions.some(q=>q.id==='stale-copy'),false);
  assert.equal((await images.readQuestionImages('independent-copy',[independent.images[0].image.id])).length,1);
});
