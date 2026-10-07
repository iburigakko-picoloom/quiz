import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';

const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]sx?$/u.test(specifier)
    && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
after(() => hook.deregister());
const { recordConflictTitle, describeRecordConflictValue, recordConflictIdentity, retainRecordConflictChoices } =
  await import('../src/utils/recordConflictPresentation.ts');
const { compareRecordConflict, conflictPreview } = await import('../src/utils/recordConflictComparison.ts');
const { exportRecordConflictOriginals } = await import('../src/utils/recordConflictExport.ts');
const { syncStatusPresentation } = await import('../src/utils/syncStatusPresentation.ts');
const key = (collection, id) => JSON.stringify([collection, id]);
const rows = new Map([
  [key('questions', 'q_internal-id'), { raw: JSON.stringify({ id: 'q_internal-id', setId: 'set_internal-id', question: '酸素の元素記号は？' }) }],
  [key('problemSets', 'set_internal-id'), { raw: JSON.stringify({ title: '化学の基礎' }) }],
]);
const conflict = { key: key('progress', 'q_internal-id'), operationId: 'operation', local: { position: 0, raw: '{"answeredCount":1}' },
  remote: { collection: 'progress', id: 'q_internal-id', revision: 2, position: 0, raw: '{"answeredCount":0}' } };

test('progress and answer-log conflict titles identify the problem and set without internal IDs', () => {
  assert.equal(recordConflictTitle(conflict, rows), '回答・復習の状態：化学の基礎 / 酸素の元素記号は？');
  const log = { ...conflict, local: { raw: JSON.stringify({ questionId: 'q_internal-id' }) }, remote: { ...conflict.remote, collection: 'answerLogs', id: 'log_internal-id' } };
  assert.equal(recordConflictTitle(log, rows), '回答履歴：化学の基礎 / 酸素の元素記号は？');
  assert.equal(recordConflictTitle(conflict, new Map()), '回答・復習の状態');
});

test('equal counters with different review flags remain distinguishable', () => {
  const progress = { answeredCount: 1, correctCount: 1, wrongCount: 0, isReview: true, reviewLevel: 1, lastAnswerCorrect: true };
  const ordinary = describeRecordConflictValue(JSON.stringify(progress));
  const ambiguous = describeRecordConflictValue(JSON.stringify({ ...progress, isAmbiguous: true }));
  const graduated = describeRecordConflictValue(JSON.stringify({ ...progress, isGraduated: true }));
  assert.match(ordinary, /回答 1回・正解 1回・不正解 0回/u);
  assert.match(ambiguous, /あやふや/u); assert.match(graduated, /卒業/u);
  assert.notEqual(ordinary, ambiguous); assert.notEqual(ordinary, graduated);
});

test('question explanations and deletions remain visible when their prompt is identical', () => {
  const question = { question: '同じ問題文', explanation: '端末で直した解説' };
  assert.match(describeRecordConflictValue(JSON.stringify(question)), /端末で直した解説/u);
  assert.notEqual(describeRecordConflictValue(JSON.stringify(question)), describeRecordConflictValue(JSON.stringify({ ...question, explanation: 'クラウドで直した解説' })));
  assert.equal(describeRecordConflictValue(null), '削除');
});

test('a chosen version is retained only while the operation, remote revision and contents remain identical', () => {
  const previous = new Map([[conflict.key, recordConflictIdentity(conflict)]]);
  const choices = { [conflict.key]: 'local' };
  assert.deepEqual(retainRecordConflictChoices(previous, [conflict], choices), choices);
  for (const changed of [{ ...conflict, operationId: 'new-operation' },
    { ...conflict, connection: { project: 'another-project', userId: 'another-user', syncId: 'another-sync' } },
    { ...conflict, remote: { ...conflict.remote, revision: 3 } },
    { ...conflict, local: { ...conflict.local, raw: '{"answeredCount":2}' } }]) {
    assert.deepEqual(retainRecordConflictChoices(previous, [changed], choices), {});
  }
  assert.deepEqual(retainRecordConflictChoices(previous, [], choices), {});
});

const auxiliary = (id, local, remote) => ({ ...conflict, connection: { project: 'private-project', userId: 'private-user', syncId: 'private-connection' },
  key: key('localStorage', id), local: { position: 0, raw: local }, remote: { collection: 'localStorage', id, revision: 3, position: 0, raw: remote } });

test('memo conflicts identify the item and compare changed bodies even when counts are equal', () => {
  const item = auxiliary('quiz-make-creation-notes-v1', JSON.stringify([{id:'memo',title:'脳神経',body:'端末で追記',draft:false}]), JSON.stringify([{id:'memo',title:'脳神経',body:'クラウドで追記',draft:false}]));
  const before = structuredClone(item);
  assert.equal(recordConflictTitle(item, new Map()), '問題メモ');
  const comparison = compareRecordConflict(item);
  assert.equal(comparison.local, '1件のメモ'); assert.equal(comparison.remote, '1件のメモ');
  assert.deepEqual(comparison.differences, [{label:'脳神経・本文',local:'端末で追記',remote:'クラウドで追記'}]);
  assert.equal(comparison.incomplete, false); assert.deepEqual(item, before);
});

test('added and removed memo records and changed request targets remain distinguishable', () => {
  const item = auxiliary('quiz-make-creation-notes-v1', JSON.stringify([{id:'a',title:'A',body:'one'}]), JSON.stringify([{id:'b',title:'B',body:'two'}]));
  assert.deepEqual(compareRecordConflict(item).differences.slice(0,2), [{label:'A',local:'あり',remote:'なし'},{label:'B',local:'なし',remote:'あり'}]);
  const request = body => JSON.stringify([{id:'request',targets:[{targetId:'target',title:'循環器',explanation:body}]}]);
  const requestItem = auxiliary('quiz-make-explanation-requests-v1', request('端末の解説'), request('クラウドの解説'));
  assert.equal(recordConflictTitle(requestItem,new Map()),'解説の作成依頼');
  assert.ok(compareRecordConflict(requestItem).differences.some(row=>row.label==='循環器・解説'&&row.local==='端末の解説'&&row.remote==='クラウドの解説'));
});

test('known settings are named while unknown data and credential fields are not automatically revealed', () => {
  const zone = auxiliary('quizMake:studyTimeZone','Asia/Tokyo','Etc/UTC');
  assert.deepEqual(compareRecordConflict(zone).differences,[{label:'学習日のタイムゾーン',local:'Asia/Tokyo',remote:'Etc/UTC'}]);
  const unknown = auxiliary('quizMake:unrecognized',JSON.stringify({token:'private-left',password:'secret-left'}),JSON.stringify({token:'private-right',password:'secret-right'}));
  const comparison = compareRecordConflict(unknown);
  assert.deepEqual(comparison.differences,[]);assert.equal(comparison.incomplete,true);
  assert.doesNotMatch(JSON.stringify(comparison),/private-left|private-right|secret-left|secret-right/);
  assert.equal(conflictPreview('token=very-secret-value Bearer another-secret'),'token=［非表示］ Bearer ［非表示］');
  assert.equal(conflictPreview('eyJheader.payload.signature'),'［非表示］');
  assert.equal(conflictPreview('sk-proj-1234567890abcdef'),'［非表示］');
  assert.equal(conflictPreview('{"token":"hidden-value"}'),'{"token":"［非表示］"}');
});

test('truncated or unsupported differences explicitly require originals instead of suggesting equal contents', () => {
  const prefix='共通の長い本文'.repeat(100);
  const item=auxiliary('quiz-make-creation-notes-v1',JSON.stringify([{id:'m',title:'メモ',body:prefix+'端末'}]),JSON.stringify([{id:'m',title:'メモ',body:prefix+'クラウド'}]));
  const comparison=compareRecordConflict(item);assert.equal(comparison.incomplete,true);assert.ok(comparison.differences[0].local.startsWith('…'));
  assert.ok(comparison.differences[0].local.includes('端末'));assert.ok(comparison.differences[0].remote.includes('クラウド'));
  assert.notEqual(comparison.differences[0].local,comparison.differences[0].remote);
  const extra=auxiliary('quiz-make-creation-notes-v1',JSON.stringify([{id:'m',title:'メモ',body:'同じ',token:'secret'}]),JSON.stringify([{id:'m',title:'メモ',body:'同じ',token:'changed-secret'}]));
  assert.equal(compareRecordConflict(extra).incomplete,true);assert.deepEqual(compareRecordConflict(extra).differences,[]);
});

test('pre-decision exports preserve both exact originals and tombstones without connection credentials or mutations', () => {
  const item=auxiliary('quiz-make-creation-notes-v1',' [ { "id":"m", "body":"原本" } ] ',null);
  const before=structuredClone(item);const raw=exportRecordConflictOriginals(item,[item],'2026-10-04T00:00:00.000Z');
  const exported=JSON.parse(raw);assert.equal(exported.local.raw,item.local.raw);assert.equal(exported.remote.raw,null);
  assert.equal(exported.kind,'quiz-make-conflict-originals');assert.equal(exported.remote.revision,3);
  assert.doesNotMatch(raw,/private-project|private-user|private-connection|operation/);
  assert.equal(exportRecordConflictOriginals(item,[item],'2026-10-04T00:00:00.000Z'),raw);
  assert.deepEqual(item,before);
});

test('export refuses an absent, revised, edited, or differently owned candidate', () => {
  const item=auxiliary('quizMake:test','local','remote');
  for(const candidates of [[],[{...item,operationId:'new'}],[{...item,remote:{...item.remote,revision:4}}],[{...item,local:{...item.local,raw:'new'}}],[{...item,connection:{...item.connection,userId:'another-user'}}]]) {
    assert.throws(()=>exportRecordConflictOriginals(item,candidates),/内容が更新/);
  }
});

test('minimal sync states distinguish pending review, failure, offline, auth and normal progress', () => {
  const record={lastSuccessAt:'2026-10-04T00:00:00.000Z',phase:'done',pending:0,conflicts:0,staged:false,cursor:1};
  const base={online:true,loginRequired:false,error:false,autoEnabled:true,recordEnabled:true,record,pending:false,success:record.lastSuccessAt};
  assert.deepEqual(syncStatusPresentation(base),{text:'同期済み',action:null});
  assert.deepEqual(syncStatusPresentation({...base,record:{...record,pending:2}}),{text:'同期中',action:null});
  assert.deepEqual(syncStatusPresentation({...base,error:true,record:{...record,phase:'conflict',conflicts:1}}),{text:'変更の確認があります',action:null});
  assert.deepEqual(syncStatusPresentation({...base,error:true}),{text:'同期できませんでした',action:'retry'});
  assert.deepEqual(syncStatusPresentation({...base,error:true,record:{...record,phase:'conflict',conflicts:0}}),{text:'同期できませんでした',action:'retry'});
  assert.deepEqual(syncStatusPresentation({...base,online:false}),{text:'オフライン',action:null});
  assert.deepEqual(syncStatusPresentation({...base,loginRequired:true}),{text:'ログインが必要です',action:'login'});
  assert.deepEqual(syncStatusPresentation({...base,autoEnabled:false}),{text:'自動同期はOFFです',action:'retry'});
  assert.deepEqual(syncStatusPresentation({...base,record:null,success:''}),{text:'同期中',action:null});
});
