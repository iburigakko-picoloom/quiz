import {createHash} from 'node:crypto';
export const pdfOwner='11111111-1111-4111-8111-111111111111',stamp='2026-10-08T00:00:00Z';
export async function incomingFixture({count=16,bytes=40,missingPdf=false,badRef=false,image=false}={}){
  const data={version:1,folders:[{id:'f',name:'Fixture',createdAt:stamp,updatedAt:stamp}],problemSets:[{id:'s',folderId:'f',title:'Fixture',source:'',createdAt:stamp,updatedAt:stamp}],questions:[{id:'q',setId:'s',question:'Synthetic',choices:['A','B','C','D'],answerIndex:0,answerText:'A',explanation:'',sourcePage:'',category:'',difficulty:'basic',createdAt:stamp,updatedAt:stamp,...(image?{questionImageIds:['image']}:{})}],progress:[],answerLogs:[]};
  const files=new Map(),notes={},materials=[];
  for(let i=0;i<count;i++){
    const body=new Uint8Array(bytes).fill(i+1),sha256=createHash('sha256').update(body).digest('hex'),id=`pdf-${i}`;
    files.set(sha256,body);materials.push({id,title:'Synthetic PDF',pages:[{id:`page-${i}`,kind:'pdf',pdfPage:1}]});
    notes[`quizMake:notes:s:__material_pdf_${id}`]=JSON.stringify({kind:'quiz-material-remote-file',version:1,materialId:id,updatedAt:stamp,bucket:'quiz-material-pdfs',path:`${pdfOwner}/${sha256}.pdf`,sha256,size:body.length});
  }
  if(missingPdf)materials.push({id:'missing',title:'Missing',pages:[{id:'missing-page',kind:'pdf',pdfPage:1}]});
  notes['quizMake:notes:s:__materials_v1']=JSON.stringify({kind:'quiz-material-index',version:1,problemSetId:'s',updatedAt:stamp,materials});
  if(badRef)data.questions[0].materialReferences=[{materialId:'nonexistent-private-id',pageId:'missing-page'}];
  const payload={version:1,updatedAt:stamp,localStorage:{'quiz-make-app-data-v1':JSON.stringify(data)},indexedDbNotes:notes};
  const rows=[...['folders','problemSets','questions'].flatMap(collection=>data[collection].map((row,position)=>({key:JSON.stringify([collection,row.id]),collection,id:row.id,position,revision:1,raw:JSON.stringify(row)}))),...Object.entries(notes).map(([id,raw],position)=>({key:JSON.stringify(['indexedDbNotes',id]),collection:'indexedDbNotes',id,raw,position,revision:1}))];
  let downloaded=0;
  const transport={userId:pdfOwner,cacheScope:crypto.randomUUID(),exists:async()=>true,upload:async()=>{throw Error('read-only fixture')},download:async file=>{downloaded++;return files.get(file.sha256);}};
  return {data,payload,rows,files,transport,get downloaded(){return downloaded;}};
}
