import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {PDFDocument} from 'pdf-lib';
import {MaterialsPanel} from '../../src/components/MaterialsPanel';
import {MaterialsDrawer} from '../../src/components/MaterialsDrawer';
import {loadMaterials,saveMaterials,storeMaterialPdf} from '../../src/utils/materialStorage';
import '../../src/index.css';import '../../src/ui-spec.css';
function SplitPreview(){
 const [open,setOpen]=useState(true),[clicks,setClicks]=useState(0);
 return <div className="quiz-runner"><main><button type="button" style={{position:'fixed',left:20,bottom:20}} onClick={()=>setClicks(value=>value+1)}>問題の操作 {clicks}</button></main>
  <MaterialsDrawer problemSetId="image-fixture" setIds={['image-fixture']} questionId="question" open={open} onOpenChange={setOpen}/></div>;
}
if(import.meta.env.VITE_SUPABASE_URL==='https://image-references.example.test'){
 const index=await loadMaterials('image-fixture');
 if(!index.materials.length){const doc=await PDFDocument.create();const pdfPage=doc.addPage([200,280]);pdfPage.drawText('PDF clarity test 0123456789',{x:12,y:240,size:8});pdfPage.drawText('Small vector text',{x:12,y:225,size:5});pdfPage.drawText('Vector text',{x:75,y:140,size:8});doc.addPage([200,280]);
 const material=await storeMaterialPdf('image-fixture',new File([await doc.save()], '資料.pdf',{type:'application/pdf'}),2);
 await saveMaterials({...index,materials:[material]});}
 createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('split')?<SplitPreview/>:<div style={{height:'100dvh'}}><MaterialsPanel setId="image-fixture"/></div>);
}
