import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {AccountStorageSession,activateAccountStorage} from '../src/utils/accountStorage.ts';
import {localImageReferenceStore,referencePoint,validateReferenceImage,imageReferenceLabel} from '../src/utils/materialImageReferences.ts';
globalThis.indexedDB=new IDBFactory();
test('coordinates remain identical after page translation and scale',()=>{
 assert.deepEqual(referencePoint(60,120,{left:10,top:20,width:100,height:200}),{x:.5,y:.5});
 assert.deepEqual(referencePoint(150,270,{left:50,top:70,width:200,height:400}),{x:.5,y:.5});
 assert.throws(()=>referencePoint(1,1,{left:0,top:0,width:0,height:10}));
 assert.equal(imageReferenceLabel(1),'①');assert.equal(imageReferenceLabel(3),'③');
});
test('device-only transactions retain bytes and page identity with concurrent numbering',async()=>{
 const store=localImageReferenceStore(), image=new Blob(['fixture-image'],{type:'image/png'});
 await Promise.all([store.add('page1',image,.2,.3),store.add('page1',image,.4,.5)]);
 const rows=await localImageReferenceStore().load('page1');
 assert.deepEqual(rows.map(r=>r.number),[1,2]);assert.equal(await rows[0].image.text(),'fixture-image');assert.equal(rows[0].x,.2);
 assert.deepEqual(await store.load('page2'),[]);
 await assert.rejects(store.add('page1',image,NaN,0));
 assert.throws(()=>validateReferenceImage(new Blob(['svg'],{type:'image/svg+xml'})));
 assert.equal((await store.load('page1')).length,2);
 assert.deepEqual((await indexedDB.databases()).map(d=>d.name),['quizmake-device-image-references-v1:legacy']);
});

test('an account change fences a pending store and isolates the next owner',async()=>{
 const old=localImageReferenceStore();
 const session=new AccountStorageSession({getItem:()=>null},{identity:null,namespace:'guest',legacyUnclaimed:false});
 activateAccountStorage(session);
 await assert.rejects(old.load('page1'),/アカウント/);
 const next=localImageReferenceStore();assert.deepEqual(await next.load('page1'),[]);
 session.invalidate();await assert.rejects(next.add('page1',new Blob(['x'],{type:'image/png'}),.1,.1));
});
