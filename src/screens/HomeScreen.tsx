import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppData, Folder } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Layout } from '../components/Layout';
import { LibraryItemActions } from '../components/LibraryItemActions';
import {
  CheckIcon,
  ChevronRightIcon,
  FolderOutlineIcon,
  PlusIcon,
  TrashIcon,
} from '../components/UiIcons';
import { buildAppDataView } from '../utils/appDataView';
import './HomeScreen.css';
import { StudyCompanion } from '../components/StudyCompanion';
import { useStudyRecord } from '../hooks/useStudyRecord';
import { useStudyPlans } from '../hooks/useStudyPlans';
import { aggregatePlanToday, planStatus } from '../utils/studyPlans';

interface HomeScreenProps {
  data: AppData;
  onCreateFolder: (name: string) => void;
  onCreateSample: () => void;
  onDeleteFolder: (folderId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onOpenStudyRecord: () => void;
  onOpenPlans: () => void;
  onOpenSearch: () => void;
  onOpenPlan: (id: string) => void;
  onSave: (data: AppData) => Promise<boolean>;
}

export function HomeScreen({
  data,
  onCreateFolder,
  onCreateSample,
  onDeleteFolder,
  onOpenFolder,
  onOpenStudyRecord,
  onOpenPlans,
  onOpenSearch,
  onOpenPlan,
  onSave,
}: HomeScreenProps) {
  const [folderName, setFolderName] = useState('');
  const { summary, day } = useStudyRecord(data.answerLogs);
  const { entries, error: planError } = useStudyPlans(data.answerLogs);
  const planToday = aggregatePlanToday(entries, data);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const editMode = false;
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const folders = useMemo(() => buildAppDataView(data).folders.filter(({ folder }) => !folder.parentFolderId).filter(({ folder }) => folder.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => sort === 'name' ? a.folder.name.localeCompare(b.folder.name, 'ja') : b.folder.updatedAt.localeCompare(a.folder.updatedAt)), [data, day, query, sort]);

  const handleCreateFolder = () => {
    const name = folderName.trim();
    if (!name) return;
    onCreateFolder(name);
    setFolderName('');
    setCreateOpen(false);
  };

  return (
    <Layout>
      <div className="quiz-home quiz-home--plans">
        <header className="quiz-home__header">
          <h1 className="quiz-home__title">Quiz Make</h1>
          <button type="button" className="quiz-home__plans-link" onClick={onOpenPlans}>学習計画</button>
        </header>

        <div className="quiz-home__content">
        <section className="quiz-home__today" aria-label="今日のがんばりと計画達成">
          <h2 className="sr-only">今日のがんばりと計画達成</h2>
          <StudyCompanion scene="home">
            <button type="button" className="quiz-home__study-card" aria-label="学習記録を見る" onClick={onOpenStudyRecord}>
              <span className="quiz-home__study-title">今日のがんばり <ChevronRightIcon size={14} /></span>
              <span className="quiz-home__activity"><span>全回答 <strong>{summary.todayCount}<small>回</small></strong></span><span>連続 <b>{summary.streak}</b>日</span></span>
              <span className="quiz-home__plan-total">計画 <b>{planToday.done}/{planToday.goal}</b>問</span>
            </button>
          </StudyCompanion>
        </section>

        <section className="quiz-home__library" aria-label="学習フォルダ">
          <div className="quiz-home__section-heading"><h2>学習フォルダ</h2><button type="button" className="quiz-home__search-entry" onClick={onOpenSearch}>教材検索</button><HomeCircleButton icon="add" label="フォルダを追加" onClick={() => setCreateOpen(true)} /></div>
          <details className="quiz-home__folder-options"><summary>検索・並び替え{query ? ` · ${query}` : sort === 'name' ? ' · 名前順' : ''}</summary><div className="quiz-home__folder-tools"><input type="search" aria-label="フォルダを検索" placeholder="フォルダを検索" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="フォルダの並び順" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">更新順</option><option value="name">名前順</option></select></div></details>

        <section className="quiz-home__folder-list" aria-label="フォルダ一覧">
          {folders.length === 0 && !query ? (
            <div className="quiz-home__empty">
              <div className="quiz-home__empty-icon" aria-hidden="true"><PlusIcon size={24} /></div>
              <h2>学習フォルダを作りましょう</h2>
              <div className="quiz-home__empty-actions">
                <button type="button" onClick={onCreateSample}>サンプルで試す</button>
                <button type="button" className="quiz-home__empty-secondary" onClick={() => setCreateOpen(true)}>自分のフォルダを作る</button>
              </div>
            </div>
          ) : folders.map(({ folder, ...summary }) => {
            return (
              <div key={folder.id} className="library-row-with-actions">
              <QuizHomeFolderItem
                key={folder.id}
                folder={folder}
                setCount={summary.setCount}
                questionCount={summary.questionCount}
                reviewCount={summary.reviewCount}
                editMode={editMode}
                onOpen={() => onOpenFolder(folder.id)}
                onDelete={() => setDeleteTarget(folder)}
              />
              <LibraryItemActions data={data} kind="folder" id={folder.id} onSave={onSave} onDelete={() => setDeleteTarget(folder)} />
              </div>
            );
          })}
        </section>
        {!folders.length && query ? <p className="quiz-home__no-results">該当するフォルダがありません</p> : null}
        </section>

        <section className="quiz-home__plans" aria-label="学習計画">
          <div className="quiz-home__section-heading"><h2>学習計画</h2><button type="button" onClick={onOpenPlans}>一覧・作成 ›</button></div>
          {planError ? <p role="alert">{planError}</p> : null}
          {entries.length ? <div className="quiz-home__plan-list">{entries.slice(0, 2).map(({ plan, daily }) => {
            const status = planStatus(plan, data, daily);
            const label = status.paused ? '休止中' : status.expired ? '期限超過' : status.todayComplete ? '今日の目標達成' : `今日あと${status.remaining}問`;
            return <button key={plan.id} type="button" className="quiz-home__plan-card" aria-label={`${plan.title}：${plan.setTitle}、${label}、${status.done}/${status.goal}問`} onClick={() => onOpenPlan(plan.id)}><span className="quiz-home__plan-target"><strong>{plan.title}</strong></span><span className="quiz-home__plan-count">{status.paused ? '休止中' : status.expired ? '期限超過' : `今日 ${status.done}/${status.goal}問`}</span><ChevronRightIcon size={16} /></button>;
          })}{entries.length > 2 ? <button type="button" className="quiz-home__more-plans" onClick={onOpenPlans}>ほか{entries.length - 2}件の計画</button> : null}</div> : <button className="quiz-home__no-plans" type="button" onClick={onOpenPlans}>期限型・習慣型の計画を作成 ＋</button>}
        </section>

        </div>

        {createOpen ? (
          <CreateFolderDialog
            folderName={folderName}
            onChange={setFolderName}
            onCancel={() => {
              setCreateOpen(false);
              setFolderName('');
            }}
            onCreate={handleCreateFolder}
          />
        ) : null}

        <ConfirmDialog
          open={deleteTarget !== null}
          title="削除しますか？"
          message={`${deleteTarget?.name ?? ''}\n子フォルダ ${data.folders.filter((folder) => folder.parentFolderId === deleteTarget?.id).length}件・問題セット ${folders.find(({ folder }) => folder.id === deleteTarget?.id)?.setCount ?? 0}件・問題 ${folders.find(({ folder }) => folder.id === deleteTarget?.id)?.questionCount ?? 0}問と学習記録・ノートを削除します。`}
          confirmLabel="削除"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget) onDeleteFolder(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />

      </div>
    </Layout>
  );
}

function HomeCircleButton({ active = false, icon, label, onClick }: { active?: boolean; icon: 'delete' | 'add' | 'done'; label: string; onClick: () => void }) {
  return (
    <button type="button" className="quiz-home__action" aria-label={label} onClick={onClick}>
      <span className={`quiz-home__circle-button${active ? ' quiz-home__circle-button--active' : ''}`}>
        {icon === 'delete' ? <TrashIcon /> : icon === 'done' ? <CheckIcon /> : <PlusIcon />}
      </span>
      <span className="quiz-home__action-label">{label}</span>
    </button>
  );
}

function QuizHomeFolderItem({
  folder,
  setCount,
  questionCount,
  reviewCount,
  editMode,
  onOpen,
  onDelete,
}: {
  folder: Folder;
  setCount: number;
  questionCount: number;
  reviewCount: number;
  editMode: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="quiz-home__folder-card">
      <button type="button" className="quiz-home__folder-main" onClick={onOpen} disabled={editMode}>
        <span className="quiz-home__folder-icon" aria-hidden="true">
          <FolderOutlineIcon folderColor={folder.color} />
        </span>
        <span className="quiz-home__folder-body">
          <span className="quiz-home__folder-name">{folder.name}</span>
          <span className="quiz-home__folder-stats">
            <span>{setCount}セット</span>
            <span>{questionCount}問</span>
            {reviewCount > 0 ? <span className="library-danger">復習 {reviewCount}</span> : null}
          </span>
        </span>
        {!editMode ? <span className="quiz-home__folder-arrow"><ChevronRightIcon /></span> : null}
      </button>

      {editMode ? (
        <button type="button" className="quiz-home__delete-button" onClick={onDelete}>
          <TrashIcon size={18} />
          <span>削除</span>
        </button>
      ) : null}
    </article>
  );
}

function CreateFolderDialog({
  folderName,
  onChange,
  onCancel,
  onCreate,
}: {
  folderName: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const dialogRef = useModalFocus<HTMLFormElement>(onCancel);
  const titleId = useId();

  return createPortal(
    <div
      className="quiz-home__overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className="quiz-home__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <h2 id={titleId} className="quiz-home__sheet-title">フォルダを新規作成</h2>
        <input
          data-dialog-autofocus
          value={folderName}
          onChange={(event) => onChange(event.target.value)}
          className="quiz-home__input"
          aria-label="フォルダ名"
        />
        <div className="quiz-home__sheet-actions">
          <button type="button" className="quiz-home__sheet-button" onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className="quiz-home__sheet-button quiz-home__sheet-button--primary" disabled={!folderName.trim()}>
            作成
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function useModalFocus<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]');
      const first = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
      (preferred ?? first)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return dialogRef;
}
