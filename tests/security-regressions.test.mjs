import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [
  baseCollaborationSql,
  securitySql,
  cloudServiceSource,
  communityScreenSource,
  syncServiceSource,
  syncSecuritySql,
  accountOwnedSyncDeletionSql,
] = await Promise.all([
  readFile(new URL('../supabase/migrations/20260806_create_collaboration_mvp.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260814163631_secure_collaboration_rpc_only.sql', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/syncService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260823172155_harden_account_owned_sync_and_add_pairing_codes.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260823180238_delete_account_owned_sync_data.sql', import.meta.url), 'utf8'),
]);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('collaboration tables expose SELECT only and revoke direct writes from API roles', () => {
  for (const table of ['shared_problem_sets', 'shared_questions']) {
    assert.match(
      securitySql,
      new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon\\s*,\\s*authenticated\\s*;`, 'i'),
    );
    assert.match(
      securitySql,
      new RegExp(`grant\\s+select\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+anon\\s*,\\s*authenticated\\s*;`, 'i'),
    );
    assert.doesNotMatch(
      securitySql,
      new RegExp(`grant\\s+[^;]*(?:insert|update|delete|truncate|all)[^;]*on\\s+(?:table\\s+)?public\\.${table}\\s+to\\s+(?:anon|authenticated)`, 'i'),
    );
  }

  assert.match(
    securitySql,
    /revoke\s+all\s+on\s+table\s+public\.problem_set_copies\s+from\s+anon\s*,\s*authenticated\s*;/i,
  );
  assert.doesNotMatch(
    securitySql,
    /grant\s+[^;]+on\s+(?:table\s+)?public\.problem_set_copies\s+to\s+(?:anon|authenticated)/i,
  );

  for (const policy of [
    'shared_sets_owner_insert',
    'shared_sets_owner_update',
    'shared_sets_owner_delete',
    'shared_questions_owner_insert',
    'shared_questions_owner_update',
    'shared_questions_owner_delete',
  ]) {
    assert.match(securitySql, new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${policy}`, 'i'));
  }
});

test('publish, copy and unpublish RPCs have authentication and ownership boundaries', () => {
  const allCollaborationSql = `${baseCollaborationSql}\n${securitySql}`;

  assert.match(securitySql, /revoke\s+all\s+on\s+function\s+public\.publish_problem_set\(jsonb\s*,\s*jsonb\)\s+from\s+anon\s*;/i);
  assert.match(securitySql, /grant\s+execute\s+on\s+function\s+public\.publish_problem_set\(jsonb\s*,\s*jsonb\)\s+to\s+authenticated\s*;/i);
  assert.match(allCollaborationSql, /revoke\s+all\s+on\s+function\s+public\.publish_problem_set\(jsonb\s*,\s*jsonb\)\s+from\s+public\s*;/i);

  assert.match(securitySql, /revoke\s+all\s+on\s+function\s+public\.record_problem_set_copy\(uuid\s*,\s*uuid\s*,\s*text\)\s+from\s+public\s*,\s*anon\s*;/i);
  assert.match(securitySql, /grant\s+execute\s+on\s+function\s+public\.record_problem_set_copy\(uuid\s*,\s*uuid\s*,\s*text\)\s+to\s+authenticated\s*;/i);
  assert.match(securitySql, /current_user_id\s+uuid\s*:=\s*auth\.uid\(\)/i);
  assert.match(securitySql, /if\s+current_user_id\s+is\s+null\s+then[\s\S]*?raise\s+exception\s+'not authorized'/i);
  assert.match(securitySql, /where\s+id\s*=\s*p_set_id\s+and\s+visibility\s*=\s*'public'/i);
  assert.match(securitySql, /unique\s+index[\s\S]*?\(set_id\s*,\s*actor_id\)[\s\S]*?where\s+actor_id\s+is\s+not\s+null/i);
  assert.match(securitySql, /on\s+conflict\s+do\s+nothing/i);

  assert.match(securitySql, /create\s+or\s+replace\s+function\s+public\.unpublish_problem_set\(p_set_id\s+uuid\)[\s\S]*?security\s+definer[\s\S]*?set\s+search_path\s*=\s*''/i);
  assert.match(securitySql, /delete\s+from\s+public\.shared_problem_sets[\s\S]*?where\s+id\s*=\s*p_set_id\s+and\s+owner_id\s*=\s*auth\.uid\(\)/i);
  assert.match(securitySql, /revoke\s+all\s+on\s+function\s+public\.unpublish_problem_set\(uuid\)\s+from\s+public\s*,\s*anon\s*;/i);
  assert.match(securitySql, /grant\s+execute\s+on\s+function\s+public\.unpublish_problem_set\(uuid\)\s+to\s+authenticated\s*;/i);
});

test('anonymous users cannot invoke group, account or trigger-only functions', () => {
  const authenticatedOnlyFunctions = [
    'create_quiz_group\\(text\\)',
    'list_my_groups\\(\\)',
    'create_group_invite\\(uuid\\)',
    'join_quiz_group\\(text\\)',
    'remove_quiz_group_member\\(uuid,\\s*uuid\\)',
    'list_group_problem_sets\\(uuid\\)',
    'list_quiz_group_members\\(uuid\\)',
    'is_quiz_group_member\\(uuid,\\s*uuid\\)',
    'is_quiz_group_admin\\(uuid,\\s*uuid\\)',
    'set_profile_display_name\\(text\\)',
    'delete_quiz_account\\(\\)',
  ];

  for (const signature of authenticatedOnlyFunctions) {
    assert.match(
      securitySql,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${signature}\\s+from\\s+anon\\s*;`, 'i'),
    );
  }

  assert.match(
    securitySql,
    /revoke\s+all\s+on\s+function\s+public\.handle_quiz_user_created\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
  );
  assert.match(
    securitySql,
    /revoke\s+all\s+on\s+function\s+public\.enforce_shared_question_payload_limit\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
  );
});

test('shared question writes enforce field, answer and aggregate payload limits', () => {
  assert.match(baseCollaborationSql, /jsonb_array_length\(choices\)\s+between\s+4\s+and\s+5/i);
  assert.match(baseCollaborationSql, /jsonb_array_length\(p_questions\)\s*>\s*1000/i);
  assert.match(securitySql, /returns\s+trigger[\s\S]*?security\s+invoker[\s\S]*?set\s+search_path\s*=\s*''/i);

  for (const [field, byteLimit] of [
    ['question', 30_000],
    ['answer_text', 30_000],
    ['explanation', 90_000],
    ['detailed_explanation', 180_000],
    ['source_page', 1_500],
    ['category', 360],
  ]) {
    assert.match(
      securitySql,
      new RegExp(`octet_length\\(new\\.${field}\\)\\s*>\\s*${byteLimit}`, 'i'),
    );
  }
  assert.match(securitySql, /jsonb_typeof\(choice\)\s*<>\s*'string'/i);
  assert.match(securitySql, /octet_length\(choice\s*#>>\s*'\{\}'\)\s*>\s*12000/i);
  assert.match(securitySql, /cardinality\(new\.answer_indexes\)\s*<>[\s\S]*?count\(distinct\s+answer_index\)/i);
  assert.match(securitySql, /answer_index\s*<\s*0\s+or\s+answer_index\s*>=\s*jsonb_array_length\(new\.choices\)/i);
  assert.match(securitySql, /existing_bytes\s*\+\s*pg_column_size\(to_jsonb\(new\)\)\s*>\s*8388608/i);
  assert.match(
    securitySql,
    /create\s+trigger\s+enforce_shared_question_payload_limit\s+before\s+insert\s+or\s+update\s+on\s+public\.shared_questions/i,
  );
});

test('cloud publishing reconciliation supports RPC unpublish and cloud-only orphan cleanup', () => {
  const publicListBody = sourceBetween(
    cloudServiceSource,
    'export async function listPublicProblemSets',
    'export async function listMyPublishedSets',
  );
  const myListBody = sourceBetween(
    cloudServiceSource,
    'export async function listMyPublishedSets',
    'export async function unpublishCloudProblemSet',
  );
  const unpublishBody = sourceBetween(
    cloudServiceSource,
    'export async function unpublishCloudProblemSet',
    'export async function getSharedProblemSet',
  );

  assert.doesNotMatch(publicListBody, /local_set_id/);
  assert.match(myListBody, /\.select\([^\n]*local_set_id/);
  assert.match(cloudServiceSource, /localSetId:\s*String\(row\.local_set_id\s*\?\?\s*row\.localSetId\s*\?\?\s*''\)/);
  assert.match(unpublishBody, /client\.rpc\('unpublish_problem_set',\s*\{\s*p_set_id:\s*setId\s*\}\)/);
  assert.doesNotMatch(unpublishBody, /\.from\('shared_problem_sets'\)|\.delete\(\)/);
  assert.match(unpublishBody, /if\s*\(data\s*!==\s*true\)/);

  assert.match(
    communityScreenSource,
    /orphanedPublishedSets[\s\S]*?local\.cloudSetId\s*===\s*published\.id\s*\|\|\s*local\.id\s*===\s*published\.localSetId/,
  );
  assert.match(
    communityScreenSource,
    /publishedSets\.find\(\(item\)\s*=>\s*item\.id\s*===\s*set\.cloudSetId\s*\|\|\s*item\.localSetId\s*===\s*set\.id\)/,
  );
  assert.match(communityScreenSource, /orphanedPublishedSets\.map\(\(published\)\s*=>/);
  assert.match(communityScreenSource, /stopSharing\(undefined,\s*published\.id\)/);
  assert.match(
    communityScreenSource,
    /if\s*\(localSetId\s*&&\s*data\.problemSets\.some[\s\S]*?await\s+onUnpublished\(localSetId\)/,
  );
});

test('sync network access is timeout-bound and never falls back to direct table access', () => {
  for (const [constant, rpcName] of [
    ['SUPABASE_READ_RPC', 'quiz_sync_read'],
    ['SUPABASE_META_RPC', 'quiz_sync_meta'],
    ['SUPABASE_UPSERT_RPC', 'quiz_sync_upsert_v2'],
    ['SUPABASE_PROBE_RPC', 'quiz_sync_probe'],
    ['SUPABASE_DELETE_RPC', 'quiz_sync_delete_v2'],
    ['SUPABASE_CREATE_PAIRING_RPC', 'quiz_sync_create_pairing_code'],
    ['SUPABASE_REDEEM_PAIRING_RPC', 'quiz_sync_redeem_pairing_code'],
    ['SUPABASE_UPGRADE_LEGACY_RPC', 'quiz_sync_upgrade_legacy_id'],
  ]) {
    assert.match(syncServiceSource, new RegExp(`const\\s+${constant}\\s*=\\s*'${rpcName}'`));
  }

  assert.equal((syncServiceSource.match(/\bfetch\s*\(/gu) ?? []).length, 1);
  assert.match(syncServiceSource, /const\s+REMOTE_REQUEST_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(syncServiceSource, /async\s+function\s+fetchWithTimeout[\s\S]*?new\s+AbortController\(\)/);
  assert.match(syncServiceSource, /timeoutMs = REMOTE_REQUEST_TIMEOUT_MS/);
  assert.match(syncServiceSource, /const DATA_TRANSFER_TIMEOUT_MS = 60_000/);
  assert.match(syncServiceSource, /window\.setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*timeoutMs\)/);
  assert.match(syncServiceSource, /fetch\(input,\s*\{\s*\.\.\.init,\s*signal:\s*controller\.signal\s*\}\)/);
  assert.match(syncServiceSource, /finally\s*\{\s*window\.clearTimeout\(timeout\)/);
  assert.ok((syncServiceSource.match(/fetchWithTimeout\(`/gu) ?? []).length >= 5);
  assert.doesNotMatch(syncServiceSource, /SUPABASE_TABLE|fetchLegacySyncRow|uploadWithLegacyTable|sameTimestamp/);
  assert.doesNotMatch(syncServiceSource, /\/rest\/v1\/quiz_sync_data|\.from\(['"]quiz_sync_data['"]\)/);
  assert.match(syncServiceSource, /if\s*\(!response\.ok\s*&&\s*await\s+isMissingSyncRpc\(response\)\)/);
  assert.match(syncServiceSource, /if\s*\(!cryptoApi\?\.getRandomValues\)\s*\{[\s\S]*?throw new Error/);
  assert.doesNotMatch(syncServiceSource, /Math\.random\(\)/);
});

test('sync RPCs require a permanent account and keep rows account-owned', () => {
  assert.match(syncSecuritySql, /authenticated_user\s+uuid\s*:=\s*auth\.uid\(\)/i);
  assert.match(syncSecuritySql, /claims\s*->>\s*'is_anonymous'/i);
  assert.match(syncSecuritySql, /quiz_sync_authentication_required/i);

  for (const signature of [
    'quiz_sync_read\\(text\\)',
    'quiz_sync_meta\\(text\\)',
    'quiz_sync_probe\\(text\\)',
    'quiz_sync_upsert_v2\\(text,\\s*jsonb,\\s*timestamptz,\\s*timestamptz,\\s*boolean\\)',
    'quiz_sync_delete_v2\\(text,\\s*timestamptz,\\s*boolean\\)',
    'quiz_sync_create_pairing_code\\(text\\)',
    'quiz_sync_redeem_pairing_code\\(text\\)',
    'quiz_sync_upgrade_legacy_id\\(text,\\s*timestamptz,\\s*text\\)',
  ]) {
    assert.match(
      syncSecuritySql,
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+to\\s+authenticated\\s*;`, 'i'),
    );
    assert.doesNotMatch(
      syncSecuritySql,
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+to\\s+[^;]*\\banon\\b`, 'i'),
    );
  }

  assert.match(syncSecuritySql, /existing_creator\s+is\s+not\s+null\s+and\s+existing_creator\s+is\s+distinct\s+from\s+actor/i);
  assert.match(syncSecuritySql, /row_data\.creator_hash\s*=\s*actor/i);
  assert.match(syncSecuritySql, /update\s+private\.quiz_sync_legacy_migrations\s+as\s+migration\s+set\s+creator_hash\s*=\s*quota_actor/i);
});

test('account deletion removes owned sync data and rejects deleted-user tokens', () => {
  assert.match(accountOwnedSyncDeletionSql, /pg_advisory_xact_lock_shared[\s\S]*?quiz-sync-account:/i);
  assert.match(accountOwnedSyncDeletionSql, /from\s+auth\.users[\s\S]*?account\.id\s*=\s*authenticated_user/i);
  assert.match(accountOwnedSyncDeletionSql, /pg_advisory_xact_lock[\s\S]*?quiz-sync-account:/i);
  assert.match(accountOwnedSyncDeletionSql, /delete\s+from\s+private\.quiz_sync_tombstones/i);
  assert.match(accountOwnedSyncDeletionSql, /delete\s+from\s+public\.quiz_sync_data[\s\S]*?creator_hash\s*=\s*current_creator_hash/i);
  assert.match(accountOwnedSyncDeletionSql, /delete\s+from\s+private\.quiz_sync_rate_limits[\s\S]*?actor_hash\s*=\s*current_creator_hash/i);
  assert.match(accountOwnedSyncDeletionSql, /delete\s+from\s+auth\.users[\s\S]*?account\.id\s*=\s*current_user_id/i);
  assert.match(accountOwnedSyncDeletionSql, /revoke\s+all\s+on\s+function\s+public\.delete_quiz_account\(\)\s+from\s+public,\s*anon/i);
  assert.match(accountOwnedSyncDeletionSql, /grant\s+execute\s+on\s+function\s+public\.delete_quiz_account\(\)\s+to\s+authenticated/i);
});
