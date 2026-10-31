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
 const moved=await store.move('page1',rows[0].id,.75,.85);
 assert.equal(moved.x,.75);assert.equal(moved.y,.85);assert.equal(await moved.image.text(),'fixture-image');
 assert.deepEqual((await store.load('page1')).map(row=>[row.number,row.x,row.y]),[[1,.75,.85],[2,.4,.5]]);
 await assert.rejects(store.move('page2',rows[0].id,.1,.1));
 await assert.rejects(store.move('page1','missing',.1,.1));
 await assert.rejects(store.move('page1',rows[0].id,1.1,.1));
 assert.equal((await store.load('page1'))[0].x,.75);
 assert.equal((await store.load('page1')).length,2);
 assert.deepEqual((await indexedDB.databases()).map(d=>d.name),['quizmake-device-image-references-v1:legacy']);
});

test('image ink persists independently without replacing the original image or other references', async () => {
 const store=localImageReferenceStore();
 const original=new Blob(['original'],{type:'image/png'});
 const first=await store.add('ink-page',original,.2,.3);
 const second=await store.add('ink-page',original,.4,.5);
 await store.saveInk(first.id,new Blob(['stroke-one'],{type:'image/png'}));
 await store.saveInk(first.id,new Blob(['stroke-two'],{type:'image/png'}));
 const rows=await localImageReferenceStore().load('ink-page');
 assert.equal(await rows[0].ink.text(),'stroke-two');
 assert.equal(await rows[0].image.text(),'original');
 assert.equal(rows[0].x,.2);
 assert.equal(rows[1].id,second.id);
 assert.equal(rows[1].ink,undefined);
 await assert.rejects(store.saveInk('missing-reference',original));
});


test('an account change fences a pending store and isolates the next owner',async()=>{
 const old=localImageReferenceStore();
 const session=new AccountStorageSession({getItem:()=>null},{identity:null,namespace:'guest',legacyUnclaimed:false});
 activateAccountStorage(session);
 await assert.rejects(old.load('page1'),/アカウント/);
 await assert.rejects(old.move('page1','old',.1,.1),/アカウント/);
 const next=localImageReferenceStore();assert.deepEqual(await next.load('page1'),[]);
 session.invalidate();await assert.rejects(next.add('page1',new Blob(['x'],{type:'image/png'}),.1,.1));
});
