import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, screenSource, settingsSource, primaryNavSource, serviceSource, typesSource, validationSource, collaborationMigration, groupManagementMigration, accountDeletionMigration, reportReasonsMigration] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/screens/CommunityScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/PrimaryBottomNav.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/utils/appDataValidation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260806_create_collaboration_mvp.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260807_add_group_member_management.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260808_add_account_deletion.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260809_expand_report_reasons.sql', import.meta.url), 'utf8'),
]);
const migration = [collaborationMigration, groupManagementMigration, accountDeletionMigration, reportReasonsMigration].join('\n');

test('local AppData stays version 1 and cloud metadata is backward-compatible', () => {
  assert.match(typesSource, /version:\s*1/);
  assert.match(typesSource, /cloudSetId\?: string/);
  assert.match(validationSource, /copyOptionalString\(value, item, 'cloudSetId'\)/);
  assert.match(appSource, /createEmptyAppData/);
});

test('the primary navigation exposes the five global destinations', () => {
  for (const label of ['ホーム', '見つける', '作成', 'グループ', '設定']) {
    assert.match(primaryNavSource, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(screenSource, /community-tabs/);
  assert.match(screenSource, /共有するときだけログイン/);
  assert.doesNotMatch(screenSource, /問題作成と学習だけならログインは不要/);
});

test('public discovery supports required filters, detail preview and both primary actions', () => {
  assert.match(appSource, /item === 'discover'\s*\? \{ name: 'community', tab: 'discover' \}/);
  assert.doesNotMatch(appSource, /<SearchScreen|import \{ SearchScreen \}/);
  assert.match(screenSource, /community-discovery-row/);
  assert.match(screenSource, /onClick=\{\(\) => onDetail\(set\)\}/);
  assert.match(screenSource, />対策・用途<select/);
  assert.match(screenSource, /publicationPurposes, \.\.\.publicSets.map\(\(set\) => set.audience\)/);
  assert.match(screenSource, /set.audience === audienceFilter/);
  assert.match(screenSource, /<h3>難易度<\/h3>/);
  assert.match(screenSource, /aria-pressed=\{conditionDraft.difficulty === value\}/);
  assert.match(screenSource, /この条件で検索/);
  assert.match(screenSource, /問題の内容を確認/);
  assert.match(screenSource, /このまま解く/);
  assert.match(screenSource, /自分のフォルダにコピー/);
  const previewAnswerBody = appSource.slice(appSource.indexOf('const handlePreviewAnswer'), appSource.indexOf('const handleCreateProblemSet'));
  assert.doesNotMatch(previewAnswerBody, /commitData|persistThenCommitData|recordAnswer/);
  assert.match(previewAnswerBody, /学習履歴には記録しません/);
});

test('groups navigate to a dedicated detail with foldered problem sets', () => {
  assert.match(typesSource, /name: 'community';[^\n]*groupId\?: string/);
  assert.match(appSource, /onOpenGroup=\{\(groupId\) => navigate\(\{ name: 'community', tab: 'groups', groupId/);
  assert.match(screenSource, /initialGroupId/);
  assert.match(screenSource, /community-group-folder-list/);
  assert.match(screenSource, /<SharedLibrary[^\n]*sets=\{groupSets\}/);
  assert.match(screenSource, /role="tablist" aria-label="グループの表示"/);
  assert.match(screenSource, /hidden=\{groupDetailTab !== 'members'\}/);
  assert.doesNotMatch(screenSource, /selectedGroupId === group\.id/);
});

test('a copied cloud set gets new local ids and source attribution', () => {
  assert.match(appSource, /const setId = createId\('set'\)/);
  assert.match(appSource, /id: createId\('q'\)/);
  assert.match(appSource, /creationMethod: 'public-copy'/);
  assert.match(appSource, /sourceSetId: sharedSet\.id/);
  assert.match(appSource, /sourceOwnerName: sharedSet\.authorName/);
});

test('publishing sends only set content, never progress or answer logs', () => {
  const publishBody = serviceSource.slice(serviceSource.indexOf('export async function publishLocalProblemSet'), serviceSource.indexOf('export async function listPublicProblemSets'));
  assert.match(publishBody, /p_questions/);
  assert.doesNotMatch(publishBody, /answerLogs/);
  assert.doesNotMatch(publishBody, /progress:/);
  assert.match(screenSource, /getCloudDisplayName/);
  assert.match(screenSource, /authorName: profileName/);
});

test('collaboration tables all enable row-level security', () => {
  const tables = [
    'quiz_profiles', 'quiz_groups', 'quiz_group_members', 'shared_problem_sets',
    'shared_questions', 'quiz_group_problem_sets', 'quiz_group_invites',
    'problem_set_copies', 'problem_reports',
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
});

test('link-only sets require the exact token in the security-definer reader', () => {
  assert.match(migration, /p_share_token is not null and p_share_token = set_row\.share_token/);
  assert.doesNotMatch(migration, /create policy shared_sets_visible_select[\s\S]*?visibility = 'link'/);
});

test('group membership, admin operations and expiring invites are database-enforced', () => {
  assert.match(migration, /is_quiz_group_member/);
  assert.match(migration, /is_quiz_group_admin/);
  assert.match(migration, /expires_at > now\(\)/);
  assert.match(migration, /owner cannot be removed/);
  assert.match(migration, /list_quiz_group_members/);
});

test('owners can stop sharing and users can delete only their own cloud account', () => {
  assert.match(screenSource, /共有を停止しました/);
  assert.match(serviceSource, /unpublishCloudProblemSet/);
  assert.match(migration, /delete from auth\.users where id = current_user_id/);
  assert.match(settingsSource, /端末内の問題セット、回答履歴、復習状態は削除されません/);
  assert.match(settingsSource, /deleteCloudAccount/);
});

test('quality reports expose every required reason', () => {
  for (const reason of ['incorrect_answer', 'incorrect_explanation', 'unclear_question', 'duplicate', 'copyright', 'other']) {
    assert.match(screenSource, new RegExp(`value="${reason}"`));
    assert.match(migration, new RegExp(`'${reason}'`));
  }
});

test('the client uses only Vite public Supabase settings and never a service key', () => {
  assert.match(serviceSource, /VITE_SUPABASE_URL/);
  assert.match(serviceSource, /VITE_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(serviceSource, /service[_-]?role/i);
});
