import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createViewCache} from '../src/utils/viewCache.ts';

test('list previews expire rather than being silently renewed by repeated reads',t=>{
  let now=0;t.mock.method(Date,'now',()=>now);const cache=createViewCache(60_000);
  cache.write('query',{title:'old'});now=59_999;assert.deepEqual(cache.read('query'),{title:'old'});
  now=60_000;assert.equal(cache.read('query'),undefined);
});
test('previews isolate keys, bound memory, and clear immediately on account change or mutation',()=>{
  const cache=createViewCache(60_000,2);cache.write('account-a',['private group']);
  assert.equal(cache.read('account-b'),undefined);cache.write('query-1',[]);cache.write('query-2',[]);
  assert.equal(cache.read('account-a'),undefined);assert.deepEqual(cache.read('query-1'),[]);
  cache.clear();assert.equal(cache.read('query-1'),undefined);assert.equal(cache.read('query-2'),undefined);
});
