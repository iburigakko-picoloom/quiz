import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.endsWith('.ts') ? `${specifier}.ts` : specifier, context);
} });
const { searchLibrary } = await import('../src/utils/librarySearch.ts');
hook.deregister();
const data = { folders: [{id:'parent'}, {id:'child',parentFolderId:'parent'}], problemSets: [{id:'s',folderId:'child',title:'English'}], questions: [
  {id:'q',setId:'s',question:'question',choices:['ＡＰＰＬＥ','b','c','d','e'],category:'words',explanation:'secret',detailedExplanation:'hidden'},
  {id:'q2',setId:'s',question:'APPLE',choices:['a','b','c','d'],category:'other'},
] };
test('search normalizes queries and all choices without modifying content', () => {
  const before = JSON.stringify(data);
  const result = searchLibrary(data, ' apple ');
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[0].choiceOnly, true);
  assert.equal(result.questions[1].choiceOnly, false);
  assert.equal(JSON.stringify(data), before);
});
test('search excludes explanation-only matches and includes descendant folders', () => {
  assert.equal(searchLibrary(data, 'secret').questions.length, 0);
  assert.equal(searchLibrary(data, 'hidden').questions.length, 0);
  assert.equal(searchLibrary(data, '', 'parent', 'words').questions.length, 1);
  assert.equal(searchLibrary(data, '', 'parent', 'words').sets.length, 1);
});
