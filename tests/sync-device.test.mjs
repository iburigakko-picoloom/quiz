import assert from 'node:assert/strict';
import test from 'node:test';
import {getSyncDevice,readSyncDevice,SYNC_DEVICE_KEY} from '../src/utils/syncDevice.ts';
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}};
test('installation identity survives reloads and distinguishes two devices within the existing wire limit',()=>{
  const a=storage(),b=storage(),raw=getSyncDevice(a,'Windows');
  assert.equal(getSyncDevice(a,'Android'),raw);
  assert.equal(readSyncDevice(raw).name,'Windows');
  assert.notEqual(readSyncDevice(getSyncDevice(b,'Windows')).id,readSyncDevice(raw).id);
  assert.ok(new TextEncoder().encode(raw).length<=160);
});
test('unreadable or unverified identity is never silently replaced before an upload',()=>{
  const s=storage();s.setItem(SYNC_DEVICE_KEY,'corrupt');assert.throws(()=>getSyncDevice(s,'Windows'));
  assert.equal(s.getItem(SYNC_DEVICE_KEY),'corrupt');
  assert.throws(()=>getSyncDevice({getItem:()=>null,setItem(){}},'Windows'),error=>error.code==='local_persistence_failed');
});
test('old server device labels remain readable without inventing an identity',()=>{
  assert.deepEqual(readSyncDevice('QA Android'),{name:'QA Android'});
  assert.deepEqual(readSyncDevice(null),{name:'不明'});
});
