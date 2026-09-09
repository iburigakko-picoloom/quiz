import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('published folder additions use the chosen path without moving local data', () => {
  const source = read('../src/screens/CommunityScreen.tsx');
  assert.match(source, /folderPath: target.folderPath/);
  assert.match(source, /onAdd=\{\(path\) => openAdd\('public', path\)\}/);
  assert.match(source, /onAdd=\{\(path\) => openAdd\('group', path\)\}/);
  assert.match(read('../src/utils/cloudService.ts'), /params.folderPath !== undefined/);
});
test('movement is an authenticated owner-only operation with limited fields', () => {
  const sql = read('../supabase/migrations/20260909135603_move_published_set_folder.sql');
  assert.match(sql, /auth.uid\(\) is null/);
  assert.match(sql, /where id = p_set_id and owner_id = auth.uid\(\)/);
  assert.match(sql, /from public, anon/);
  assert.doesNotMatch(sql, /set visibility|delete from|update public.shared_questions/i);
});
