import assert from 'node:assert/strict';
import {test} from 'node:test';
import {restoreSelectedPublications} from '../src/utils/publicRepublish.ts';

const deletedAt='2026-10-11T00:00:00Z';
const folder={id:'public-folder',localFolderId:'local-folder',ownerId:'owner',deletedAt};
const set={id:'public-set',localSetId:'local-set',ownerId:'owner',deletedAt};
test('explicit folder publication restores only selected owner content before publication',async()=>{
  const calls=[];
  const library={folders:[folder,{...folder,id:'unrelated-folder',localFolderId:'other'}],sets:[set,{...set,id:'unrelated-set',localSetId:'other'},{...set,id:'foreign-set',ownerId:'other'}]};
  await restoreSelectedPublications('owner',library,{folderId:'local-folder',sets:[{id:'local-set'}]},async(...args)=>calls.push(args));
  assert.deepEqual(calls,[['restore','public-folder',{expected_deleted_at:deletedAt}],['restore_set','public-set',{expected_deleted_at:deletedAt}]]);
  assert.equal(folder.deletedAt,deletedAt);
});
test('normal publications require no restore; cloud identity also matches a selected owner set',async()=>{
  const calls=[];
  await restoreSelectedPublications('owner',{folders:[{...folder,deletedAt:undefined}],sets:[{...set,deletedAt:undefined}]},{folderId:'local-folder',sets:[{id:'local-set'}]},async(...args)=>calls.push(args));
  assert.deepEqual(calls,[]);
  await restoreSelectedPublications('owner',{folders:[],sets:[set]},{sets:[{id:'new-local-id',cloudSetId:'public-set'}]},async(...args)=>calls.push(args));
  assert.deepEqual(calls,[['restore_set','public-set',{expected_deleted_at:deletedAt}]]);
});
test('restore conflicts stop the publication preparation without automatic retries',async()=>{
  const calls=[];
  await assert.rejects(restoreSelectedPublications('owner',{folders:[folder],sets:[set]},{folderId:'local-folder',sets:[{id:'local-set'}]},async(...args)=>{calls.push(args);throw Error('publication changed');}),/publication changed/);
  assert.equal(calls.length,1);
});
