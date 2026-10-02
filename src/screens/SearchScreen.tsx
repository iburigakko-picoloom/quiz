import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import { Layout } from '../components/Layout';
import { ProblemSetIcon } from '../components/UiIcons';
import { buildLibrarySearchIndex, searchLibrary } from '../utils/librarySearch';
import { BackButton } from '../components/BackButton';
import { readListView } from '../utils/listViewMemory';
import { useListViewMemory } from '../hooks/useListViewMemory';
import { registerTransientDialog } from '../utils/transientDialog';
import { folderChoices } from '../utils/folderHierarchy';
import './SearchScreen.css';

export function SearchScreen({ data, onBack, onOpenSet, onOpenQuestion, onDiscover }: {
  data: AppData; onBack: () => void; onOpenSet: (id: string) => void; onOpenQuestion: (id: string) => void; onDiscover: () => void;
}) {
  const saved = readListView<{ query: string; tab: 'sets' | 'questions'; folder: string; category: string; limit: number }>('own-search')?.state;
  const [query, setQuery] = useState(saved?.query ?? '');
  const [tab, setTab] = useState<'sets' | 'questions'>(saved?.tab ?? 'sets');
  const [folder, setFolder] = useState(saved?.folder ?? '');
  const [category, setCategory] = useState(saved?.category ?? '');
  const [limit, setLimit] = useState(saved?.limit ?? 100);
  const pageRef = useRef<HTMLElement>(null);
  const remember = useListViewMemory('own-search', { query, tab, folder, category, limit }, pageRef);
  const deferredQuery = useDeferredValue(query);
  const index = useMemo(() => buildLibrarySearchIndex(data), [data]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [draftFolder, setDraftFolder] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('select, button') ?? []);
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setFilterOpen(false); }
      if (event.key !== 'Tab') return;
      const items = controls();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    const unregister = registerTransientDialog(() => setFilterOpen(false));
    return () => { unregister(); document.removeEventListener('keydown', keydown); previous?.focus({ preventScroll: true }); };
  }, [filterOpen]);
  const result = useMemo(() => searchLibrary(data, deferredQuery, folder, tab === 'questions' ? category : '', index), [data, deferredQuery, folder, category, tab, index]);
  const preview = useMemo(() => filterOpen ? searchLibrary(data, deferredQuery, draftFolder, tab === 'questions' ? draftCategory : '', index) : result, [filterOpen, data, deferredQuery, draftFolder, draftCategory, tab, index, result]);
  const count = tab === 'sets' ? result.sets.length : result.questions.length;
  const filterCount = Number(!!folder) + Number(tab === 'questions' && !!category);
  const path = (setId: string) => {
    const set = data.problemSets.find((item) => item.id === setId);
    const owner = data.folders.find((item) => item.id === set?.folderId);
    const parent = data.folders.find((item) => item.id === owner?.parentFolderId);
    return [parent?.name, owner?.name, set?.title].filter(Boolean).join(' ＞ ');
  };
  return <Layout><main ref={pageRef} className="library-page own-library-search">
    <header className="library-page__header"><BackButton onClick={onBack} /><h1>自分の教材</h1><button onClick={() => { remember(); onDiscover(); }}>全体公開を探す</button></header>
    <input type="search" className="library-search-input" aria-label="自分の教材・問題を検索" placeholder="フォルダを横断して検索" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(100); }} />
    {deferredQuery !== query ? <p role="status">検索中…</p> : null}
    <div className="library-tabs" role="tablist" aria-label="検索対象">
      <button role="tab" aria-selected={tab === 'sets'} onClick={() => { setTab('sets'); setCategory(''); }}>問題セット {result.sets.length}</button>
      <button role="tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}>問題 {result.questions.length}</button>
    </div>
    <div className="library-search-tools"><span>{count}件</span><button onClick={() => { setDraftFolder(folder); setDraftCategory(category); setFilterOpen(true); }}>絞り込み{filterCount ? ` ${filterCount}` : ''}</button></div>
    <section role="tabpanel">
      {tab === 'sets' ? result.sets.slice(0, limit).map((set) => <button className="library-row" data-item-id={set.id} key={set.id} onClick={() => { remember(set.id); onOpenSet(set.id); }}><span className="library-icon"><ProblemSetIcon size={18} /></span><span className="library-row__body"><strong>{set.title}</strong><span>{path(set.id)} · {index.questionCounts.get(set.id) ?? 0}問</span></span></button>)
        : result.questions.slice(0, limit).map(({ question, choiceOnly }) => <button className="library-row" data-item-id={question.id} key={question.id} onClick={() => { remember(question.id); onOpenQuestion(question.id); }}><span className="library-row__body"><strong>{question.question}</strong><span>{path(question.setId)}{choiceOnly ? ' · 選択肢に一致' : ''}</span></span></button>)}
      {count > limit ? <button className="qm-secondary" onClick={() => setLimit(n => n + 100)}>次の100件を表示（残り{count - limit}件）</button> : null}
      {!count ? <p>一致する問題がありません</p> : null}
    </section>
    {filterOpen ? <div className="library-filter-backdrop"><section ref={dialogRef} className="library-filter" role="dialog" aria-modal="true" aria-label="絞り込み">
      <h2>絞り込み</h2><label>フォルダ<select value={draftFolder} onChange={(event) => setDraftFolder(event.target.value)}><option value="">すべて</option>{folderChoices(data.folders).map((item) => <option key={item.id} value={item.id}>{item.parentFolderId ? '　' : ''}{item.name}</option>)}</select></label>
      {tab === 'questions' ? <label>分類<select value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)}><option value="">すべて</option>{[...new Set(data.questions.map((q) => q.category))].filter(Boolean).map((value) => <option key={value}>{value}</option>)}</select></label> : null}
      <button onClick={() => { setDraftFolder(''); setDraftCategory(''); }}>リセット</button>
      <button onClick={() => { setFolder(draftFolder); setCategory(draftCategory); setFilterOpen(false); }}>{tab === 'sets' ? preview.sets.length : preview.questions.length}件を表示</button>
      <button onClick={() => setFilterOpen(false)}>キャンセル</button>
    </section></div> : null}
  </main></Layout>;
}
