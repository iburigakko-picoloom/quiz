import assert from 'node:assert/strict';
import test from 'node:test';
import {decideWholeSync} from '../src/utils/wholeSyncDecision.ts';
const connection={project:'https://whole.invalid',userId:'owner',syncId:'1'.repeat(36)};
const baseline={version:1,connection,serverRevision:5,userGeneration:7,digest:'ancestor'};
const base={baseline,serverRevision:5,userGeneration:7,localDigest:'ancestor',remoteDigest:'ancestor'};
test('a saved common ancestor chooses one changed side and requires one whole choice when both changed',()=>{
  assert.equal(decideWholeSync({...base,userGeneration:8,localDigest:'local'}),'upload');
  assert.equal(decideWholeSync({...base,serverRevision:6,remoteDigest:'cloud'}),'download');
  assert.equal(decideWholeSync({...base,userGeneration:8,serverRevision:6,localDigest:'local',remoteDigest:'cloud'}),'conflict');
});
test('identical and reverted whole content never needs a union, per-record choice or clock winner',()=>{
  assert.equal(decideWholeSync({...base,userGeneration:80,serverRevision:60,localDigest:'same',remoteDigest:'same'}),'same');
  assert.equal(decideWholeSync({...base,userGeneration:80,serverRevision:6,remoteDigest:'cloud'}),'download');
  assert.equal(decideWholeSync({...base,userGeneration:8,serverRevision:60,localDigest:'local'}),'upload');
});
test('unknown ancestry remains protected, except a fully verified existing record cursor matching the current head',()=>{
  assert.equal(decideWholeSync({...base,baseline:undefined,localDigest:'local',remoteDigest:'cloud'}),'conflict');
  assert.equal(decideWholeSync({...base,baseline:undefined,localDigest:'local',remoteDigest:'cloud',verifiedRecordCursor:5}),'upload');
  assert.equal(decideWholeSync({...base,baseline:undefined,localDigest:'local',remoteDigest:'cloud',verifiedRecordCursor:4}),'conflict');
  assert.equal(decideWholeSync({...base,localDigest:'unwitnessed',remoteDigest:'ancestor'}),'conflict');
});


const {incrementalJsonDigest}=await import('../src/utils/incrementalJsonDigest.ts');
const {computeWholeRecordDigest,wholeHash}=await import('../src/utils/wholeSyncDigest.ts');
test('streamed JSON hashes preserve persisted digest bytes including Unicode boundaries and numeric keys',async()=>{
  const boundary='x'.repeat(16383);
  const values=[null,true,12,-0,NaN,[],{},
    {z:undefined,'10':'ten','2':'two',text:boundary+'😀'+boundary+'\ud800',control:'\n\r\t\b\f"\\',nested:[null,{a:'日本語'}]},
    {localStorage:{app:'a'.repeat(2*1024*1024)},indexedDbNotes:{},images:[]}];
  for(const value of values)assert.equal(await incrementalJsonDigest(value),await wholeHash(JSON.stringify(value)));
});
test('logical digest stays compatible with canonical legacy records and omits image transport paths',async()=>{
  const value={z:[{b:1,a:'日本語'}],'10':'ten','2':'two',a:null};
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,stable(v)])):v;
  const rows=[{key:'b',collection:'localStorage',id:'setting',position:2,raw:JSON.stringify(value)},
    {key:'a',collection:'questionImages',id:'image',position:0,raw:JSON.stringify({id:'image',path:'transport',size:1})},
    {key:'c',collection:'localStorage',id:'plain',position:3,raw:'ordinary setting'}];
  const expected=[{collection:'questionImages',id:'image',position:0,value:stable({id:'image',size:1})},
    {collection:'localStorage',id:'setting',position:2,value:stable(value)},
    {collection:'localStorage',id:'plain',position:3,value:'ordinary setting'}];
  assert.equal(await computeWholeRecordDigest(rows),await wholeHash(JSON.stringify(expected)));
});
test('large digest yields to the browser event loop before it completes',async()=>{
  let ticks=0;const timer=setInterval(()=>ticks++,0);
  try{await incrementalJsonDigest({note:'日本語😀'.repeat(1024*1024)});assert.ok(ticks>0)}finally{clearInterval(timer)}
});
