import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const homeSource = readSource('../src/screens/HomeScreen.tsx');
const homeCss = readSource('../src/screens/HomeScreen.css');
const settingsSource = readSource('../src/screens/SettingsScreen.tsx');
const createSource = readSource('../src/screens/CreateProblemSetScreen.tsx');
const detailSource = readSource('../src/screens/ProblemSetDetailScreen.tsx');
const appSource = readSource('../src/App.tsx');
const typesSource = readSource('../src/types.ts');
const syncSource = readSource('../src/screens/SyncScreen.tsx');
const globalCss = readSource('../src/index.css');
const layoutSource = readSource('../src/components/Layout.tsx');
const createCss = readSource('../src/screens/CreateProblemSetScreen.css');
const communitySource = readSource('../src/screens/CommunityScreen.tsx');
const communityCss = readSource('../src/screens/CommunityScreen.css');
const quizRunnerSource = readSource('../src/screens/QuizRunner.tsx');
const resultSource = readSource('../src/screens/ResultScreen.tsx');
const resultCss = readSource('../src/screens/ResultScreen.css');
const noteDrawerSource = readSource('../src/components/CategoryNoteDrawer.tsx');
const nativePlatformSource = readSource('../src/utils/nativePlatform.ts');

test('creation methods do not single out the first option with a tinted frame', () => {
  const theme = readSource('../src/ui-spec.css');
  assert.doesNotMatch(theme, /\.create-set__methods\s*>\s*button:first-child/);
  assert.match(createCss, /\.create-set__method\s*\{[^}]*background:\s*#fff/);
});

test('problem-set creation uses a direct, concise JSON entry', () => {
  assert.match(createSource, /title: '生成AIで作る'/);
  assert.match(createSource, /'JSONを読み取る'/);
  assert.match(createSource, /CHATGPT_MATERIAL_TEMPLATE_PROMPT/);
  assert.match(createSource, /CHATGPT_PAST_EXAM_TEMPLATE_PROMPT/);
  assert.match(createSource, /writeClipboardText/);
  assert.match(createSource, /<span>1<\/span>問題を作る/);
  assert.match(createSource, /<span>2<\/span>JSONを取り込む/);
  assert.match(createSource, /aiStep === 1/);
  assert.match(createSource, /aiStep === 2/);
  assert.match(createSource, /依頼文をコピー/);
  assert.match(createSource, /PdfPromptFlow pdfLabel="資料PDF"/);
  assert.match(createSource, /PdfPromptFlow pdfLabel="過去問PDF"/);
  assert.match(createSource, /プロンプトをコピー/);
  assert.match(createSource, /生成AIに貼り付け/);
  assert.match(createSource, /コピーしました/);
  assert.match(nativePlatformSource, /navigator\.clipboard\?\.writeText/);
  assert.match(nativePlatformSource, /document\.execCommand\('copy'\)/);
  assert.doesNotMatch(createSource, /指示文をコピー|資料から問題を作る|過去問をまとめる/);
  assert.doesNotMatch(createSource, /title: '1問ずつ作る'|title: 'まとめて貼り付ける'/);
  assert.doesNotMatch(createSource, /placeholder=/);
  assert.doesNotMatch(settingsSource, /ChatGPTで問題を作る|資料から問題を作る|過去問をまとめる/);
  assert.doesNotMatch(homeSource, /ChatGPTで問題を作る|quiz-home__menu-button/);
});

test('discovery and group screens remove redundant copy explanations', () => {
  assert.doesNotMatch(communitySource, /追加すると自分用の独立したコピーになります/);
  assert.doesNotMatch(communitySource, /placeholder=/);
  assert.match(communitySource, /グループ詳細/);
  assert.match(communitySource, /community-group-folder-list/);
  assert.match(communitySource, /role="tablist" aria-label="グループの表示"/);
  assert.match(communitySource, /hidden=\{groupDetailTab !== 'members'\}/);
  assert.match(communitySource, /自分のフォルダにコピー/);
});

test('shared layout scrolls long screens and create actions never float over form controls', () => {
  assert.match(layoutSource, /overflow-y-auto/);
  assert.doesNotMatch(layoutSource, /flex-col overflow-hidden/);
  assert.match(createCss, /\.create-set \{[^}]*flex:\s*0 0 auto[^}]*padding:\s*0/);
  assert.match(createCss, /\.create-set::after \{[^}]*height:\s*calc\(var\(--primary-nav-height\) \+ var\(--safe-bottom\) \+ 24px\)/);
  assert.match(createCss, /\.create-set__save-bar \{[^}]*position:\s*static/);
  assert.doesNotMatch(createCss, /\.create-set__save-bar \{[^}]*bottom:/);
  assert.match(createSource, /reviewedDrafts\.length > 0 \? <SaveBar/);
});

test('folder creation dialog is portaled above the fixed primary navigation', () => {
  assert.match(homeSource, /import \{ createPortal \} from 'react-dom'/);
  assert.match(homeSource, /return createPortal\([\s\S]*?quiz-home__overlay[\s\S]*?document\.body/);
  assert.match(homeCss, /\.quiz-home__sheet-button \{[^}]*background:\s*var\(--ui-surface-muted/);
  assert.match(homeCss, /\.quiz-home__sheet-button--primary \{[^}]*background:\s*var\(--ui-accent/);
});

test('community dialogs stay above navigation and support keyboard focus', () => {
  assert.match(communitySource, /return createPortal\(/);
  assert.match(communitySource, /event\.key === 'Escape'/);
  assert.match(communitySource, /event\.key !== 'Tab'/);
  assert.match(communitySource, /previouslyFocused\?\.focus\(\)/);
  assert.match(communityCss, /\.community-overlay \{[^}]*z-index:\s*100100/);
});

test('tablet note behavior and styles share the 768px landscape boundary', () => {
  assert.match(quizRunnerSource, /TABLET_LANDSCAPE_QUERY = '\(min-width: 768px\) and \(orientation: landscape\)'/);
  assert.match(globalCss, /@media \(min-width: 768px\) and \(orientation: landscape\) \{[\s\S]*?body\.quiz-note-open \.quiz-runner__answer-actions/);
});

test('primary headers share one height and create returns to its launch context', () => {
  assert.match(globalCss, /\.quiz-home__header \{[\s\S]*?height:\s*calc\(72px \+ var\(--safe-top\)\)/);
  assert.match(createCss, /min-height:\s*calc\(72px \+ var\(--safe-top\)\)/);
  assert.match(globalCss, /--app-header-height:\s*72px/);
  assert.match(globalCss, /\.quiz-runner \.quiz-runner__header/);
  assert.match(createSource, /onBack \? <BackButton onClick=\{onBack\} label="前の画面へ戻る" \/> : null/);
  assert.match(appSource, /backScreen:\s*\{ name: 'folder', folderId \}/);
  assert.match(appSource, /backScreen:\s*\{ name: 'problemSetDetail', setId: screen\.setId \}/);
  assert.match(appSource, /onBack=\{createBackScreen \? \(\) => goBackTo\(createBackScreen\) : undefined\}/);
  assert.match(typesSource, /name: 'createProblemSet';[^{\n]*backScreen\?: AppScreen/);
});

test('review starts only from its problem set and the global review route is gone', () => {
  assert.doesNotMatch(homeSource, /onOpenReview|quiz-home__review-card/);
  assert.doesNotMatch(appSource, /name: 'review'/);
  assert.doesNotMatch(typesSource, /name: 'review'/);
  assert.match(detailSource, /buildReviewQuestions\(data, questions\)/);
  assert.equal((detailSource.match(/reviewLevel: reviewFilter/g) ?? []).length, 2);
  assert.equal((detailSource.match(/onStartSession\(\{/g) ?? []).length, 2);
  assert.doesNotMatch(detailSource, /onClick=\{startReview\}/);
});

test('sync screen uses an eight-character pairing flow and keeps recovery details collapsed', () => {
  assert.match(syncSource, /この端末で同期を始める/);
  assert.match(syncSource, /別の端末を追加/);
  assert.match(syncSource, /接続コードを表示/);
  const comparisonSource = readSource('../src/components/SyncComparison.tsx');
  assert.match(syncSource, /<SyncComparison/);
  assert.match(comparisonSource, /端末 → クラウドに同期/);
  assert.match(comparisonSource, /クラウド → 端末に読み込む/);
  assert.match(comparisonSource, /saveBackupPayload\(local,'before-sync'\)/);
  assert.match(comparisonSource, /remote.value\?\.updatedAt !== pending.remote\?\.updatedAt/);
  assert.match(syncSource, /<details className="sync-advanced">/);
  assert.match(syncSource, /復旧用の同期ID/);
  assert.match(syncSource, /setStoredSyncId\(''\)/);
  assert.match(syncSource, /同期接続を解除しました/);
  assert.match(syncSource, /getPendingLegacySyncUpgrade\(\)/);
  assert.match(syncSource, /resumePendingLegacySyncUpgrade\(\)/);
  assert.match(syncSource, /現在の同期先は変更せず、移行先への切り替えを確認します/);
  assert.doesNotMatch(syncSource, /Supabase設定済み|VITE_SUPABASE_URL/);
});

test('sync id edits stay as a draft until the user explicitly connects', () => {
  const draftHandler = syncSource.match(/const updateSyncIdDraft = \(value: string\) => \{([\s\S]*?)\n  \};/);
  assert.ok(draftHandler, 'draft handler should exist');
  assert.match(draftHandler[1], /setSyncId\(value\)/);
  assert.doesNotMatch(draftHandler[1], /setStoredSyncId/);
  assert.match(syncSource, /const applyConnectedSyncId[\s\S]*?setStoredSyncId\(normalizedNextId\)/);
  assert.match(syncSource, /['"]このIDへ接続['"]/);
  assert.match(syncSource, /if \(!autoEnabled && \(!configured \|\| !syncIdConnected\)\)/);
  assert.match(syncSource, /disabled=\{!autoEnabled && \(!configured \|\| !authenticated \|\| !syncIdConnected\)\}/);
  assert.match(syncSource, /同期にはログインが必要です/);
  assert.match(syncSource, /sendMagicLink\(normalizedEmail, \{ name: 'sync' \}\)/);
});

test('legacy upgrade reconciliation never overwrites a connection changed by another tab', () => {
  const legacyHandler = syncSource.match(/const handleUpgradeLegacySyncId = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(legacyHandler, 'legacy upgrade handler should exist');
  assert.match(legacyHandler[1], /getStoredSyncId\(\)\.trim\(\) !== result\.value\.syncId/);
  assert.match(legacyHandler[1], /setLastSyncStateForConnection\(result\.value\.syncId/);
  assert.doesNotMatch(legacyHandler[1], /setStoredSyncId\(result\.value\.syncId\)/);
});

test('result actions do not overlay landscape stats and labels render as Japanese', () => {
  assert.match(resultCss, /\.result-actions \{[^}]*position:\s*static/);
  assert.match(resultCss, /@media \(min-width: 700px\) and \(orientation: landscape\)[\s\S]*?grid-template-columns:\s*repeat\(4,/);
  assert.doesNotMatch(resultSource, /(?:aria-label|label|title)="\\u[0-9a-fA-F]{4}/);
  assert.doesNotMatch(noteDrawerSource, /(?:aria-label|label|title)="\\u[0-9a-fA-F]{4}/);
});

test('folder and problem-set rows are visually separated into individual cards', () => {
  const individualCardCss = globalCss.slice(globalCss.lastIndexOf('.quiz-home__folder-card,'));
  assert.match(globalCss, /\.quiz-home__folder-card,[\s\S]{0,260}border:\s*1px solid var\(--ui-border\)/);
  assert.match(individualCardCss, /border-radius:\s*12px/);
  assert.match(individualCardCss, /box-shadow:\s*none/);
});
