import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indexedDB,IDBObjectStore} from 'fake-indexeddb';
import {parsePublishedMaterials,pdfDataUrl,pdfHash,readPublishedPdf} from '../src/utils/publicationMaterials.ts';
import {planPublicImport} from '../src/utils/publicImport.ts';
import {saveAppRecords,readAppRecords,upgradeAppRecordStores} from '../src/utils/appRecordStorage.ts';
import {assertMaterialIntegrity} from '../src/utils/syncDataIntegrity.ts';
const owner='00000000-0000-4000-8000-000000000001',time='2026-10-11T00:00:00Z';
const bytes=new TextEncoder().encode('%PDF-1.7\nSynthetic PDF\n%%EOF'),sha256=await pdfHash(bytes);
const material={id:'material-source',title:'講義.pdf',pages:[{id:'page-source',kind:'pdf',pdfPage:1},{id:'blank-source',kind:'blank'}],pdf:{path:`${owner}/${sha256}.pdf`,sha256,size:bytes.length}};
const data={version:1,folders:[{id:'target',name:'Target',createdAt:time,updatedAt:time}],problemSets:[],questions:[],progress:[],answerLogs:[]};
const set={id:'cloud',localSetId:'source',ownerId:owner,authorName:'Owner',title:'PDF set',description:'',source:'',subject:'',audience:'CBT',difficulty:'basic',creationMethod:'manual',visibility:'public',questionCount:1,addCount:0,publishedAt:time,updatedAt:time,versionId:'v1',standalonePublic:true,tags:[],materials:[material],materialFiles:{[material.id]:pdfDataUrl(bytes)},questions:[{logicalId:'q-source',contentRevision:'rev',question:'Q',choices:['A','B','C','D'],answerIndexes:[0],answerText:'A',explanation:'E',detailedExplanation:'',sourcePage:'1',category:'C',difficulty:'basic',materialReferences:[{materialId:material.id,pageId:'page-source'}]}]};
test('PDF import gives independent material/page identities and preserves exact references',()=>{
  const plan=planPublicImport(data,[set],{targetId:'target'},time),records=Object.values(plan.materialRecords).map(JSON.parse);
  const index=records.find(r=>r.kind==='quiz-material-index'),file=records.find(r=>r.kind==='quiz-material-file'),ref=plan.data.questions[0].materialReferences[0];
  assert.notEqual(index.materials[0].id,material.id);assert.notEqual(index.materials[0].pages[0].id,'page-source');
  assert.equal(ref.materialId,index.materials[0].id);assert.equal(ref.pageId,index.materials[0].pages[0].id);assert.equal(file.dataUrl,pdfDataUrl(bytes));
  assertMaterialIntegrity({localStorage:{},indexedDbNotes:plan.materialRecords},plan.data,false);
  const repeated=planPublicImport(plan.data,[set],{targetId:'target'},time);assert.equal(repeated.data.problemSets.length,1);assert.deepEqual(repeated.materialRecords,{});
});
test('missing bytes, unresolved references, foreign paths, and oversized metadata fail closed',()=>{
  assert.throws(()=>planPublicImport(data,[{...set,materialFiles:{}}],{targetId:'target'}));
  assert.throws(()=>planPublicImport(data,[{...set,questions:[{...set.questions[0],materialReferences:[{materialId:material.id,pageId:'missing'}]}]}],{targetId:'target'}));
  assert.throws(()=>parsePublishedMaterials([{...material,pdf:{...material.pdf,path:`other/${sha256}.pdf`}}],owner));
  assert.throws(()=>parsePublishedMaterials([{...material,pdf:{...material.pdf,size:50*1024*1024+1}}],owner));
});
test('chunked downloads verify size and SHA-256 before returning local PDF bytes',async()=>{
  assert.equal(await readPublishedPdf(new Response(bytes),material.pdf),pdfDataUrl(bytes));
  await assert.rejects(readPublishedPdf(new Response(new Uint8Array(bytes.length)),material.pdf),/検証/);
  await assert.rejects(readPublishedPdf(new Response(new Uint8Array(bytes.length+1)),material.pdf),/容量/);
  await assert.rejects(readPublishedPdf(new Response(bytes.slice(0,-1)),material.pdf),/検証/);
});
async function database(){return await new Promise((resolve,reject)=>{const request=indexedDB.open(crypto.randomUUID(),1);request.onupgradeneeded=()=>upgradeAppRecordStores(request.result);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
test('problem copies and PDFs commit atomically, with sync outbox descriptors',async()=>{
  const db=await database(),plan=planPublicImport(data,[set],{targetId:'target'},time);
  try{await saveAppRecords(db,plan.data,time,undefined,[],undefined,true,plan.materialRecords);assert.equal((await readAppRecords(db)).data.questions[0].materialReferences[0].materialId,plan.data.questions[0].materialReferences[0].materialId);
    const tx=db.transaction(['categoryNotes','appOutbox','appRecordMeta']);const notes=await new Promise(resolve=>{const req=tx.objectStore('categoryNotes').getAll();req.onsuccess=()=>resolve(req.result);});assert.equal(notes.length,2);
    const outbox=await new Promise(resolve=>{const req=tx.objectStore('appOutbox').getAll();req.onsuccess=()=>resolve(req.result);});assert.equal(outbox.filter(r=>r.collection==='indexedDbNotes').length,2);
  }finally{db.close();}
});
test('a PDF store failure rolls back folders, questions, and all material records',async()=>{
  const db=await database(),plan=planPublicImport(data,[set],{newFolderName:'Fresh'},time),put=IDBObjectStore.prototype.put;
  try{await saveAppRecords(db,data,time);const before=(await readAppRecords(db)).data;IDBObjectStore.prototype.put=function(value,key){if(this.name==='categoryNotes')throw new DOMException('Quota exceeded','QuotaExceededError');return put.call(this,value,key);};
    await assert.rejects(saveAppRecords(db,plan.data,time,undefined,[],undefined,true,plan.materialRecords));IDBObjectStore.prototype.put=put;
    assert.deepEqual((await readAppRecords(db)).data,before);
  }finally{IDBObjectStore.prototype.put=put;db.close();}
});

test('publication identity hashes verified PDF metadata without copying large PDF bodies into another string',async()=>{
  const {publicationDigest}=await import('../src/utils/publicationProtocol.ts');
  const payload={p_set:{materials:[material]},p_questions:[],materialFiles:{pdf:'first bytes'}};
  assert.equal(await publicationDigest(payload),await publicationDigest({...payload,materialFiles:{pdf:'other bytes'}}));
  assert.notEqual(await publicationDigest(payload),await publicationDigest({...payload,p_set:{materials:[{...material,pdf:{...material.pdf,sha256:'f'.repeat(64)}}]}}));
});
