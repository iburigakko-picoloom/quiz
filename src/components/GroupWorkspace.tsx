import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import { indexProgress } from '../utils/quiz';
import type { CloudGroup, CloudGroupMember, CloudProblemSet } from '../utils/cloudService';
import { importedLearning, levelPercentages, sortLearningMembers, sumLevels, type GroupLearningMember, type LevelCounts } from '../utils/groupLearning';
import { buildGroupLibrary, groupFolderSets, type GroupFolderCardData } from '../utils/groupLibrary';
import type { GroupLearningSnapshot } from '../utils/groupLearningService';
import { ChevronRightIcon, FolderOutlineIcon, PlusIcon, ProblemSetIcon, SettingsIcon } from './UiIcons';
import { GroupAvatar, GroupEmpty, LevelProgress, MemberAvatar, SharedFolderCard, displayGroupDate } from './GroupLearningUi';
import {LibraryPane} from './LibraryPane';

export type GroupDetailTab = 'overview' | 'folders' | 'members';
export function GroupWorkspace({ data, group, sets, members, userId, snapshot, loading, error, tab, onTab, folderTrail, onFolderTrail, onOpenSet, onAddSet, onAddFolder, onSettings, onRefresh, onRemoveMember, busy }: {
  data: AppData; group?: CloudGroup; sets: CloudProblemSet[]; members: CloudGroupMember[]; userId: string; snapshot: GroupLearningSnapshot | null;
  loading: boolean; error: string; tab: GroupDetailTab; onTab: (tab: GroupDetailTab) => void; folderTrail: string[]; onFolderTrail: (trail: string[]) => void;
  onOpenSet: (set: CloudProblemSet, location: string) => void; onAddSet: (folder: GroupFolderCardData) => void; onAddFolder: () => void; onSettings: () => void; onRefresh: () => void; onRemoveMember: (member: CloudGroupMember) => void; busy: boolean;
}) {
  const [scope, setScope] = useState<'all' | 'self'>('all');
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
  const countFolders = (rows: GroupFolderCardData[]): number => rows.reduce((count, folder) => count + (folder.key === 'unfiled' ? 0 : 1) + countFolders(folder.children), 0);
  const folderCount = countFolders(folders);
  const trail: GroupFolderCardData[] = [];
  let children = folders;
  for (const key of folderTrail) { const folder = children.find(f => f.key === key); if (!folder) break; trail.push(folder); children = folder.children; }
  const current = trail[trail.length - 1];
  const canManage = group?.role === 'owner' || group?.role === 'admin';
  const learningMembers: GroupLearningMember[] = snapshot?.members ?? members.map(member => ({ ...member, levels: null, todayCount: null, weekCount: null, importedSetCount: 0, sharedSetCount: 0 }));
  const sorted = sortLearningMembers(learningMembers, sort);
  const groupLevels = sumLevels(learningMembers.flatMap(member => member.levels ? [member.levels] : []));
  const localLevels = useMemo(() => {
    const chosen = new Map<string, typeof data.problemSets[number]>();
    const groupSetIds = new Set(sets.map(set => set.id));
    for (const copy of [...data.problemSets].sort((a, b) => (b.copiedAt ?? b.createdAt).localeCompare(a.copiedAt ?? a.createdAt) || a.id.localeCompare(b.id))) {
      if (copy.sourceSetId && groupSetIds.has(copy.sourceSetId) && !chosen.has(copy.sourceSetId)) chosen.set(copy.sourceSetId, copy);
    }
    const questionsBySet = new Map<string, AppData['questions']>();
    for (const question of data.questions) {
      const questions = questionsBySet.get(question.setId) ?? [];
      questions.push(question); questionsBySet.set(question.setId, questions);
    }
    const progressById = indexProgress(data.progress);
    return sumLevels([...chosen.values()].flatMap(copy => {
      const questions = questionsBySet.get(copy.id) ?? [];
      const aggregate = importedLearning({ ...data, questions, progress: questions.flatMap(question => { const p = progressById.get(question.id); return p ? [p] : []; }), answerLogs: [] }, copy, copy.sourceSetId!, copy.sourceVersionId ?? '');
      return aggregate ? [aggregate.levels] : [];
    }));
  }, [data, sets]);
  const levels = scope === 'self' ? localLevels : groupLevels;
  const rankable = sortLearningMembers(learningMembers, 'today').filter(member => member.todayCount !== null);
  const renderFolder = (folder: GroupFolderCardData, parent = folderTrail) => {
    const contents = groupFolderSets(folder);
    return <SharedFolderCard key={folder.key} name={folder.name} creatorName={folder.createdBy === userId ? 'あなたが作成' : folder.creatorName} creatorId={folder.createdBy ?? undefined} sets={contents} questionCount={contents.reduce((sum, set) => sum + set.questionCount, 0)} updatedAt={[folder.updatedAt, ...contents.map(set => set.updatedAt)].sort().slice(-1)[0]} importLabel={folder.importCount === null ? '取り込み人数 未集計' : `${folder.importCount}人が取り込み`} busy={busy} onOpen={() => { onTab('folders'); onFolderTrail([...parent, folder.key]); }} />;
  };
  return <section ref={workspaceRef} className="group-workspace" aria-label="グループ詳細">
    <div className="group-workspace__tabs" role="tablist" aria-label="グループの表示">{([['overview', '概要'], ['folders', `フォルダ ${folderCount}`], ['members', `メンバー ${members.length}`]] as const).map(([value, label]) => <button type="button" id={`group-tab-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`group-panel-${value}`} tabIndex={tab === value ? 0 : -1} onKeyDown={event => {
      const tabs: GroupDetailTab[] = ['overview', 'folders', 'members']; const i = tabs.indexOf(value);
      const next = event.key === 'ArrowRight' ? tabs[(i + 1) % 3] : event.key === 'ArrowLeft' ? tabs[(i + 2) % 3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null;
      if (next) { event.preventDefault(); onTab(next); document.getElementById(`group-tab-${next}`)?.focus(); }
    }} onClick={() => onTab(value)}>{label}</button>)}</div>
    <div className="group-workspace__content">
      {error ? <div className="group-error" role="alert">{error}<button type="button" onClick={onRefresh}>再読み込み</button></div> : null}
      {loading ? <p className="group-muted" role="status">グループの集計を読み込み中…</p> : null}
      {tab !== 'folders' ? <article className="group-summary group-panel">
        <button type="button" className="group-summary__icon" aria-label="グループアイコンを変更" disabled={!canManage || busy} onClick={onSettings}><GroupAvatar icon={snapshot?.icon ?? group?.icon} accent={snapshot?.accent ?? group?.accent} />{canManage ? <span className="group-summary__edit" aria-hidden="true">✎</span> : null}</button>
        <div><h2>{group?.name ?? 'グループ'}</h2><p>{members.length}人 · {folderCount}フォルダ · {sets.length}問題セット</p></div>
        <button type="button" className="group-secondary" onClick={onSettings}><SettingsIcon size={17} />グループ設定</button>
      </article> : null}
      <section id="group-panel-overview" role="tabpanel" aria-labelledby="group-tab-overview" hidden={tab !== 'overview'}>
        <article className="group-panel"><div className="group-panel__heading"><h2>取り込まれた問題の進捗</h2><div className="group-segment" aria-label="進捗の対象">{([['all', '全体'], ['self', '自分']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}</div></div>
          {levels.some(n => n > 0) ? <LevelProgress levels={levels} /> : <GroupEmpty>{scope === 'self' ? 'グループの問題セットを取り込むと、ここに進捗が表示されます。' : '共有されたレベル別の進捗はまだありません。'}</GroupEmpty>}
        </article>
        <article className="group-panel"><div className="group-panel__heading"><h2>今日の解答数</h2><button type="button" className="group-text-link" onClick={() => { setSort('today'); onTab('members'); }}>すべて見る<ChevronRightIcon size={17} /></button></div>
          {rankable.slice(0, 3).map((member, i) => <div className="group-ranking" key={member.userId}><span className={`group-rank group-rank--${i}`}>{i + 1}</span><MemberAvatar name={member.displayName} userId={member.userId} /><strong>{member.userId === userId ? 'あなた' : member.displayName}</strong><b>{member.todayCount}問</b></div>)}
          {!rankable.length ? <GroupEmpty>今日の解答はまだ共有されていません。</GroupEmpty> : null}
        </article>
        <article className="group-panel"><div className="group-panel__heading"><h2>フォルダ</h2><button type="button" className="group-text-link" onClick={() => { onFolderTrail([]); onTab('folders'); }}>すべて見る<ChevronRightIcon size={17} /></button></div>
          {folders.slice(0, 3).map(folder => <button type="button" className="group-folder-shortcut library-tappable" key={folder.key} onClick={() => { onFolderTrail([folder.key]); onTab('folders'); }}><FolderOutlineIcon size={36} /><span><strong>{folder.name}</strong><small>{groupFolderSets(folder).length}セット · {groupFolderSets(folder).reduce((sum, set) => sum + set.questionCount, 0)}問</small></span><ChevronRightIcon size={18} /></button>)}
          {!folders.length ? <GroupEmpty>フォルダを追加して、共有する教材を整理しましょう。</GroupEmpty> : null}
        </article>
        <details className="library-info"><summary>集計について</summary><p>「全体」は進捗を共有したメンバーの現在の公開版、「自分」はこの端末の取り込み済みセットです。複数のコピーは最新の取り込みを集計します。</p><p>解答数はグループから取り込んだ問題が対象です。日付は日本時間で集計します。</p></details>
      </section>
      <section id="group-panel-folders" role="tabpanel" aria-labelledby="group-tab-folders" hidden={tab !== 'folders'}>
        <LibraryPane viewKey={folderKey} depth={folderTrail.length}>
        {current ? <nav className="group-breadcrumb" aria-label="フォルダの位置"><button type="button" onClick={() => onFolderTrail([])}>フォルダ</button>{trail.map((folder, i) => <span key={folder.key}> / <button type="button" aria-current={i === trail.length - 1 ? 'page' : undefined} onClick={() => onFolderTrail(folderTrail.slice(0, i + 1))}>{folder.name}</button></span>)}</nav> : null}
        <div className="group-panel__heading group-list-heading"><div><h2 tabIndex={-1}>{current?.name ?? 'フォルダ'}</h2>{current?<p className="group-folder-stats">{groupFolderSets(current).length}セット · {groupFolderSets(current).reduce((sum,set)=>sum+set.questionCount,0).toLocaleString('ja-JP')}問</p>:null}</div>
          {current ? <button type="button" className="group-primary" disabled={busy || !snapshot} onClick={() => onAddSet(current)}><PlusIcon size={18} />問題セットを追加</button> : canManage ? <button type="button" className="group-primary" disabled={busy || !snapshot} onClick={onAddFolder}><PlusIcon size={18} />フォルダを追加</button> : null}
        </div>
        <div className="group-folder-list">{(current ? current.children : folders).map(folder => renderFolder(folder))}</div>
        {current ? <div className="group-set-list">{current.sets.map(set => <button type="button" className="group-set-row library-tappable" key={set.id} disabled={busy} onClick={() => onOpenSet(set, trail.map(folder => folder.name).join(' / '))}><span className="group-set-row__icon"><ProblemSetIcon size={33} /></span><span><strong>{set.title}</strong><small>{set.questionCount.toLocaleString('ja-JP')}問{set.importCount===undefined?'':` · ${set.importCount}人が取り込み`}</small></span><ChevronRightIcon size={20} /></button>)}{!current.sets.length && !current.children.length ? <GroupEmpty>問題セットはまだありません。</GroupEmpty> : null}</div> : !folders.length && !loading ? <GroupEmpty>フォルダはまだありません。</GroupEmpty> : null}
        {current?<details className="library-info"><summary>フォルダ情報</summary><p>作成者：{current.createdBy===userId?'あなた':current.creatorName}</p><p>更新：{displayGroupDate(current.updatedAt)}{current.importCount===null?'':` · ${current.importCount}人が取り込み`}</p></details>:null}
        </LibraryPane>
      </section>
      <section id="group-panel-members" role="tabpanel" aria-labelledby="group-tab-members" hidden={tab !== 'members'}>
        <div className="group-panel__heading group-list-heading"><h2>メンバー {members.length}</h2><div className="group-segment" aria-label="メンバーの並び順">{([['today', '今日'], ['week', '今週'], ['l3', 'L3']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => setSort(value)}>{label}</button>)}</div></div>
        <div className="group-member-list">{sorted.map((member, i) => <article className="group-member-card" key={member.userId}>
          <div className="group-member-card__identity"><span className={`group-rank group-rank--${i}`}>{i + 1}</span><MemberAvatar name={member.displayName} userId={member.userId} /><span><strong>{member.userId === userId ? 'あなた' : member.displayName}</strong>{member.role === 'owner' ? <small className="group-owner-badge">オーナー</small> : null}</span></div>
          <dl className="group-member-card__stats"><div><dt>今日</dt><dd>{member.todayCount === null ? '—' : `${member.todayCount}問`}</dd></div><div><dt>今週</dt><dd>{member.weekCount === null ? '—' : `${member.weekCount}問`}</dd></div><div><dt>取り込み</dt><dd>{snapshot ? `${member.importedSetCount}セット` : '—'}</dd></div><div><dt>L3</dt><dd>{member.levels ? `${levelPercentages(member.levels)[3]}%` : '—'}</dd></div></dl>
        </article>)}</div><details className="library-info"><summary>集計について</summary><p>共有済みセットの最終反映時点の値です。「—」は未共有・未反映です。今週は月曜から日曜（日本時間）です。</p></details>
        {canManage ? <details className="group-member-management"><summary>メンバーを管理</summary>{members.filter(member => member.role !== 'owner' && member.userId !== userId).map(member => <div key={member.userId}><span>{member.displayName}</span><button type="button" disabled={busy} onClick={() => onRemoveMember(member)}>メンバーから外す</button></div>)}</details> : null}
      </section>
    </div>
  </section>;
}
