import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

test('public folder JSON array is sent as JSON, not a PostgreSQL array', async () => {
  let requested;
  const client = createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url) => { requested = new URL(url); return new Response('[]', { headers: { 'Content-Type': 'application/json' } }); } },
  });
  await client.from('shared_problem_sets').select('id').eq('visibility', 'public').eq('owner_id', 'owner')
    .contains('folder_path', JSON.stringify([{ id: 'folder' }]));
  assert.equal(requested.searchParams.get('folder_path'), 'cs.[{"id":"folder"}]');
  const source = readFileSync(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8');
  assert.match(source, /contains\('folder_path', JSON.stringify\(\[\{ id: folderId \}\]\)\)/);
});
