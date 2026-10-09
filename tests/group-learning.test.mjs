import assert from 'node:assert/strict';
import test from 'node:test';
import { importedLearning, levelPercentages, sortLearningMembers, sumLevels } from '../src/utils/groupLearning.ts';
import { buildGroupLibrary, groupFolderSets } from '../src/utils/groupLibrary.ts';
import { questionRevision } from '../src/utils/studyPlans.ts';

const now = new Date('2026-10-08T03:00:00Z');
function fixture() {
  const questions = Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, setId: 'copy', question: `Question ${i}`, choices: ['A','B','C','D'], answerIndex: 0, answerText: 'A', explanation: '', sourcePage: '', category: '', difficulty: 'basic' }));
  for (const [i, q] of questions.entries()) q.origin = { setId: 'published', logicalId: `logical${i}`, publicationVersionId: 'v1', contentRevision: `hash${i}`, importedContent: questionRevision(q) };
  const set = { id: 'copy', sourceSetId: 'published', sourceVersionId: 'v1', sourceManifest: questions.map(q => ({ logicalId: q.origin.logicalId, contentRevision: q.origin.contentRevision })) };
  return { set, data: { questions, problemSets: [set], progress: questions.map((q, i) => ({ questionId: q.id, answeredCount: i ? 1 : 0, reviewLevel: i || null, isGraduated: i === 3 })), answerLogs: [] } };
}
test('percentages sum to 100 using stable rounding, including small and empty sets', () => {
  assert.deepEqual(levelPercentages([1,1,1,0]), [34,33,33,0]);
  assert.deepEqual(levelPercentages([0,0,0,0]), [0,0,0,0]);
  assert.deepEqual(sumLevels([[1,2,3,4], [4,3,2,1]]), [5,5,5,5]);
});
test('source denominator survives edits, removal and duplicates; graduation maps to L3', () => {
  const { set, data } = fixture();
  assert.deepEqual(importedLearning(data,set,'published','v1',now).levels, [1,1,1,1]);
  data.questions[1].question = 'Edited locally';
  data.questions = data.questions.filter(q => q.id !== 'q2');
  data.questions.push({ ...data.questions[1], id: 'duplicate-q3' });
  assert.deepEqual(importedLearning(data,set,'published','v1',now).levels, [3,0,0,1]);
  assert.equal(importedLearning(data,set,'published','other-version',now),null);
  assert.equal(importedLearning(data,{ ...set, sourceManifest: [...set.sourceManifest,set.sourceManifest[0]] },'published','v1',now),null);
});
test('answer counts include repetition, exclude unrelated versions, and follow Japan day/Monday boundaries', () => {
  const { set, data } = fixture(); const q=data.questions[1];
  const log = at => ({ questionId:q.id,setId:'copy',questionRevision:q.origin.importedContent,answeredAt:at });
  data.answerLogs = [log('2026-10-07T15:00:00Z'),log('2026-10-08T02:00:00Z'),log('2026-10-04T15:00:00Z'),log('2026-10-04T14:59:59Z'),{ ...log('2026-10-08T02:00:00Z'),questionRevision:'other' },{ ...log('2026-10-08T02:00:00Z'),setId:'another-copy' }];
  const result=importedLearning(data,set,'published','v1',now);
  assert.equal(result.todayCount,2); assert.equal(result.weekCount,3); assert.equal(result.answered,1);
  assert.equal(result.day,'2026-10-08'); assert.equal(result.weekStart,'2026-10-05'); assert.equal(result.total,4);
});
test('unknown metrics sort after a shared zero; L3 sorts by question-weighted ratio', () => {
  const rows=[{userId:'unknown',displayName:'Unknown',todayCount:null,weekCount:null,levels:null},{userId:'zero',displayName:'Zero',todayCount:0,weekCount:0,levels:[10,0,0,0]},{userId:'high',displayName:'High',todayCount:5,weekCount:5,levels:[1,0,0,1]}];
  assert.deepEqual(sortLearningMembers(rows,'today').map(row=>row.userId),['high','zero','unknown']);
  assert.deepEqual(sortLearningMembers(rows,'l3').map(row=>row.userId),['high','zero','unknown']);
});
test('group folders retain empty folders and shared placements without merging owners or editing source paths', () => {
  const sets=[{id:'s1',ownerId:'owner',folderPath:[{id:'local',name:'Local'}],questionCount:2,updatedAt:'2026-10-08'}, {id:'s2',ownerId:'other',folderPath:[{id:'local',name:'Local'}],questionCount:3,updatedAt:'2026-10-08'}];
  const snapshot={folders:[{id:'root',name:'CBT',parentId:null},{id:'child',name:'Cardiology',parentId:'root'},{id:'empty',name:'Empty',parentId:null}],placements:[{setId:'s1',folderId:'child'},{setId:'s2',folderId:'root'}]};
  const library=buildGroupLibrary(sets,snapshot);
  assert.equal(library.length,2);assert.equal(library[1].name,'Empty');
  assert.deepEqual(groupFolderSets(library[0]).map(set=>set.id),['s2','s1']);
  assert.equal(sets[0].folderPath[0].name,'Local');
  assert.equal(buildGroupLibrary(sets,null).length,2);
});
