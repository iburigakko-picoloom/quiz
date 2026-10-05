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
