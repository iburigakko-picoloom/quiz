import {createClient} from '@supabase/supabase-js';
import {verifiedCloudAccess,cloudAccessFailureCode} from '../../src/utils/cloudAuthAccess.ts';
const session={user:{id:'A',is_anonymous:false},access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:1};
const asynchronousErrors=[];
// The SDK rejects its internal refresh deferred as well as the public call.
// Observe this known quota rejection only in an isolated test process.
process.on('unhandledRejection',error=>{asynchronousErrors.push(error?.name);if(error?.name!=='QuotaExceededError')process.exitCode=1;});
let requests=0,removals=0;
const client=createClient('https://capacity-fixture.example.test','fixture',{auth:{autoRefreshToken:false,detectSessionInUrl:false,persistSession:true,storageKey:'fixture-auth',storage:{getItem:key=>key==='fixture-auth'?JSON.stringify(session):null,setItem(){throw new DOMException('fixture quota','QuotaExceededError')},removeItem(){removals++}}},global:{fetch:async()=>{requests++;return new Response(JSON.stringify({...session,access_token:'renewed-fixture-token',token_type:'bearer',expires_in:3600,expires_at:9999999999}),{status:200,headers:{'Content-Type':'application/json'}})}}});
await client.auth.initialize();const failed=await verifiedCloudAccess(client.auth,()=>{},()=> 'A');await client.auth.stopAutoRefresh();await new Promise(resolve=>setTimeout(resolve,30));
console.log(JSON.stringify({cause:failed.cause,code:cloudAccessFailureCode(failed.reason,failed.cause),returnedToken:failed.ok,requests,removals,asynchronousErrors}));
