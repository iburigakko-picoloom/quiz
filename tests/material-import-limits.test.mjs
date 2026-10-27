import assert from 'node:assert/strict';
import test from 'node:test';
import { describeContent, contentHash, uploadContentParts, downloadContentParts, MAX_CONTENT_OBJECT_BYTES } from '../src/utils/contentParts.ts';
import { MAX_MATERIAL_PDF_BYTES, MAX_MATERIAL_PAGES, isRemoteMaterialFile } from '../src/utils/materialModel.ts';
import { createMaterialTransport } from '../src/utils/materialCloud.ts';

test('a PDF above 50 MiB survives interrupted multipart transfer without exceeding the cloud object limit',async()=>{
  const source=new Blob([new Uint8Array(32*1024*1024).fill(1),new Uint8Array(19*1024*1024).fill(2)],{type:'application/pdf'});
  const ref=await describeContent(source),objects=new Map();
  assert.equal(MAX_MATERIAL_PDF_BYTES,100*1024*1024);assert.equal(MAX_MATERIAL_PAGES,2000);
  assert.equal(ref.parts.length,2);assert.ok(ref.parts.every(p=>p.size<=MAX_CONTENT_OBJECT_BYTES));
  let sent=0;
  await assert.rejects(uploadContentParts(ref,source,async(part,blob)=>{if(++sent===2)throw Error('offline');objects.set(part.sha256,blob);}),/offline/);
  assert.equal(objects.size,1);
  await uploadContentParts(ref,source,async(part,blob)=>{if(!objects.has(part.sha256))objects.set(part.sha256,blob);});
  const restored=await downloadContentParts(ref,'application/pdf',async part=>objects.get(part.sha256));
  assert.equal(restored.size,source.size);assert.equal(await contentHash(restored),ref.sha256);
  await assert.rejects(downloadContentParts(ref,'application/pdf',async part=>new Blob([new Uint8Array(part.size)])),/ハッシュ/);
  await assert.rejects(downloadContentParts({...ref,parts:[...ref.parts].reverse()},'application/pdf',async part=>objects.get(part.sha256)),/ハッシュ/);
  await assert.rejects(downloadContentParts({...ref,parts:[ref.parts[0]]},'application/pdf',async()=>{throw Error('must not fetch');}),/分割/);
  const owner='11111111-1111-1111-1111-111111111111';
  const remote={kind:'quiz-material-remote-file',version:1,materialId:'large',updatedAt:'2026-10-22',bucket:'quiz-material-pdfs',path:`${owner}/${ref.sha256}.pdf`,...ref};
  assert.equal(isRemoteMaterialFile(remote),true);
  assert.equal(isRemoteMaterialFile({...remote,parts:undefined}),false);
  assert.equal(isRemoteMaterialFile({...remote,size:MAX_MATERIAL_PDF_BYTES+1}),false);
  const transport=createMaterialTransport({url:'https://fixture.test',anonKey:'fixture'},{userId:owner,accessToken:'fixture'}, {
    fetch:async (url,options)=>{
      assert.ok(String(url).includes(`/${owner}/`));
      const hash=String(url).split('/').at(-1).replace('.pdf',''),blob=objects.get(hash);
      return new Response(options.method==='HEAD'?null:blob,{status:blob?200:404});
    },wait:async()=>{},
  });
  assert.equal(await transport.exists(remote),true);
  assert.equal(await contentHash(new Blob([await transport.download(remote)])),ref.sha256);
  objects.delete(ref.parts[1].sha256);
  assert.equal(await transport.exists(remote),false);
  await assert.rejects(transport.download(remote),/見つかりません/);
});
