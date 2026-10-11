import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import {prepareLocalPublication} from '../src/utils/publicationPayload.ts';
import {normalizeMaterialReferences} from '../src/utils/materialModel.ts';
import {parsePublishedMaterials} from '../src/utils/publicationMaterials.ts';
import {planPublicImport} from '../src/utils/publicImport.ts';
const source = readFileSync(new URL('../src/utils/cloudService.ts', import.meta.url), 'utf8');
test('publishing forwards randomization and shared reads preserve it', async () => {
  const payload = prepareLocalPublication({ data: { problemSets: [{ id: 's', title: 'Test' }], questions: [{ setId: 's', choices: ['a','b','c','d'], answerIndex: 0, distractors: ['e','f'], shuffleChoices: false }] }, setId: 's', visibility: 'public', authorName: 'Test', publicationInfo: { audience: '大学入試', description: '古文単語の復習' } });
  assert.equal(payload.p_set.audience, '大学入試');
  assert.equal(payload.p_set.description, '古文単語の復習');
  assert.deepEqual(payload.p_questions[0].distractors, ['e','f']);
  assert.equal(payload.p_questions[0].shuffle_choices, false);
  const mapperSource = source.slice(source.indexOf('function mapProblemSetJson'), source.indexOf('function mapGroupJson'));
  const map = new Function('mapProblemSetRow','normalizeMaterialReferences','parsePublishedMaterials', `${stripTypeScriptTypes(mapperSource)}; return mapProblemSetJson;`)(() => ({}),normalizeMaterialReferences,parsePublishedMaterials);
  const result = map({ questions: payload.p_questions }).questions[0];
  assert.deepEqual(result.distractors, ['e','f']);
  assert.equal(result.shuffleChoices, false);
  assert.equal(map({ questions: [{ choices: [] }] }).questions[0].shuffleChoices, undefined);
});
test('copy and practice retain both fields', () => {
  const time='2026-10-11T00:00:00Z',set={id:'shared',ownerId:'owner',title:'Test',questionCount:1,questions:[{question:'Q',choices:['A','B','C','D'],answerIndexes:[0],distractors:['E','F'],shuffleChoices:false}]};
  const copy=planPublicImport({version:1,folders:[],problemSets:[],questions:[],progress:[],answerLogs:[]},[set],{newFolderName:'Imported'},time).data.questions[0];
  assert.deepEqual(copy.distractors,['E','F']);assert.equal(copy.shuffleChoices,false);
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  for (const name of ['handlePracticeSharedProblemSet']) {
    const start = app.indexOf(`const ${name}`);
    const body = app.slice(start, app.indexOf('\n  const handle', start + 1));
    assert.match(body, /distractors: question.distractors/);
    assert.match(body, /shuffleChoices: question.shuffleChoices/);
  }
});
