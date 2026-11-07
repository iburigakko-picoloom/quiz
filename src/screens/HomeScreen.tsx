import { useDeviceRole } from '../hooks/useDeviceRole';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppData, Folder, MaterialReference } from '../types';
import { loadMaterials } from '../utils/materialStorage';
import { getAccountStorageSession } from '../utils/accountStorage';
import { registerScreenBack } from '../utils/screenBack';
import type { StudyMaterial } from '../utils/materialModel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Layout } from '../components/Layout';
import { LibraryItemActions } from '../components/LibraryItemActions';
import {
  CheckIcon,
  ChevronRightIcon,
  DocumentOutlineIcon,
  FolderOutlineIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../components/UiIcons';
import { buildAppDataView } from '../utils/appDataView';
import './HomeScreen.css';
import { StudyCompanion } from '../components/StudyCompanion';
import { StudyActivity } from '../components/StudyActivity';
import { useStudyRecord } from '../hooks/useStudyRecord';
import type { CompanionCare } from '../utils/companionCare';

interface HomeScreenProps {
  data: AppData;
  initialMaterials?: { materialsView?: boolean; materialsQuery?: string; materialsScroll?: number };
  onOpenMaterial?: (setId: string, reference: MaterialReference, query: string, scroll: number) => void;
  onCloseMaterials?: () => void;
  onCreateFolder: (name: string) => void;
  onCreateSample: () => void;
  onDeleteFolder: (folderId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onOpenStudyRecord: () => void;
  onOpenPlans: () => void;
  onOpenSearch: () => void;
  onOpenCompanion: () => void;
  companionCare: CompanionCare | null;
  onSave: (data: AppData) => Promise<boolean>;
}

export function HomeScreen({
  data,
  initialMaterials,
  onOpenMaterial,
  onCloseMaterials,
  onCreateFolder,
  onCreateSample,
  onDeleteFolder,
  onOpenFolder,
  onOpenStudyRecord,
  onOpenPlans,
  onOpenSearch,
  onOpenCompanion,
  companionCare,
  onSave,
}: HomeScreenProps) {
  const isMainDevice = useDeviceRole() === 'main';
  const [materialsView, setMaterialsView] = useState(initialMaterials?.materialsView ?? false);
  const [materialsQuery, setMaterialsQuery] = useState(initialMaterials?.materialsQuery ?? '');
  const [materialRows, setMaterialRows] = useState<Array<{setId: string; setTitle: string; material: StudyMaterial}>>([]);
  const [materialError, setMaterialError] = useState('');
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const visibleMaterialRows = materialRows.filter(row => `${row.material.title} ${row.setTitle}`.toLocaleLowerCase().includes(materialsQuery.trim().toLocaleLowerCase()));
  const materialList = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef(initialMaterials?.materialsScroll ?? 0);
  useEffect(() => {
    if (!materialsView) return;
    return registerScreenBack(() => { setMaterialsView(false); onCloseMaterials?.(); });
  }, [materialsView, onCloseMaterials]);
  useEffect(() => {
    if (!materialsView) return;
    let cancelled = false;
    const owner = getAccountStorageSession();
    setMaterialsLoading(true); setMaterialError('');
    void (async () => {
      const results: Array<{set: AppData['problemSets'][number]; index: Awaited<ReturnType<typeof loadMaterials>>}> = [];
      for (let start = 0; start < data.problemSets.length; start += 4) {
        const batch = await Promise.all(data.problemSets.slice(start, start + 4).map(async set => {
          const index = await loadMaterials(set.id);
          if (index.problemSetId !== set.id) throw new Error('資料の所有教材を確認できません。');
          return {set, index};
        }));
        if (cancelled) return [];
        if (owner !== getAccountStorageSession()) throw new Error('アカウントが変わりました。');
        owner?.assertCurrent();
        results.push(...batch);
      }
      return results;
    })().then(results => {
      if (owner !== getAccountStorageSession()) throw new Error('アカウントが変わりました。');
      owner?.assertCurrent();
      if (!cancelled) setMaterialRows(results.flatMap(({set,index}) => index.materials.map(material => ({setId:set.id,setTitle:set.title,material}))));
    }).catch(() => { if (!cancelled) { setMaterialRows([]); setMaterialError('資料一覧を読み込めません。再度開いてください。'); } }).finally(() => { if (!cancelled) setMaterialsLoading(false); });
    return () => { cancelled = true; };
  }, [materialsView, data.problemSets]);
  useEffect(() => {
    if (materialsView && !materialsLoading && materialRows.length && materialList.current) { materialList.current.scrollTop = restoreScroll.current; restoreScroll.current = 0; }
  }, [materialsView, materialsLoading, materialRows]);
  const [folderName, setFolderName] = useState('');
  const { summary, day } = useStudyRecord(data.answerLogs);
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
      <div className={`quiz-home quiz-home--plans${materialsView ? ' quiz-home--materials-active' : ''}`}>
        <header className="quiz-home__header">
          <h1 className="quiz-home__title">Quiz Make</h1>
          <div className="quiz-home__header-actions"><button type="button" className="quiz-home__plans-link" aria-pressed={materialsView} onClick={() => { if (materialsView) onCloseMaterials?.(); setMaterialsView(value => !value); }}>資料</button><button type="button" className="quiz-home__plans-link" onClick={onOpenPlans}>学習計画</button></div>
        </header>

        {materialsView ? <div className="quiz-home__content quiz-home__materials" ref={materialList}>
          <div className="quiz-home__section-heading"><h2>資料一覧</h2><button type="button" onClick={() => { setMaterialsView(false); onCloseMaterials?.(); }}>学習フォルダへ</button></div>
          <label className="quiz-home__materials-search"><SearchIcon size={18} aria-hidden="true"/><input type="search" aria-label="資料を検索" placeholder="資料名・教材名で検索" value={materialsQuery} onChange={event => setMaterialsQuery(event.target.value)} /></label>
          {materialsLoading ? <p role="status">読み込み中…</p> : null}
          {materialError ? <p role="alert">{materialError}</p> : null}
          {!isMainDevice ? <p>資料を開くにはメイン端末に切り替えてください。</p> : null}
          {!materialsLoading && !materialError && visibleMaterialRows.map(({setId,setTitle,material}) => <button key={`${setId}/${material.id}`} type="button" className="quiz-home__material-row" disabled={!isMainDevice || !material.pages.length} onClick={() => onOpenMaterial?.(setId, {materialId:material.id,pageId:material.pages[0].id}, materialsQuery, materialList.current?.scrollTop ?? 0)}><span className="quiz-home__material-icon"><DocumentOutlineIcon size={24} aria-hidden="true"/></span><span className="quiz-home__material-details"><strong>{material.title}</strong><span>{setTitle}</span><span>{material.pages.some(page => page.kind === 'pdf') ? 'PDF' : 'ノート'}・{material.pages.length}ページ</span></span><ChevronRightIcon /></button>)}
          {!materialsLoading && !materialError && !visibleMaterialRows.length ? <p>{materialRows.length ? '該当する資料はありません。' : '登録された資料はありません。'}</p> : null}
        </div> : <div className="quiz-home__content">
        <section className="quiz-home__library" aria-label="学習フォルダ">
          <div className="quiz-home__section-heading"><h2>学習フォルダ</h2><button type="button" className="quiz-home__search-entry" onClick={onOpenSearch}>教材検索</button>{isMainDevice && <HomeCircleButton icon="add" label="フォルダを追加" onClick={() => setCreateOpen(true)} />}</div>
          <details className="quiz-home__folder-options"><summary>検索・並び替え{query ? ` · ${query}` : sort === 'name' ? ' · 名前順' : ''}</summary><div className="quiz-home__folder-tools"><input type="search" aria-label="フォルダを検索" placeholder="フォルダを検索" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="フォルダの並び順" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">更新順</option><option value="name">名前順</option></select></div></details>

        <section className="quiz-home__folder-list" aria-label="フォルダ一覧">
          {folders.length === 0 && !query ? (
            <div className="quiz-home__empty">
              <div className="quiz-home__empty-icon" aria-hidden="true"><PlusIcon size={24} /></div>
              <h2>{isMainDevice ? '学習フォルダを作りましょう' : '同期から教材を受信できます'}</h2>
              <div className="quiz-home__empty-actions" hidden={!isMainDevice}>
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

        </div>}

        {!materialsView && <section className="quiz-home__today" aria-label="今日のがんばり">
          <h2 className="sr-only">今日のがんばり</h2>
          <StudyCompanion scene="home" care={companionCare} onOpenCare={onOpenCompanion}>
            <button type="button" className="quiz-home__study-card" aria-label="学習記録を見る" onClick={onOpenStudyRecord}>
              <span className="quiz-home__study-title">今日のがんばり <ChevronRightIcon size={14} /></span>
              <StudyActivity summary={summary} compact />
            </button>
          </StudyCompanion>
        </section>}

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
