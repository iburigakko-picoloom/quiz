import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getNoteSaveErrorMessage,
  NoteLoadError,
  runAfterSuccessfulNoteFlush,
  shouldSnapshotNoteOnExit,
  waitForNoteSave,
} from '../src/components/noteExitGuard.ts';
import {
  appendByteBudgetHistory,
  ByteBudgetLruCache,
  createByteBudgetHistory,
  estimateDataUrlMemoryBytes,
  estimateRgbaPixelBytes,
  getCanvasBackingStoreSize,
  NOTE_CANVAS_PIXEL_BUDGET_BYTES,
  NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES,
  NOTE_UNDO_HISTORY_BUDGET_BYTES,
  popByteBudgetHistory,
} from '../src/components/noteMemory.ts';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const noteListSource = readSource('../src/screens/NoteListScreen.tsx');
const noteOverviewSource = readSource('../src/screens/NoteOverviewScreen.tsx');
const appSource = readSource('../src/App.tsx');

test('note list opens a dedicated category canvas and browser back waits for its flush', () => {
  assert.match(noteOverviewSource, /onClick=\{\(\) => onOpen\(category\)\}/);
  assert.doesNotMatch(noteOverviewSource, /CategoryNotePanel/);
  assert.match(appSource, /name: 'noteDetail', setId: screen.setId, category/);
  assert.match(noteListSource, /initialCategory \?\? noteCategories\[0\]/);
  assert.match(noteListSource, /registerExitGuard\?\.\(requestNoteTransition\)/);
  assert.match(appSource, /noteExitGuardRef.current\(\(\) => applyBackNavigation\(target, historySteps\)\)/);
  assert.match(appSource, /if \(!completed\) window.history.pushState/);
  assert.match(noteListSource, /requestNoteTransition\(onOpenQuestions\)/);
  const noteCss = readSource('../src/screens/NoteListScreen.css');
  const specCss = readSource('../src/ui-spec.css');
  assert.doesNotMatch(noteCss, /background: #000000|background: #202020/);
  assert.match(specCss, /\.quiz-notes \.quiz-notes__body--detail \{ display: flex/);
});
const notePanelSource = readSource('../src/components/CategoryNoteDrawer.tsx');
const quizRunnerSource = readSource('../src/screens/QuizRunner.tsx');

test('every note list exit waits for the active panel flush', () => {
  assert.match(noteListSource, /const requestNoteTransition = useCallback[\s\S]*?notePanelRef\.current\?\.flush\(\)[\s\S]*?proceed/);
  assert.match(noteListSource, /onClick=\{\(\) => void requestNoteTransition\(onBack\)\}/);
  assert.match(noteListSource, /requestNoteTransition\(\(\) => setSelectedCategory\(category\)\)/);
  assert.match(noteListSource, /requestNoteTransition\(\(\) => setSelectedCategory\(noteCategories\[0\]/);
  assert.match(noteListSource, /onClose=\{\(\) => void requestNoteTransition\(onBack\)\}/);
  assert.match(noteListSource, /if \(nextLandscape\)[\s\S]*?requestNoteTransition\(\(\) => \{[\s\S]*?setIsTabletLandscape\(false\)/);
  assert.match(noteListSource, /noteTransitionQueueRef\.current\.then\(execute, execute\)/);
  assert.match(noteListSource, /quiz-notes__transition-error" role="alert"/);
  assert.doesNotMatch(noteListSource, /onClick=\{\(\) => setSelectedCategory\(category\)\}/);
});

test('drawer close button and swipe share the guarded close request', () => {
  assert.match(notePanelSource, /const enqueuePanelTransition[\s\S]*?panelRef\.current\?\.flush\(\)[\s\S]*?drawerTransitionQueueRef\.current\.then\(execute, execute\)/);
  assert.match(notePanelSource, /const requestClose = \(\): Promise<boolean> => \{[\s\S]*?enqueuePanelTransition\(\(\) => \{[\s\S]*?setOpen\(false\)/);
  assert.match(notePanelSource, /flush: async \(\) => \{\s*await drawerTransitionQueueRef\.current;[\s\S]*?panelRef\.current\?\.flush\(\)/);
  assert.match(notePanelSource, /if \(isOpen && delta > 90\) void requestClose\(\)/);
  assert.match(notePanelSource, /onClose=\{\(\) => void requestClose\(\)\}/);
  assert.match(notePanelSource, /onClick=\{onClose\}/);
  assert.match(notePanelSource, /problemSetId === panelProblemSetId && category === panelCategory[\s\S]*?enqueuePanelTransition[\s\S]*?setPanelCategory\(latestCategoryRef\.current\)/);
  assert.doesNotMatch(notePanelSource, /isOpen && delta > 90\) setOpen\(false\)/);
});

test('flush waits for load and snapshots only a paint-ready dirty canvas', () => {
  const flushStart = notePanelSource.indexOf('const flushPendingNote = (): Promise<void> => {');
  const flushEnd = notePanelSource.indexOf('useImperativeHandle(ref, () => ({ flush: flushPendingNote }))', flushStart);
  assert.ok(flushStart >= 0 && flushEnd > flushStart, 'flush implementation should exist');
  const flushBody = notePanelSource.slice(flushStart, flushEnd);
  const loadIndex = flushBody.indexOf("noteLoadStateRef.current === 'loading'");
  const clearIndex = flushBody.indexOf('window.clearTimeout(pendingDrawSaveTimerRef.current)');
  const dirtyIndex = flushBody.indexOf('if (canvasDirtyRef.current)');
  const paintIndex = flushBody.indexOf("paintReady: notePaintStateRef.current === 'ready'");
  const snapshotIndex = flushBody.indexOf('updateCurrentPage()');
  const awaitIndex = flushBody.indexOf('await waitForNoteSave(noteSaveQueueRef.current)');
  assert.ok(loadIndex >= 0 && clearIndex > loadIndex && dirtyIndex > clearIndex);
  assert.ok(paintIndex > dirtyIndex && snapshotIndex > paintIndex && awaitIndex > snapshotIndex);
  assert.doesNotMatch(flushBody, /lastPointRef\.current = null;\s*updateCurrentPage\(\)/);
  assert.match(notePanelSource, /pendingDrawSaveTimerRef\.current = window\.setTimeout/);
  assert.match(notePanelSource, /canvasDirtyRef\.current = true/);
  assert.match(notePanelSource, /drawingRef\.current \|\| canvasDirtyRef\.current/);
  assert.match(notePanelSource, /await decodeNoteImage\(image\);[\s\S]*?context\.drawImage/);
  assert.match(notePanelSource, /function drawDataUrlToCanvas[\s\S]*?notePaintStateRef\.current = 'loading'[\s\S]*?drawDataUrlToContext[\s\S]*?renderedPageIdRef\.current = targetPageId[\s\S]*?notePaintStateRef\.current = 'ready'/);
  assert.match(notePanelSource, /const redrawCanvasFromCurrentImage = \(\) => \{\s*drawDataUrlToCanvas\(pageDataUrlRef\.current\)/);
  assert.match(notePanelSource, /const animatePageCommit[\s\S]*?persistNote\(nextNote\);[\s\S]*?rail\.addEventListener\('transitionend'/);
  assert.match(notePanelSource, /noteLoadStateRef\.current !== 'ready'[\s\S]*?notePaintStateRef\.current !== 'ready'/);
  assert.match(flushBody, /failurePhase === 'load'[\s\S]*?noteLoadStateRef\.current = 'error'/);
  assert.match(flushBody, /failurePhase === 'paint'[\s\S]*?notePaintStateRef\.current = 'error'/);
  assert.doesNotMatch(notePanelSource, /const fallback = createEmptyNote[\s\S]*?setNote\(fallback\)/);
  assert.match(notePanelSource, /role="alert"/);
});

test('quiz navigation and rotation preserve the mounted drawer until its flush succeeds', () => {
  assert.match(quizRunnerSource, /const requestNoteTransition = useCallback[\s\S]*?noteDrawerRef\.current\?\.flush\(\)[\s\S]*?proceed/);
  assert.match(quizRunnerSource, /const handleQuizBack = useCallback[\s\S]*?requestNoteTransition\(onBack\)/);
  assert.match(quizRunnerSource, /const handleNext = \(\) => \{[\s\S]*?requestNoteTransition\(\(\) => \{[\s\S]*?setCurrentIndex/);
  assert.match(quizRunnerSource, /if \(!noteFeatureEnabled && noteOpen\)[\s\S]*?drawer\.close\(\)/);
  assert.match(quizRunnerSource, /\{noteFeatureAvailable && noteDrawerMounted && setId \? \([\s\S]*?<CategoryNoteDrawer[\s\S]*?ref=\{noteDrawerRef\}/);
  assert.match(quizRunnerSource, /if \(noteFeatureEnabled\) setNoteDrawerMounted\(true\)/);
  assert.match(quizRunnerSource, /noteTransitionError[\s\S]*?role="alert"/);
  assert.doesNotMatch(quizRunnerSource, /\{noteFeatureEnabled && setId \? \([\s\S]*?<CategoryNoteDrawer/);
});

test('failed persistence blocks the requested transition', async () => {
  let proceeded = false;
  const completed = await runAfterSuccessfulNoteFlush(
    () => Promise.reject(new Error('write failed')),
    () => { proceeded = true; },
  );

  assert.equal(completed, false);
  assert.equal(proceeded, false);
  assert.equal(getNoteSaveErrorMessage(new Error('write failed')), 'ノートを保存できませんでした。もう一度お試しください。');
  assert.equal(getNoteSaveErrorMessage(new NoteLoadError()), 'ノートを読み込めませんでした。もう一度お試しください。');
});

test('an unedited, unloaded, or not-yet-decoded canvas is never snapshotted', () => {
  const ready = { loadReady: true, paintReady: true, renderedNoteMatches: true, renderedPageMatches: true };
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: false }), false);
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: true, loadReady: false }), false);
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: true, paintReady: false }), false);
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: true, renderedNoteMatches: false }), false);
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: true, renderedPageMatches: false }), false);
  assert.equal(shouldSnapshotNoteOnExit({ ...ready, dirty: true }), true);
});

test('a timeout keeps the transition blocked and a later retry can succeed', async () => {
  let proceeded = 0;
  const neverSettles = new Promise(() => {});
  const timedOut = await runAfterSuccessfulNoteFlush(
    () => waitForNoteSave(neverSettles, 5),
    () => { proceeded += 1; },
  );

  assert.equal(timedOut, false);
  assert.equal(proceeded, 0);

  let timeoutError;
  try {
    await waitForNoteSave(neverSettles, 5);
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(getNoteSaveErrorMessage(timeoutError), '保存に時間がかかっています。もう一度お試しください。');

  const retried = await runAfterSuccessfulNoteFlush(
    () => waitForNoteSave(Promise.resolve(), 5),
    () => { proceeded += 1; },
  );
  assert.equal(retried, true);
  assert.equal(proceeded, 1);
});

test('decoded note images use a strict pixel-byte LRU budget across giant pages', () => {
  const cache = new ByteBudgetLruCache(NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);
  const giantBackingStore = getCanvasBackingStoreSize(4096, 5793, 4);
  assert.ok(giantBackingStore.pixelBytes <= NOTE_CANVAS_PIXEL_BUDGET_BYTES);

  for (let page = 0; page < 12; page += 1) {
    assert.equal(cache.set(`page-${page}`, { page }, giantBackingStore.pixelBytes), true);
    assert.ok(cache.byteSize <= NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);
    assert.ok(cache.size <= 1, 'only one full-budget decoded page may remain resident');
  }

  const giantPageBytes = estimateRgbaPixelBytes(4096, 4096);
  assert.equal(cache.set('oversized-page', {}, giantPageBytes), false);
  assert.equal(cache.peek('oversized-page'), undefined);
  assert.ok(cache.byteSize <= NOTE_DECODED_IMAGE_CACHE_BUDGET_BYTES);
  assert.doesNotMatch(notePanelSource, /NOTE_IMAGE_CACHE_LIMIT|MAX_HISTORY/);
});

test('high-DPR giant canvases are capped without changing their logical drawing area', () => {
  const logicalWidth = 4096;
  const logicalHeight = 5793;
  const backingStore = getCanvasBackingStoreSize(logicalWidth, logicalHeight, 4);

  assert.ok(backingStore.pixelBytes <= NOTE_CANVAS_PIXEL_BUDGET_BYTES);
  assert.ok(backingStore.width < logicalWidth * 4);
  assert.ok(backingStore.height < logicalHeight * 4);
  assert.equal(backingStore.scaleX, backingStore.width / logicalWidth);
  assert.equal(backingStore.scaleY, backingStore.height / logicalHeight);
  assert.match(notePanelSource, /context\.setTransform\(backingStore\.scaleX, 0, 0, backingStore\.scaleY/);
});

test('undo keeps only the newest snapshots that fit its memory budget', () => {
  const entryBytes = 10 * 1024 * 1024;
  let history = createByteBudgetHistory();
  for (let page = 0; page < 10; page += 1) {
    history = appendByteBudgetHistory(history, `page-${page}`, entryBytes, NOTE_UNDO_HISTORY_BUDGET_BYTES);
    assert.ok(history.byteSize <= NOTE_UNDO_HISTORY_BUDGET_BYTES);
  }

  assert.deepEqual(history.entries.map((entry) => entry.value), ['page-8', 'page-9']);
  const popped = popByteBudgetHistory(history);
  assert.equal(popped.value, 'page-9');
  assert.deepEqual(popped.history.entries.map((entry) => entry.value), ['page-8']);

  const oversized = appendByteBudgetHistory(
    history,
    'cannot-fit',
    NOTE_UNDO_HISTORY_BUDGET_BYTES + 1,
    NOTE_UNDO_HISTORY_BUDGET_BYTES,
  );
  assert.equal(oversized.byteSize, 0);
  assert.equal(oversized.entries.length, 0, 'Undo must not skip over an unrecorded action');
  assert.ok(estimateDataUrlMemoryBytes('data:image/png;base64,AAAA') > 'data:image/png;base64,AAAA'.length);
});
