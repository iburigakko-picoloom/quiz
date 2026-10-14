import assert from 'node:assert/strict';
import test from 'node:test';
import { reflectGroupSourceLearning, reflectOwnedStudyLearning } from '../src/utils/groupLearningReflection.ts';
import { applyPublishedSource, publicationSourceFromSnapshot } from '../src/utils/groupStudySource.ts';
import { questionRevision } from '../src/utils/studyPlans.ts';

const now = new Date('2026-10-14T03:00:00Z');
function fixture() {
  const questions = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, setId: 'original', logicalId: `logical${i}`, question: `Q${i}`, choices: ['A','B','C','D'], answerIndex: 0, answerText: 'A', explanation: '', sourcePage: '', category: 'Medicine', difficulty: 'basic' }));
  const shared = { id: 'published', localSetId: 'original', ownerId: 'owner', visibility: 'group', versionId: 'version1', questionCount: 4, questions };
  const data = { version: 1, folders: [], problemSets: [{ id: 'original', title: 'Already studied', folderId: 'folder' }], questions,
    progress: questions.map((q,i) => ({ questionId: q.id, answeredCount: i ? 1 : 0, reviewLevel: i || null, isGraduated: i === 3 })),
    answerLogs: [1,1,2].map((i,n) => ({ id: `log${n}`, setId: 'original', questionId: `q${i}`, questionRevision: questionRevision(questions[i]), answeredAt: n === 2 ? '2026-10-12T03:00:00Z' : now.toISOString(), selectedIndex: n, isCorrect: n === 0, privateNote: 'never send' })) };
  const source = publicationSourceFromSnapshot(shared, 'owner', 'original', ['group1','group2']);
  return { data: applyPublishedSource(data, 'original', { id: shared.id, visibility: 'group', versionId: shared.versionId }, source, now.toISOString()), shared };
}
function server(initial = {}) {
  const own = new Map(Object.entries(initial)), calls = [], updates = new Map();
  let failGroup = '', disableBeforeUpdate = false;
  const rpc = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    const c = own.get(args.p_group_id) ?? { generation: null, enabled: false, copy_id: null, version_id: null };
    if (name === 'quiz_group_learning_set_read') return { version_id: 'version1', own: structuredClone(c), members: [] };
    if (name === 'quiz_group_progress_consent') {
      assert.equal(args.p_expected_generation, c.generation);
      const next = { generation: `generation-${calls.length}`, enabled: true, copy_id: args.p_copy_id, version_id: args.p_version_id };
      own.set(args.p_group_id, next); return { generation: next.generation, enabled: true };
    }
    if (disableBeforeUpdate) { own.set(args.p_group_id, { ...c, generation: 'OFF', enabled: false }); throw new Error('consent changed'); }
    if (args.p_group_id === failGroup) throw new Error('temporary network failure');
    assert.equal(c.enabled, true); assert.equal(args.p_generation, c.generation); assert.equal(args.p_copy_id, c.copy_id); assert.equal(args.p_version_id, c.version_id);
    updates.set(args.p_group_id, structuredClone(args)); return true;
  };
  return { own, calls, updates, rpc, fail: group => { failGroup = group; }, disableDuringUpdate: () => { disableBeforeUpdate = true; } };
}
const enabled = { generation: 'ON', enabled: true, copy_id: 'original', version_id: 'version1' };

test('publication immediately shares prior levels and prepublication answers from one original in every selected group', async () => {
  const { data } = fixture(), mock = server(), before = JSON.stringify(data);
  assert.equal(await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1','group1','group2'], mock.rpc, { initialize: true, now }), 2);
  assert.equal(mock.calls.filter(c => c.name === 'quiz_group_progress_consent').length, 2);
  for (const row of mock.updates.values()) {
    assert.deepEqual(row.p_levels, [1,1,1,1]); assert.equal(row.p_answered, 2);
    assert.equal(row.p_today, 2); assert.equal(row.p_week, 3); assert.equal(row.p_day, '2026-10-14'); assert.equal(row.p_week_start, '2026-10-12');
    assert.equal(row.p_copy_id, 'original');
  }
  assert.equal(JSON.stringify(data), before); assert.equal(data.problemSets.length, 1);
  const requests = JSON.stringify(mock.calls);
  for (const privateField of ['answerLogs','selectedIndex','isCorrect','privateNote','never send','Already studied']) assert.equal(requests.includes(privateField), false);
});

test('partial failure keeps successful groups and retries absolute aggregates without another consent or double counting', async () => {
  const { data } = fixture(), mock = server(); mock.fail('group2');
  await assert.rejects(reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1','group2'], mock.rpc, { initialize: true, now }), /network/);
  assert.deepEqual(mock.updates.get('group1').p_levels, [1,1,1,1]);
  mock.fail(''); await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1','group2'], mock.rpc, { initialize: true, now });
  assert.equal(mock.calls.filter(c => c.name === 'quiz_group_progress_consent').length, 2);
  assert.equal(mock.updates.get('group1').p_today, 2); assert.equal(mock.updates.get('group2').p_today, 2);
});

test('explicit OFF, another chosen copy and a changed publication version are preserved', async () => {
  const { data } = fixture(), mock = server({ group1: { ...enabled, enabled: false, generation: 'OFF' }, group2: { ...enabled, copy_id: 'chosen-copy' } });
  assert.equal(await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1','group2'], mock.rpc, { initialize: true, now }), 0);
  assert.equal(mock.calls.every(c => c.name === 'quiz_group_learning_set_read'), true);
  const stale = async () => ({ version_id: 'new-version', own: enabled, members: [] });
  assert.equal(await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1'], stale, { initialize: true, now }), 0);
});

test('OFF racing a delayed update cannot be undone by the publication retry', async () => {
  const { data } = fixture(), mock = server(); mock.disableDuringUpdate();
  await assert.rejects(reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1'], mock.rpc, { initialize: true, now }), /consent changed/);
  const consentCount = mock.calls.filter(c => c.name === 'quiz_group_progress_consent').length;
  assert.equal(await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1'], mock.rpc, { initialize: true, now }), 0);
  assert.equal(mock.calls.filter(c => c.name === 'quiz_group_progress_consent').length, consentCount);
});

test('subsequent exercise refreshes an enabled original, excludes edits and leaves disabled groups OFF', async () => {
  const { data } = fixture(), mock = server({ group1: enabled });
  data.progress[1] = { ...data.progress[1], reviewLevel: 3, isGraduated: true };
  data.questions[2] = { ...data.questions[2], question: 'Edited after publication' };
  assert.equal(await reflectOwnedStudyLearning(data, ['original'], 'owner', mock.rpc, async () => { throw Error('manifest already retained'); }, now), 1);
  assert.deepEqual(mock.updates.get('group1').p_levels, [2,0,0,2]); assert.equal(mock.updates.get('group1').p_answered, 1);
  assert.equal(mock.calls.some(c => c.name === 'quiz_group_progress_consent'), false);
});

test('large source pointer derives its manifest from the owned snapshot only in memory, without changing the backup or sync record', async () => {
  const { data, shared } = fixture(), mock = server({ group1: enabled });
  delete data.problemSets[0].publicationSource.manifest;
  const before = JSON.stringify(data), loaded = [];
  assert.equal(await reflectOwnedStudyLearning(data, ['original'], 'owner', mock.rpc, async id => { loaded.push(id); return shared; }, now), 1);
  assert.deepEqual(loaded, ['published']); assert.equal(JSON.stringify(data), before); assert.deepEqual(mock.updates.get('group1').p_levels, [1,1,1,1]);
});

test('other accounts and unbound/removed originals cannot submit any aggregates or restore sharing', async () => {
  const { data } = fixture(), mock = server();
  assert.equal(await reflectGroupSourceLearning(data, data.problemSets[0], 'different-account', ['group1'], mock.rpc, { initialize: true, now }), 0);
  assert.equal(await reflectGroupSourceLearning(data, { ...data.problemSets[0], cloudSetId: undefined }, 'owner', ['group1'], mock.rpc, { initialize: true, now }), 0);
  assert.equal(await reflectOwnedStudyLearning(data, ['missing'], 'owner', mock.rpc, async () => { throw Error('unneeded'); }, now), 0);
  assert.equal(mock.calls.length, 0);
});

test('enabled original on a newly republished version uses compare-and-swap to move its own binding before reflection', async () => {
  const { data } = fixture(), mock = server({ group1: { ...enabled, version_id: 'old-version' } });
  await reflectGroupSourceLearning(data, data.problemSets[0], 'owner', ['group1'], mock.rpc, { initialize: true, now });
  assert.equal(mock.calls.find(c => c.name === 'quiz_group_progress_consent').args.p_expected_generation, 'ON');
  assert.equal(mock.updates.get('group1').p_version_id, 'version1');
});
