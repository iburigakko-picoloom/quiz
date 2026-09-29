import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordSyncRpc } from '../src/utils/recordSyncNetwork.ts';
const connection={project:'https://example.supabase.co',userId:'owner',syncId:'1'.repeat(36)};
function options(overrides={}) { return {url:connection.project,anonKey:'public-key',connection,access:async()=>({userId:'owner',accessToken:'test-token'}),assertCurrent(){},...overrides}; }
test('record network adapter revalidates account, uses RPC auth, and preserves exact operation IDs',async()=>{
  const seen=[]; let accessCalls=0;
  const rpc=createRecordSyncRpc(options({access:async()=>{accessCalls++;return {userId:'owner',accessToken:'test-token'};},fetch:async(url,init)=>{
    seen.push({url,...init});return Response.json(url.endsWith('_open')?{code:'ok',revision:1}:{code:'ok'});
  }}));
  assert.equal(await rpc.open('2026-09-29T00:00:00Z'),1);
  await rpc.pull(19);const ops=[{operationId:'same-id'}];await rpc.push(ops);await rpc.push(ops);
  assert.equal(accessCalls,4);
  assert.equal(seen[0].headers.Authorization,'Bearer test-token');
  assert.equal(seen[0].redirect,'error');
  assert.deepEqual(JSON.parse(seen[1].body),{p_sync_id:connection.syncId,p_cursor:19,p_limit:20});
  assert.equal(seen[2].body,seen[3].body);
});
test('account/project changes, invalid responses, HTTP failures and aborts never invent success',async()=>{
  assert.throws(()=>createRecordSyncRpc(options({url:'https://other.supabase.co'})),/プロジェクト/);
  await assert.rejects(createRecordSyncRpc(options({access:async()=>({userId:'other',accessToken:'token'}),fetch:()=>assert.fail('must not send')})).pull(0),/アカウント/);
  await assert.rejects(createRecordSyncRpc(options({fetch:async()=>Response.json([])})).pull(0),/応答/);
  for(const [status,code] of [[401,'authentication_required'],[403,'authentication_required'],[429,'rate_limited'],[404,'unavailable'],[500,'network']]) {
    await assert.rejects(createRecordSyncRpc(options({fetch:async()=>new Response('private server details',{status})})).push([]),error=>error.code===code&&!error.message.includes('private server details'));
  }
  await assert.rejects(createRecordSyncRpc(options({timeoutMs:5,fetch:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))})).push([]),/aborted/);
});
