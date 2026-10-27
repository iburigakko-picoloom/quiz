import type {MaterialReference} from '../types';
import {validMaterialRecord,type StudyMaterial} from './materialModel';
// Public versions use a separate server contract; private multipart PDFs do
// not change public access policies or the publication format.
const MAX_PUBLICATION_PDF_BYTES = 50 * 1024 * 1024;

export const PUBLICATION_MATERIAL_BUCKET='quiz-publication-pdfs';
export interface PublishedMaterial extends StudyMaterial {pdf?:{path:string;sha256:string;size:number}}
export function parsePublishedMaterials(value:unknown,ownerId:string):PublishedMaterial[] {
  if(!Array.isArray(value)||value.length>100||!validMaterialRecord({kind:'quiz-material-index',version:1,problemSetId:'publication',materials:value,updatedAt:''}))throw new Error('公開された資料情報を確認できません。');
  for(const material of value as PublishedMaterial[]){
    if(!material.id||material.id.length>200||material.title.length>500||material.pages.length>500||material.pages.some(p=>!p.id||p.id.length>200||(p.pdfPage??0)>500))throw new Error('公開された資料情報を確認できません。');
    const pdf=material.pdf;
    if(material.pages.some(p=>p.kind==='pdf')&&!pdf)throw new Error('公開されたPDF本体の参照がありません。');
    if(pdf&&(!/^[a-f0-9]{64}$/.test(pdf.sha256)||pdf.path!==`${ownerId}/${pdf.sha256}.pdf`||!Number.isSafeInteger(pdf.size)||pdf.size<1||pdf.size>MAX_PUBLICATION_PDF_BYTES))throw new Error('公開されたPDF本体の参照が不正です。');
  }
  return structuredClone(value);
}
export function assertPublishedReferences(materials:PublishedMaterial[],references:readonly MaterialReference[]) {
  const pages=new Map(materials.map(m=>[m.id,new Set(m.pages.map(p=>p.id))]));
  if(references.some(r=>!pages.get(r.materialId)?.has(r.pageId)))throw new Error('問題が参照する資料がありません。資料を確認してから公開してください。');
}
export function pdfBytes(dataUrl:string):Uint8Array<ArrayBuffer> {
  if(!/^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl))throw new Error('PDF本体を確認できません。');
  const raw=atob(dataUrl.split(',')[1]);
  if(!raw.length||raw.length>MAX_PUBLICATION_PDF_BYTES)throw new Error('公開するPDFは1ファイル50MB以下にしてください。');
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
export async function pdfHash(bytes:Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function pdfDataUrl(bytes:Uint8Array) {
  const parts:string[]=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return 'data:application/pdf;base64,'+btoa(parts.join(''));
}
/** Bound chunked responses as well as Content-Length, then verify immutable bytes. */
export async function readPublishedPdf(response:Response,pdf:NonNullable<PublishedMaterial['pdf']>):Promise<string> {
  if(!response.ok||!response.body)throw new Error('公開されたPDFを取得できません。通信と公開状態を確認してください。');
  const reader=response.body.getReader(),bytes=new Uint8Array(pdf.size);let offset=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw new Error('PDFの容量が一致しません。');bytes.set(value,offset);offset+=value.length;}}
  finally{await reader.cancel().catch(()=>{});}
  if(offset!==pdf.size||await pdfHash(bytes)!==pdf.sha256)throw new Error('PDFの内容を検証できません。もう一度取り込んでください。');
  return pdfDataUrl(bytes);
}
