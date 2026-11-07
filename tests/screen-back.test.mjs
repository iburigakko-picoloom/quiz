import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerScreenBack, tryScreenBack } from '../src/utils/screenBack.ts';
test('screen drill-down handles back until unmounted and stale cleanup preserves the newer handler', () => {
  assert.equal(tryScreenBack(),false);
  let first=0,second=0;
  const stopFirst=registerScreenBack(()=>first++);
  assert.equal(tryScreenBack(),true);assert.equal(first,1);
  const stopSecond=registerScreenBack(()=>second++);stopFirst();
  assert.equal(tryScreenBack(),true);assert.equal(second,1);
  stopSecond();assert.equal(tryScreenBack(),false);
});
