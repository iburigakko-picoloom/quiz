import { GroupTimeline } from './GroupTimeline';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import type { CloudGroup, CloudGroupMember, CloudProblemSet } from '../utils/cloudService';
import { importedLearning, levelPercentages, sortLearningMembers, type GroupLearningMember } from '../utils/groupLearning';
import {groupStudyCandidates} from '../utils/groupStudySource';
import { buildGroupLibrary, groupFolderSets, type GroupFolderCardData } from '../utils/groupLibrary';
import type { MaterialProgress, GroupLearningSnapshot } from '../utils/groupLearningService';
import { ChevronRightIcon, PlusIcon } from './UiIcons';
import { GroupEmpty, LevelProgress, MemberAvatar, displayGroupDate } from './GroupLearningUi';
import {LibraryPane} from './LibraryPane';
import {LibraryContentRow} from './LibraryContentRow';

export type GroupDetailTab = 'timeline' | 'overview' | 'folders' | 'members';
export function GroupWorkspace({ data, group, sets, members, userId, snapshot, loading, error, tab, onTab, folderTrail, onFolderTrail, onOpenSet, onAddSet, onAddFolder, onRefresh, onRemoveMember, onImportFolder,onManageFolder,onRemoveSet,busy,materials,onOpenProgress }: {
  data: AppData; group?: CloudGroup; sets: CloudProblemSet[]; members: CloudGroupMember[]; userId: string; snapshot: GroupLearningSnapshot | null;
  loading: boolean; error: string; tab: GroupDetailTab; onTab: (tab: GroupDetailTab) => void; folderTrail: string[]; onFolderTrail: (trail: string[]) => void;
  onOpenSet: (set: CloudProblemSet, location: string) => void; onAddSet: (folder: GroupFolderCardData) => void; onAddFolder: () => void; onSettings: () => void; onRefresh: () => void; onRemoveMember: (member: CloudGroupMember) => void; busy: boolean;
  materials?: MaterialProgress[]; onOpenProgress?: (set: CloudProblemSet) => void;
  onImportFolder?: (folder:GroupFolderCardData)=>void;
  onManageFolder?: (folder:GroupFolderCardData)=>void;
  onRemoveSet?: (set:CloudProblemSet)=>void;
}) {
  const [sort, setSort] = useState<'today' | 'week' | 'l3'>('today');
  const workspaceRef = useRef<HTMLElement>(null);
  const folderKey = folderTrail.join('|');
  const previousFolderKey=useRef(folderKey);
  useEffect(() => {
    (workspaceRef.current?.closest('.community-screen--group-workspace') ?? workspaceRef.current?.closest('.app-layout__scroll'))?.scrollTo({ top: 0 });
    if(tab==='folders'&&previousFolderKey.current!==folderKey)workspaceRef.current?.querySelector<HTMLElement>('#group-panel-folders h2')?.focus({preventScroll:true});
    previousFolderKey.current=folderKey;
  }, [tab, folderKey]);
  const folders = useMemo(() => buildGroupLibrary(sets, snapshot), [sets, snapshot]);
  const trail: GroupFolderCardData[] = [];
  let children = folders;
  for (const key of folderTrail) { const folder = children.find(f => f.key === key); if (!folder) break; trail.push(folder); children = folder.children; }
  const current = trail[trail.length - 1];
  const canManage = group?.role === 'owner' || group?.role === 'admin';
  const folderActions = (folder: GroupFolderCardData) => folder.key !== 'unfiled' && onManageFolder && (canManage || folder.createdBy === userId)
    ? <button type="button" className="group-library-menu" aria-label={`${folder.name}の管理`} disabled={busy || loading || !snapshot} onClick={() => onManageFolder(folder)}>…</button> : null;
  const learningMembers: GroupLearningMember[] = snapshot?.members ?? members.map(member => ({ ...member, levels: null, todayCount: null, weekCount: null, importedSetCount: 0, sharedSetCount: 0 }));
  const sorted = sortLearningMembers(learningMembers.filter(member => member.levels !== null && member.sharedSetCount > 0), sort);
  const renderFolder = (folder: GroupFolderCardData, parent = folderTrail) => {
    const contents = groupFolderSets(folder);
    return <LibraryContentRow key={folder.key} title={folder.name} folder sets={contents.length} questions={contents.reduce((sum,set)=>sum+set.questionCount,0)} disabled={busy} onOpen={()=>{onTab('folders');onFolderTrail([...parent,folder.key]);}} actions={folderActions(folder)}/>;
  };
  return <section ref={workspaceRef} className="group-workspace" aria-label="グループ詳細">
    <div className="group-workspace__tabs" role="tablist" aria-label="グループの表示">{([['timeline', 'タイムライン'], ['folders', 'フォルダ'], ['members', 'メンバー'], ['overview', '概要']] as const).map(([value, label]) => <button type="button" id={`group-tab-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`group-panel-${value}`} tabIndex={tab === value ? 0 : -1} onKeyDown={event => {
      const tabs: GroupDetailTab[] = ['timeline', 'folders', 'members', 'overview']; const i = tabs.indexOf(value);
      const next = event.key === 'ArrowRight' ? tabs[(i + 1) % 4] : event.key === 'ArrowLeft' ? tabs[(i + 3) % 4] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[3] : null;
      if (next) { event.preventDefault(); onTab(next); document.getElementById(`group-tab-${next}`)?.focus(); }
    }} onClick={() => onTab(value)}>{label}</button>)}</div>
    <div className="group-workspace__content">
      {error ? <div className="group-error" role="alert">{error}<button type="button" onClick={onRefresh}>再読み込み</button></div> : null}
      {loading ? <p className="group-muted" role="status">グループの集計を読み込み中…</p> : null}
      <section id="group-panel-overview" role="tabpanel" aria-labelledby="group-tab-overview" hidden={tab !== 'overview'}>
        <h2>教材ごとの学習状況</h2>

        <div className="group-material-list">{sets.map(set => {
          const remote = materials?.find(row => row.setId === set.id && row.versionId === set.versionId);
          const candidates = groupStudyCandidates(data, set, userId);
          const local = candidates.find(row => row.id === remote?.ownCopyId) ?? candidates[0];
          const own = local && set.versionId ? importedLearning(data, local, set.id, set.versionId) : null;
          return <button type="button" className="group-panel group-material-card" key={set.id} disabled={busy} onClick={() => onOpenProgress?.(set)}>
            <h3>{set.title} <ChevronRightIcon size={18} aria-hidden="true" /></h3>
            <p>学習中 {remote ? `${remote.learners}人（共有中）` : '—'}</p>
            <p>自分の進捗：{own ? `回答済み ${own.answered} / ${own.total}問・回答率 ${Math.round(own.answered / own.total * 100)}%` : '—'}</p>
            {own ? <LevelProgress levels={own.levels} compact label="自分の理解度" /> : null}
            <small>自分の最終反映：{remote?.ownState === 'shared' ? displayGroupDate(remote.ownReflectedAt ?? '') : remote ? ({not_shared:'未共有',update_pending:'公開版の更新待ち',reflection_pending:'反映待ち'}[remote.ownState] ?? '—') : '取得待ち'}</small>
          </button>;
        })}</div>
        {!sets.length && !loading ? <GroupEmpty>共有教材はまだありません。</GroupEmpty> : null}
      </section>
      <section id="group-panel-timeline" role="tabpanel" aria-labelledby="group-tab-timeline" hidden={tab !== 'timeline'}>
        {tab === 'timeline' && group ? <GroupTimeline groupId={group.id} groupName={group.name} userId={userId} sets={sets} onOpenProgress={onOpenProgress}/> : null}
      </section>
      <section id="group-panel-folders" role="tabpanel" aria-labelledby="group-tab-folders" hidden={tab !== 'folders'}>
        <LibraryPane viewKey={folderKey} depth={folderTrail.length}>
        {current ? <nav className="group-breadcrumb" aria-label="フォルダの位置"><button type="button" onClick={() => onFolderTrail([])}>フォルダ</button>{trail.map((folder, i) => <span key={folder.key}> / <button type="button" aria-current={i === trail.length - 1 ? 'page' : undefined} onClick={() => onFolderTrail(folderTrail.slice(0, i + 1))}>{folder.name}</button></span>)}</nav> : null}
        <div className="group-panel__heading group-list-heading"><div><h2 tabIndex={-1}>{current?.name ?? 'フォルダ'}</h2>{current?<p className="group-folder-stats">{groupFolderSets(current).length}セット · {groupFolderSets(current).reduce((sum,set)=>sum+set.questionCount,0).toLocaleString('ja-JP')}問</p>:null}</div>
          {current ? <div className="group-library-actions"><button type="button" className="group-secondary" disabled={busy || !snapshot} onClick={() => onAddSet(current)}><PlusIcon size={18} />問題セットを追加</button>{folderActions(current)}</div> : canManage ? <button type="button" className="group-add-folder" aria-label="フォルダを追加" disabled={busy || !snapshot} onClick={onAddFolder}><PlusIcon size={20} aria-hidden="true" /></button> : null}
        </div>
        {current&&onImportFolder?<button type="button" className="group-primary group-folder-import" disabled={busy||loading||!groupFolderSets(current).length} onClick={()=>onImportFolder(current)}>フォルダごと取り込む</button>:null}
        <div className="group-folder-list">{(current ? current.children : folders).map(folder => renderFolder(folder))}</div>
        {current ? <div className="group-set-list">{current.sets.map(set => <LibraryContentRow key={set.id} title={set.title} questions={set.questionCount} subtitle={set.importCount===undefined?undefined:`${set.importCount}人が取り込み`} disabled={busy} onOpen={()=>onOpenSet(set,trail.map(folder=>folder.name).join(' / '))} actions={onRemoveSet && (canManage || set.ownerId === userId) ? <button type="button" className="group-library-menu" aria-label={`${set.title}の管理`} disabled={busy || loading} onClick={()=>onRemoveSet(set)}>…</button> : null}/>)}{!current.sets.length && !current.children.length ? <GroupEmpty>問題セットはまだありません。</GroupEmpty> : null}</div> : !folders.length && !loading ? <GroupEmpty>フォルダはまだありません。</GroupEmpty> : null}
        {current?<details className="library-info"><summary>フォルダ情報</summary><p>作成者：{current.createdBy===userId?'あなた':current.creatorName}</p><p>更新：{displayGroupDate(current.updatedAt)}{current.importCount===null?'':` · ${current.importCount}人が取り込み`}</p></details>:null}
        </LibraryPane>
      </section>
      <section id="group-panel-members" role="tabpanel" aria-labelledby="group-tab-members" hidden={tab !== 'members'}>
        <div className="group-panel group-member-panel"><h2>メンバー</h2>
        <div className="group-member-list">{members.map(member => <article className="group-member-card" key={member.userId}><div className="group-member-card__identity"><MemberAvatar name={member.displayName} userId={member.userId} self={member.userId === userId}/><strong>{member.userId === userId ? 'あなた' : member.displayName}</strong><span className="group-member-card__role">{member.role === 'owner' ? 'オーナー' : member.role === 'admin' ? '管理者' : 'メンバー'}</span></div></article>)}</div></div>
        <details><summary>共有された学習統計</summary><div className="group-segment" aria-label="メンバーの並び順">{([['today', '今日'], ['week', '今週'], ['l3', 'L3']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => setSort(value)}>{label}</button>)}</div>
        <div className="group-member-list">{sorted.map((member, i) => <article className="group-member-stat-card" key={member.userId}>
          <div className="group-member-card__identity"><span className={`group-rank group-rank--${i}`}>{i + 1}</span><MemberAvatar name={member.displayName} userId={member.userId} self={member.userId === userId} /><span><strong>{member.userId === userId ? 'あなた' : member.displayName}</strong>{member.role === 'owner' ? <small className="group-owner-badge">オーナー</small> : null}</span></div>
          <dl className="group-member-card__stats"><div><dt>今日</dt><dd>{member.todayCount === null ? '—' : `${member.todayCount}問`}</dd></div><div><dt>今週</dt><dd>{member.weekCount === null ? '—' : `${member.weekCount}問`}</dd></div><div><dt>教材</dt><dd>{snapshot ? `${member.importedSetCount}セット` : '—'}</dd></div><div><dt>L3</dt><dd>{member.levels ? `${levelPercentages(member.levels)[3]}%` : '—'}</dd></div></dl>
        </article>)}</div></details>
        {canManage ? <details className="group-member-management"><summary>メンバーを管理</summary>{members.filter(member => member.role !== 'owner' && member.userId !== userId).map(member => <div key={member.userId}><span>{member.displayName}</span><button type="button" disabled={busy} onClick={() => onRemoveMember(member)}>メンバーから外す</button></div>)}</details> : null}
      </section>
    </div>
  </section>;
}
