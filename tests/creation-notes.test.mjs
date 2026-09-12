import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const create = read('../src/screens/CreateProblemSetScreen.tsx');
const notes = read('../src/screens/CreationNotes.tsx');

test('creation entry contains AI and notes, with copy moved to set actions', () => {
  const chooser = create.slice(create.indexOf('function MethodChooser'), create.indexOf('function SetMetaFields'));
  assert.match(chooser, /生成AIで作る/);
  assert.match(chooser, /苦手メモ/);
  assert.match(chooser, /icon: <WeaknessMemoIcon/);
  assert.match(chooser, /icon: <AiCreationIcon/);
  assert.doesNotMatch(chooser, /既存問題セット|CSV|ファイルを読み込む/);
  assert.match(read('../src/screens/ProblemSetDetailScreen.tsx'), /onClick=\{onCopy\}>問題セットをコピー/);
  assert.match(create, /JSONファイルを選ぶ/);
  assert.match(create, /jsonFileRef.current\?\.click\(\)/);
  assert.match(create, /await file.text\(\)/);
  assert.match(create, /hidden=\{aiMethod !== 'material'\}/);
  assert.doesNotMatch(create, /handleCsvFile|csvInputRef/);
});

test('notes persist edits, guard save failures and copy before opening import', () => {
  assert.match(notes, /readWeaknessNotes/);
  assert.match(notes, /changeWeaknessNotes/);
  assert.match(notes, /onDirtyChange\(failed\|\|busy/);
  assert.match(notes, /window\.confirm/);
  assert.match(notes, /await writeClipboardText/);
  assert.doesNotMatch(notes, /自由メモ|生成AIで問題化|creation-note-add/);
  assert.match(create, /view === 'notes' \? <div/);
  assert.match(create, /notesBackRef\.current\?\.\(\)/);
  assert.doesNotMatch(create, /creation-note-add/);
  assert.match(notes, /選んだメモから問題を作る/);
  assert.match(notes, /makeExplanationRequest\(picked,data\)/);
  assert.match(create, /memoContext/);
  assert.match(create, /メモの誤解を正解として採用しない/);
});
