import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommunityScreen } from '../../src/screens/CommunityScreen';
import { PrimaryBottomNav } from '../../src/components/PrimaryBottomNav';
import { previewData } from '../fixtures/group-learning';
import '../../src/index.css';
import '../../src/ui-spec.css';
import '../../src/final-reference.css';
import '../../src/group-ui.css';

const data = { ...previewData, problemSets: [{ id: 'new-local-set', folderId: 'local-folder', title: '追加用セット', source: '', audience: '授業対策', description: '授業の確認用問題', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }], questions: [{ id: 'new-local-question', setId: 'new-local-set', question: 'プレビュー問題', choices: ['A','B','C','D'] as [string,string,string,string], answerIndex: 0, answerText: 'A', explanation: '', sourcePage: '', category: '', difficulty: 'basic' as const, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }] };
const publicationScenario = new URLSearchParams(location.search).has('publication');
const publicationSets = ['通信失敗セット', '再起動セット', '後続セット'].map((title, i) => ({ ...data.problemSets[0], id: `publication-local-${i}`, title }));
const publicationData = { ...data, folders: [{ id: 'local-folder', name: '公開検証フォルダ', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }], problemSets: publicationSets,
  questions: publicationSets.flatMap((set, i) => Array.from({ length: [300, 600, 4][i] }, (_, q) => ({ ...data.questions[0], id: `${set.id}-q-${q}`, setId: set.id, question: `合成テスト問題 ${q}` }))) };
// Mounted only on the isolated server started by group-community-validation.mjs.
const enabled = import.meta.env.VITE_SUPABASE_URL === 'https://group-preview.example.test';
createRoot(document.getElementById('root')!).render(enabled ? <><CommunityScreen data={publicationScenario ? publicationData : data} initialTab="groups" initialGroupId="preview-group" onGroupPage={() => {}} onBack={() => {}} onManageShares={() => {}} onCreateProblemSet={() => {}} onOpenGroup={() => {}} onOpenLocalSet={() => {}} onCopySharedSet={async () => null} onPracticeSharedSet={() => {}} onPublished={async id => { const applied = JSON.parse(localStorage.getItem('publication-preview-applied') ?? '[]'); localStorage.setItem('publication-preview-applied', JSON.stringify([...applied, id])); }} onUnpublished={async () => {}} /><PrimaryBottomNav active="groups" onSelect={() => {}} /></> : <p>この画面は隔離したブラウザテスト専用です。</p>);
