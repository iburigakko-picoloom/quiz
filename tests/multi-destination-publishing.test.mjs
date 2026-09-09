import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('public and multiple group destinations can be selected without removing existing destinations', () => {
  const ui = read('../src/screens/CommunityScreen.tsx');
  assert.match(ui, /公開先（複数選択可）/);
  assert.match(ui, /groupIds: target.groupIds, addDestinations: true/);
  assert.match(ui, /!addTarget.public && !addTarget.groupIds.length/);
  assert.match(ui, /groups.length \? <fieldset><legend>グループにも公開/);
  assert.doesNotMatch(ui, /共有中のセットは公開先が変わります/);
  assert.match(read('../src/utils/cloudService.ts'), /add_destinations: params.addDestinations \?\? false/);
});

test('RPC retains existing public and group destinations and still checks membership', () => {
  const sql = read('../supabase/migrations/20260909144728_multi_destination_publishing.sql');
  assert.match(sql, /if not add_destinations then\s+delete from public.quiz_group_problem_sets/);
  assert.match(sql, /add_destinations and public.shared_problem_sets.visibility = 'public'/);
  assert.match(sql, /if jsonb_array_length\(requested_groups\) > 0 then/);
  assert.match(sql, /is_quiz_group_member\(group_id_text::uuid, current_user_id\)/);
  assert.match(sql, /returning id, share_token, visibility into/);
});
