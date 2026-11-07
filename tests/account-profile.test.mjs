import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAccountProfile } from '../src/utils/accountProfile.ts';
const provider='custom:line';
const user={id:'user',email:'mail@example.test',identities:[{provider,identity_data:{name:'LINE 名前',picture:'https://example.test/photo'}}]};
test('saved name always wins while LINE picture and name remain available without changing settings',()=>{
 const before=JSON.stringify(user);const p=resolveAccountProfile(user,' 設定した名前 ',provider);
 assert.equal(p.displayName,'設定した名前');assert.equal(p.lineName,'LINE 名前');assert.equal(p.source,'saved');assert.equal(p.avatarUrl,'https://example.test/photo');assert.equal(JSON.stringify(user),before);
});
test('LINE then email then default fallback, no other provider or unsafe avatar',()=>{
 assert.equal(resolveAccountProfile(user,null,provider).displayName,'LINE 名前');
 assert.equal(resolveAccountProfile(user,null,'custom:other').displayName,'mail');
 assert.equal(resolveAccountProfile({id:'empty'},undefined,provider).displayName,'Quiz Make ユーザー');
 const p=resolveAccountProfile({...user,identities:[{provider,identity_data:{name:123,picture:'javascript:alert(1)'}}]},'',provider);
 assert.equal(p.displayName,'mail');assert.equal(p.avatarUrl,null);
});
test('provider mappings and database name limit are shared by every account view',()=>{
 const p=resolveAccountProfile({...user,identities:[{provider,identity_data:{full_name:'a'.repeat(80)}}]},null,provider);
 assert.equal(p.displayName.length,40);assert.equal(p.userId,'user');assert.equal(p.source,'line');
 assert.equal(resolveAccountProfile(user,'Quiz Make ユーザー',provider).displayName,'Quiz Make ユーザー');
});

test('Unicode display names retain complete characters within the database character limit',()=>{const value='🐶'.repeat(40);assert.equal(resolveAccountProfile(user,value,provider).displayName,value);});
