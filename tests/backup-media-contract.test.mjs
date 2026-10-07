import assert from 'node:assert/strict';
import test from 'node:test';
const {validateSyncPayload,validateHydratedSyncPayload,MAX_SYNC_PAYLOAD_BYTES}=await import('../src/utils/syncService.ts');
const stamp='2026-10-05T00:00:00Z';
const payload=(bytes)=>({version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify({version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]})},indexedDbNotes:{'quizMake:notes:s:__material_pdf_pdf':JSON.stringify({kind:'quiz-material-file',version:1,materialId:'pdf',updatedAt:stamp,dataUrl:'data:application/pdf;base64,'+Buffer.alloc(bytes,7).toString('base64')})}});
test('a 25 MiB PDF exported under existing media contract passes file restore despite base64 JSON exceeding 32 MiB',async()=>{
  const original=payload(25*1024*1024);
  assert.equal(validateSyncPayload(original).ok,true);
  const raw=JSON.stringify(original);assert.ok(Buffer.byteLength(raw)>MAX_SYNC_PAYLOAD_BYTES);
  const restored=await validateHydratedSyncPayload(JSON.parse(raw));assert.equal(restored.ok,true);assert.deepEqual(restored.value,original);
  assert.equal((await validateHydratedSyncPayload(original,{wire:true})).ok,false);
});
test('backup media contract still rejects a PDF beyond 50 MiB and ordinary metadata beyond 32 MiB',async()=>{
  // Length alone proves this is oversized; no large byte buffer is allocated.
  const invalid=payload(1);const file=JSON.parse(invalid.indexedDbNotes['quizMake:notes:s:__material_pdf_pdf']);file.dataUrl='data:application/pdf;base64,'+'A'.repeat(4*Math.ceil((50*1024*1024+3)/3));invalid.indexedDbNotes['quizMake:notes:s:__material_pdf_pdf']=JSON.stringify(file);
  assert.equal((await validateHydratedSyncPayload(invalid)).ok,false);
  const metadata=payload(1);metadata.localStorage['quizMake:creation:test']='x'.repeat(MAX_SYNC_PAYLOAD_BYTES);
  assert.equal((await validateHydratedSyncPayload(metadata)).ok,false);
});
test('versioned complete recovery covers the existing 128 MiB record capacity while Snapshot wire remains 32 MiB',async()=>{
  const large=payload(1);large.indexedDbNotes['quizMake:notes:s:category']=JSON.stringify({dataUrl:'x'.repeat(40*1024*1024),updatedAt:stamp});
  assert.equal((await validateHydratedSyncPayload(large,{recordRecovery:true})).ok,true);
  assert.equal((await validateHydratedSyncPayload(large)).code,'payload_too_large');
  assert.equal((await validateHydratedSyncPayload(large,{recordRecovery:true,wire:true})).code,'payload_too_large');
});
