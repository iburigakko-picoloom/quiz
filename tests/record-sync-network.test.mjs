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
  for(const [status,code] of [[400,'invalid_request'],[413,'payload_too_large'],[401,'authentication_required'],[403,'permission_denied'],[429,'rate_limited'],[404,'unavailable'],[500,'network']]) {
    await assert.rejects(createRecordSyncRpc(options({fetch:async()=>new Response('private server details',{status})})).push([]),error=>error.code===code&&!error.message.includes('private server details'));
  }
  await assert.rejects(createRecordSyncRpc(options({timeoutMs:5,fetch:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))})).push([]),/aborted/);
});
test('RPC token expiry retries once with a verified rotated token and preserves exact frozen operation bytes',async()=>{
  let calls=0;const seen=[];const ops=[{operationId:'frozen-operation',raw:'fixture'}];const rpc=createRecordSyncRpc(options({access:async()=>{calls++;if(calls===2)ops[0].raw='changed-during-token-refresh';return{userId:'owner',accessToken:calls===1?'old':'new'}},fetch:async(_url,init)=>{seen.push(init);return seen.length===1?new Response('',{status:401}):Response.json({code:'ok'})}}));
  assert.equal((await rpc.push(ops)).code,'ok');assert.equal(seen.length,2);assert.equal(seen[0].body,seen[1].body);assert.equal(seen[0].headers.Authorization,'Bearer old');assert.equal(seen[1].headers.Authorization,'Bearer new');
});
test('server statement timeout has a short safe cause and retries the same whole commit UUID',async()=>{
  const sent=[],body={p_operation_id:'11111111-1111-4111-8111-111111111111'};
  const rpc=createRecordSyncRpc(options({fetch:async(_url,init)=>{
    sent.push(init.body);
    return sent.length===1?Response.json({code:'57014',message:'private query with secret answer',details:'private-id'},{status:500}):Response.json({code:'ok',revision:9});
  }}));
  await assert.rejects(rpc.whole('finish',body),e=>e.code==='server_timeout'&&e.message==='クラウドの保存処理が時間切れになりました。');
  assert.deepEqual(await rpc.whole('finish',body),{code:'ok',revision:9});
  assert.equal(sent[0],sent[1]);
});
test('permission errors do not refresh/retry and an account change after 401 never transmits new-account credentials',async()=>{
  let calls=0,sends=0;const deny=createRecordSyncRpc(options({access:async()=>{calls++;return{userId:'owner',accessToken:'current'}},fetch:async()=>{sends++;return new Response('',{status:403})}}));await assert.rejects(deny.pull(0),e=>e.code==='permission_denied');assert.equal(calls,1);assert.equal(sends,1);
  calls=0;sends=0;const changed=createRecordSyncRpc(options({access:async()=>({userId:++calls===1?'owner':'B',accessToken:'fixture'}),fetch:async()=>{sends++;return new Response('',{status:401})}}));await assert.rejects(changed.push([]),/アカウント/);assert.equal(sends,1);
});
