import assert from 'node:assert/strict';
import {test} from 'node:test';
import {relatedMaterialQuestions,searchMaterialDocument,normalizedMaterialText} from '../src/utils/materialSearch.ts';

test('related questions use both stable material and page IDs, including cross-set references',()=>{
 const questions=[{id:'a',materialReferences:[{materialId:'m',pageId:'p'}]},{id:'b',materialReferences:[{materialId:'other',pageId:'p'}]},{id:'c',materialReferences:[{materialId:'m',pageId:'else'}]},{id:'d',materialReferences:[{materialId:'m',pageId:'p'},{materialId:'m',pageId:'p'}]}];
 assert.deepEqual(relatedMaterialQuestions(questions,'m','p').map(q=>q.id),['a','d']);
});

test('PDF search maps reordered source pages and inserted blank pages back to stable IDs',async()=>{
 const material={id:'m',pages:[{id:'last',kind:'pdf',pdfPage:2},{id:'blank',kind:'blank'},{id:'first',kind:'pdf',pdfPage:1}]};
 const calls=[],cleaned=[];
 const document={getPage:async number=>{calls.push(number);return {getTextContent:async()=>({items:[{str:number===1?'ＡＬＰＨＡ': 'be'},{str:number===1?' test':'ta'}]}),cleanup:()=>cleaned.push(number)};}};
 const source=JSON.stringify(material);
 let result=await searchMaterialDocument(document,material,'alpha');
 assert.deepEqual(result.matches.map(m=>[m.pageId,m.pageNumber,m.pdfPage]),[['first',3,1]]);
 assert.equal(result.textPages,2);assert.equal(result.imagePages,0);assert.deepEqual(calls,[2,1]);assert.deepEqual(cleaned,[2,1]);assert.equal(JSON.stringify(material),source);
 result=await searchMaterialDocument(document,material,'beta');assert.equal(result.matches[0].pageId,'last');
 assert.equal(normalizedMaterialText('　Ａ\n B　'),'a b');
});

test('image-only and mixed PDFs distinguish missing extractable text from no matches',async()=>{
 const material={id:'m',pages:[{id:'p1',kind:'pdf',pdfPage:1},{id:'p2',kind:'pdf',pdfPage:2}]};
 const document={getPage:async n=>({getTextContent:async()=>({items:n===1?[{str:'known'}]:[]}),cleanup(){}})};
 const mixed=await searchMaterialDocument(document,material,'absent');assert.equal(mixed.matches.length,0);assert.equal(mixed.textPages,1);assert.equal(mixed.imagePages,1);
 const image=await searchMaterialDocument(document,{...material,pages:[material.pages[1]]},'absent');assert.equal(image.textPages,0);assert.equal(image.imagePages,1);
});

test('cancellation stops page traversal and cleans the current page; results are bounded',async()=>{
 const controller=new AbortController();let reads=0,cleaned=0;
 const document={getPage:async()=>({getTextContent:async()=>{reads++;controller.abort();return {items:[{str:'hit'}]};},cleanup(){cleaned++;}})};
 const material={id:'m',pages:Array.from({length:205},(_,i)=>({id:`p${i}`,kind:'pdf',pdfPage:i+1}))};
 await assert.rejects(searchMaterialDocument(document,material,'hit',controller.signal),{name:'AbortError'});assert.equal(reads,1);assert.equal(cleaned,1);
 const all=await searchMaterialDocument({getPage:async()=>({getTextContent:async()=>({items:[{str:'hit'}]}),cleanup(){}})},material,'hit');
 assert.equal(all.matches.length,200);assert.equal(all.limited,true);assert.equal(all.textPages,205);
});
