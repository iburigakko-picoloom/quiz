import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppData, Folder, ProblemSet } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BackButton } from '../components/BackButton';
import { Layout } from '../components/Layout';
import { MissingResourceState } from '../components/MissingResourceState';
import { LibraryItemActions } from '../components/LibraryItemActions';
import { ChevronRightIcon, ProblemSetIcon, FolderOutlineIcon, PlusIcon } from '../components/UiIcons';
import { buildAppDataView, type ProblemSetOverview } from '../utils/appDataView';
import { addFolder } from '../utils/quiz';
import './FolderScreen.css';

interface FolderScreenProps {
  data: AppData;
  folderId: string;
  onBack: () => void;
  onCreateProblemSet: (folderId: string) => void;
  onOpenProblemSet: (setId: string) => void;
  onDeleteProblemSet: (setId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onSave: (data: AppData) => Promise<boolean>;
}

const folderNavigation = new Map<string, { expanded: string | null; scroll: number }>();

export function FolderScreen({ data, folderId, onBack, onCreateProblemSet, onOpenProblemSet, onDeleteProblemSet, onDeleteFolder, onSave }: FolderScreenProps) {
  const view = useMemo(() => buildAppDataView(data), [data]);
  const requested = view.folderById.get(folderId);
  const parentId = requested?.parentFolderId ?? folderId;
  const folder = view.folderById.get(parentId);
  const [expanded, setExpanded] = useState<string | null>(() => requested?.parentFolderId ? folderId : folderNavigation.get(parentId)?.expanded ?? null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteSet, setDeleteSet] = useState<ProblemSet | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<Folder | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useLayoutEffect(() => {
    const scroller = rootRef.current?.parentElement;
    if (scroller) scroller.scrollTop = folderNavigation.get(parentId)?.scroll ?? 0;
    return () => { folderNavigation.set(parentId, { expanded: expandedRef.current, scroll: scroller?.scrollTop ?? 0 }); };
  }, [parentId]);

  const children = view.folders.filter(({ folder: item }) => item.parentFolderId === parentId);
  const sets = view.problemSetsByFolderId.get(parentId) ?? [];
  const renderSet = ({ problemSet, questionCount, correctRate, reviewCount }: ProblemSetOverview) => <div className="library-row-with-actions" key={problemSet.id}>
    <button type="button" className="library-row" onClick={() => onOpenProblemSet(problemSet.id)}>
      <span className="library-icon"><ProblemSetIcon size={18} /></span>
      <span className="library-row__body"><strong>{problemSet.title}</strong><span>{questionCount}問 · 正答率 {correctRate}% {reviewCount > 0 ? <em>復習 {reviewCount}</em> : null}</span></span>
      <ChevronRightIcon size={18} />
    </button>
    <LibraryItemActions data={data} kind="set" id={problemSet.id} onSave={onSave} onDelete={() => setDeleteSet(problemSet)} />
  </div>;

  if (!folder) return <Layout><MissingResourceState title="フォルダが見つかりません" description="フォルダ一覧から選び直してください。" onAction={onBack} /></Layout>;
  return <Layout><div className="quiz-folder" ref={rootRef}>
    <header className="quiz-folder__header">
      <BackButton onClick={onBack} /><h1 className="quiz-folder__title">{folder.name}</h1>
      <details className="library-actions library-header-add">
        <summary aria-label="追加"><PlusIcon size={22} /></summary>
        <div className="library-actions__body">
          <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setAdding(true); }}>子フォルダを追加</button>
          <button type="button" onClick={() => onCreateProblemSet(parentId)}>ここに問題セットを追加</button>
        </div>
      </details>
    </header>
    {adding ? <form className="library-form" onSubmit={async (event) => {
      event.preventDefault(); if (busy || !name.trim()) return;
      setBusy(true); setError('');
      try { if (await onSave(addFolder(data, name, parentId))) { setAdding(false); setName(''); } else setError('保存できませんでした。'); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '保存できませんでした。'); }
      finally { setBusy(false); }
    }}><label>子フォルダ名<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} autoFocus /></label>
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={busy || !name.trim()}>作成</button><button type="button" disabled={busy} onClick={() => setAdding(false)}>キャンセル</button>
    </form> : null}
    {children.length > 0 ? <section className="library-section"><h2>子フォルダ</h2>
      {children.map(({ folder: child, setCount, questionCount, reviewCount }) => <div key={child.id}>
        <div className="library-row-with-actions">
          <button type="button" className="library-row" aria-expanded={expanded === child.id} onClick={() => setExpanded((current) => current === child.id ? null : child.id)}>
            <span className="library-icon"><FolderOutlineIcon size={18} /></span>
            <span className="library-row__body"><strong>{child.name}</strong><span>{setCount}セット · {questionCount}問 {reviewCount > 0 ? <em>復習 {reviewCount}</em> : null}</span></span>
            <ChevronRightIcon size={18} className="quiz-folder__child-chevron" style={{ transform: expanded === child.id ? 'rotate(90deg)' : undefined }} />
          </button>
          <LibraryItemActions data={data} kind="folder" id={child.id} onSave={onSave} onDelete={() => setDeleteFolder(child)} onAddSet={() => onCreateProblemSet(child.id)} />
        </div>
        <div className={`quiz-folder__child-reveal${expanded === child.id ? ' is-open' : ''}`} inert={expanded !== child.id} aria-hidden={expanded !== child.id}>
          <div className="quiz-folder__child-content"><div className="library-child-sets">{(view.problemSetsByFolderId.get(child.id) ?? []).map(renderSet)}{!setCount ? <p>問題セットがありません</p> : null}</div></div>
        </div>
      </div>)}
    </section> : null}
    <section className="library-section"><h2>問題セット</h2>{sets.map(renderSet)}{sets.length === 0 ? <p>問題セットがありません</p> : null}</section>
    <ConfirmDialog open={deleteSet !== null} title="問題セットを削除しますか？" message={`${deleteSet?.title ?? ''}\n${view.questionsBySetId.get(deleteSet?.id ?? '')?.length ?? 0}問と学習記録・ノートを削除します。`} onCancel={() => setDeleteSet(null)} onConfirm={() => { if (deleteSet) onDeleteProblemSet(deleteSet.id); setDeleteSet(null); }} />
    <ConfirmDialog open={deleteFolder !== null} title="フォルダを削除しますか？" message={`${deleteFolder?.name ?? ''}\n${view.problemSetsByFolderId.get(deleteFolder?.id ?? '')?.length ?? 0}セットと問題・学習記録・ノートを削除します。`} onCancel={() => setDeleteFolder(null)} onConfirm={() => { if (deleteFolder) onDeleteFolder(deleteFolder.id); setDeleteFolder(null); }} />
  </div></Layout>;
}
