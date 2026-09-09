import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('library actions escape scrolling and animated clipping containers', () => {
  const source = readFileSync('src/components/LibraryItemActions.tsx', 'utf8');
  const css = readFileSync('src/ui-spec.css', 'utf8');
  assert.match(source, /createPortal\(<dialog/);
  assert.match(source, /document.body/);
  assert.match(source, /dialog.showModal\(\)/);
  assert.match(source, /onClose=\{\(\) => setOpen\(false\)\}/);
  assert.match(css, /library-actions__body.library-actions__dialog[^}]*max-height:[^}]*overflow-y: auto/);
});
