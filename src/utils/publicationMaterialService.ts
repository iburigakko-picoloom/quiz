import type {CloudProblemSet} from './cloudService';
import {PublicationError} from './publicationProtocol';
import {cloudClient,getCloudAccessToken,getCloudSession,publicationIdentity} from './cloudService';
import {assertAccountStorageCurrent,assertAccountNetworkCurrent} from './accountStorage';
import type {PublicationPayload} from './publicationPayload';
import {loadMaterials,loadMaterialFile} from './materialStorage';
import {createMaterialTransport} from './materialCloud';
import {MATERIAL_BUCKET,type RemoteMaterialFile} from './materialModel';
import {getRemoteSyncConfig} from './syncService';
import {assertPublishedReferences,parsePublishedMaterials,pdfBytes,pdfHash,readPublishedPdf,PUBLICATION_MATERIAL_BUCKET,type PublishedMaterial} from './publicationMaterials';

export async function attachPublicationMaterials(payload:PublicationPayload,userId:string):Promise<PublicationPayload> {
  const identity=publicationIdentity(userId);assertAccountStorageCurrent(identity);
  const setId=String(payload.p_set.local_set_id),index=await loadMaterials(setId);
  const materials:PublishedMaterial[]=[],materialFiles:Record<string,string>={};
  const sources=new Map(index.materials.map(m=>[m.id,{setId,material:m}]));
  const references=payload.p_questions.flatMap(q=>Array.isArray(q.material_references)?q.material_references:[]) as import('../types').MaterialReference[];
  // References can point to another local set. Resolve explicitly, never guess.
  if(references.some(r=>!sources.has(r.materialId))){
    const {exportCategoryNotesRaw}=await import('./noteStorage');
    const notes=await exportCategoryNotesRaw();
    for(const raw of Object.values(notes)){let value;try{value=JSON.parse(raw);}catch{continue;}
      if(value.kind==='quiz-material-index'&&Array.isArray(value.materials))for(const material of value.materials){if(references.some(r=>r.materialId===material.id)&&!sources.has(material.id))sources.set(material.id,{setId:value.problemSetId,material});}
    }
  }
  for(const {setId:ownerSet,material} of sources.values()){
    assertAccountStorageCurrent(identity);
    const copy:PublishedMaterial=structuredClone(material);
    if(copy.pages.some(p=>p.kind==='pdf')){const dataUrl=await loadMaterialFile(ownerSet,copy.id),bytes=pdfBytes(dataUrl),sha256=await pdfHash(bytes);copy.pdf={path:`${userId}/${sha256}.pdf`,sha256,size:bytes.length};materialFiles[copy.id]=dataUrl;}
    materials.push(copy);
  }
  assertAccountStorageCurrent(identity);parsePublishedMaterials(materials,userId);assertPublishedReferences(materials,references);
  if(materials.length){
    const check=await cloudClient?.rpc('quiz_publication_material_read',{p_set_id:'00000000-0000-0000-0000-000000000000',p_version_id:'00000000-0000-0000-0000-000000000000',p_path:'',p_share_token:null});
    if(check?.error?.code!=='P0001'||check.error.message!=='not authorized')throw new Error('PDF付き公開にはサーバーの更新が必要です。資料を除いた状態では公開していません。');
  }
  return {...payload,p_set:{...payload.p_set,materials},materialFiles};
}
export async function uploadPublicationMaterials(payload:PublicationPayload,userId:string) {
  const materials=parsePublishedMaterials(payload.p_set.materials??[],userId);if(!materials.some(m=>m.pdf))return;
  const access=await getCloudAccessToken(),config=getRemoteSyncConfig();if(!access.ok||access.userId!==userId||!config)throw new Error('PDFを公開するにはログインが必要です。');
  const identity=publicationIdentity(userId),transport=createMaterialTransport(config,access,{bucket:PUBLICATION_MATERIAL_BUCKET});const sent=new Set<string>();
  for(const material of materials){const pdf=material.pdf;if(!pdf||sent.has(pdf.path))continue;assertAccountNetworkCurrent(identity);
    const raw=payload.materialFiles?.[material.id];if(!raw)throw new Error('公開するPDF本体がありません。公開をやり直してください。');
    const bytes=pdfBytes(raw);if(bytes.length!==pdf.size||await pdfHash(bytes)!==pdf.sha256)throw new Error('公開するPDFの内容が一致しません。');
    const remote:RemoteMaterialFile={kind:'quiz-material-remote-file',version:1,materialId:material.id,updatedAt:'',bucket:MATERIAL_BUCKET,path:pdf.path,sha256:pdf.sha256,size:pdf.size};
    try{if(!await transport.exists(remote))await transport.upload(remote,bytes);}catch{assertAccountNetworkCurrent(identity);throw new PublicationError('PDFを送信できません。再試行すると続きから送信します。','network',true); }sent.add(pdf.path);
  }
  assertAccountNetworkCurrent(identity);
}
export async function hydratePublishedMaterials<T extends CloudProblemSet>(sets:T[],shareToken=''):Promise<T[]> {
  const viewer=(await getCloudSession())?.user.id??'',identity=viewer?publicationIdentity(viewer):null;
  const assertCurrent=async()=>{assertAccountStorageCurrent(identity);if(((await getCloudSession())?.user.id??'')!==viewer)throw new Error('アカウントが変更されています。もう一度取り込んでください。');};
  const result:T[]=[];
  for(const set of sets){await assertCurrent();const materials=parsePublishedMaterials(set.materials??[],set.ownerId),files:Record<string,string>={};
    for(const material of materials){if(!material.pdf)continue;if(!cloudClient||!set.versionId)throw new Error('PDFの公開版を確認できません。');
      const permission=await cloudClient.rpc('quiz_publication_material_read',{p_set_id:set.id,p_version_id:set.versionId,p_path:material.pdf.path,p_share_token:shareToken||null});
      if(permission.error)throw new Error(shareToken&&!viewer?'共有リンクのPDFを取り込むにはログインしてください。':'PDFを取得できません。公開状態と通信を確認してください。');
      const {data,error}=await cloudClient.storage.from(PUBLICATION_MATERIAL_BUCKET).createSignedUrl(material.pdf.path,60);
      if(error||!data?.signedUrl)throw new Error('PDFを取得できません。公開状態と通信を確認してください。');
      const config=getRemoteSyncConfig(),url=new URL(data.signedUrl);if(!config||url.origin!==new URL(config.url).origin||!url.pathname.startsWith(`/storage/v1/object/sign/${PUBLICATION_MATERIAL_BUCKET}/`))throw new Error('PDFの取得先を確認できません。');
      files[material.id]=await readPublishedPdf(await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)}),material.pdf);await assertCurrent();
    }
    result.push({...set,materials,materialFiles:files});
  }
  return result;
}
