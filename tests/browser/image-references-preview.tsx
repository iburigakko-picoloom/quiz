import {createRoot} from 'react-dom/client';
import {PDFDocument} from 'pdf-lib';
import {MaterialsPanel} from '../../src/components/MaterialsPanel';
import {loadMaterials,saveMaterials,storeMaterialPdf} from '../../src/utils/materialStorage';
import '../../src/index.css';import '../../src/ui-spec.css';
if(import.meta.env.VITE_SUPABASE_URL==='https://image-references.example.test'){
 const index=await loadMaterials('image-fixture');
 if(!index.materials.length){const doc=await PDFDocument.create();doc.addPage([200,280]);doc.addPage([200,280]);
 const material=await storeMaterialPdf('image-fixture',new File([await doc.save()], '資料.pdf',{type:'application/pdf'}),2);
 await saveMaterials({...index,materials:[material]});}
 createRoot(document.getElementById('root')!).render(<div style={{height:'100dvh'}}><MaterialsPanel setId="image-fixture"/></div>);
}
