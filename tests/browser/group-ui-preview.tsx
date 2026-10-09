import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupWorkspace, type GroupDetailTab } from '../../src/components/GroupWorkspace';
import { SharedSetDetail } from '../../src/components/SharedSetDetail';
import { ImportedMemberProgress } from '../../src/components/GroupLearningUi';
import { Layout } from '../../src/components/Layout';
import { BackButton } from '../../src/components/BackButton';
import { PrimaryBottomNav } from '../../src/components/PrimaryBottomNav';
import { previewData, previewGroup, previewSets, previewSnapshot } from '../fixtures/group-learning';
import type { CloudProblemSet } from '../../src/utils/cloudService';
import '../../src/screens/CommunityScreen.css';
import '../../src/index.css';
import '../../src/ui-spec.css';
import '../../src/final-reference.css';
import '../../src/group-ui.css';

function Preview() {
  const [tab, setTab] = useState<GroupDetailTab>('overview');
  const [trail, setTrail] = useState<string[]>([]);
  const [set, setSet] = useState<CloudProblemSet | null>(null);
  const [location, setLocation] = useState('');
  const [notice, setNotice] = useState('');
  return <><Layout><div className="community-screen community-screen--group-workspace"><header className="community-screen__header"><BackButton onClick={() => set ? setSet(null) : trail.length ? setTrail(trail.slice(0,-1)) : setTab('overview')} /><h1>{set?.title ?? previewGroup.name}</h1><div className="community-group-header-actions"><button type="button" className="community-group-invite" onClick={() => setNotice('招待コードの発行は本番画面で行います。')}>招待</button></div></header>
    {notice ? <div className="community-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')}>閉じる</button></div> : null}
    <main className="community-screen__body">{set ? <SharedSetDetail set={set} location={`${location} / ${previewGroup.name}`} busy={false} onCopy={() => setNotice('このプレビューでは取り込みを行いません。')} onPractice={() => setNotice('このプレビューでは学習履歴を記録しません。')} onReport={() => setNotice('このプレビューでは報告を送信しません。')} progress={<section className="group-panel"><div className="group-panel__heading"><h2>取り込んだ人の進捗</h2></div><ImportedMemberProgress members={previewSnapshot.members.slice(0,5).map(member => ({ userId: member.userId, name: member.displayName, levels: member.levels }))} /></section>} /> : <GroupWorkspace data={previewData} group={previewGroup} sets={previewSets} members={previewSnapshot.members} userId="you" snapshot={previewSnapshot} loading={false} error="" tab={tab} onTab={setTab} folderTrail={trail} onFolderTrail={setTrail} onOpenSet={(value, path) => { setSet(value); setLocation(path); }} onAddSet={() => setNotice('本番画面では、自分の問題セットを選んでこのフォルダに追加します。')} onAddFolder={() => setNotice('本番画面では、フォルダ名を入力して追加します。')} onSettings={() => setNotice('本番画面ではアイコンの種類と色を変更できます。')} onRefresh={() => {}} onRemoveMember={() => {}} busy={false} />}</main>
  </div></Layout><PrimaryBottomNav active="groups" onSelect={() => setNotice('グループ画面のUI確認用プレビューです。')} /></>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
