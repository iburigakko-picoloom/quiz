import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '../types';
import { Layout } from '../components/Layout';
import { ProblemSetIcon } from '../components/UiIcons';
import { searchLibrary } from '../utils/librarySearch';
import { folderChoices } from '../utils/folderHierarchy';

export function SearchScreen({ data, onOpenSet, onOpenQuestion, onDiscover }: {
  data: AppData; onOpenSet: (id: string) => void; onOpenQuestion: (id: string) => void; onDiscover: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'sets' | 'questions'>('sets');
  const [folder, setFolder] = useState('');
  const [category, setCategory] = useState('');
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
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [filterOpen]);
  const result = useMemo(() => searchLibrary(data, query, folder, tab === 'questions' ? category : ''), [data, query, folder, category, tab]);
  const preview = searchLibrary(data, query, draftFolder, tab === 'questions' ? draftCategory : '');
  const count = tab === 'sets' ? result.sets.length : result.questions.length;
  const filterCount = Number(!!folder) + Number(tab === 'questions' && !!category);
  const path = (setId: string) => {
    const set = data.problemSets.find((item) => item.id === setId);
    const owner = data.folders.find((item) => item.id === set?.folderId);
    const parent = data.folders.find((item) => item.id === owner?.parentFolderId);
    return [parent?.name, owner?.name, set?.title].filter(Boolean).join(' ＞ ');
  };
  return <Layout><main className="library-page">
    <header className="library-page__header"><h1>検索</h1><button onClick={onDiscover}>公開問題を探す</button></header>
    <input className="library-search-input" aria-label="問題セット・問題を検索" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="library-tabs" role="tablist" aria-label="検索対象">
      <button role="tab" aria-selected={tab === 'sets'} onClick={() => { setTab('sets'); setCategory(''); }}>問題セット {result.sets.length}</button>
      <button role="tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}>問題 {result.questions.length}</button>
    </div>
    <div className="library-search-tools"><span>{count}件</span><button onClick={() => { setDraftFolder(folder); setDraftCategory(category); setFilterOpen(true); }}>絞り込み{filterCount ? ` ${filterCount}` : ''}</button></div>
    <section role="tabpanel">
      {tab === 'sets' ? result.sets.map((set) => <button className="library-row" key={set.id} onClick={() => onOpenSet(set.id)}><span className="library-icon"><ProblemSetIcon size={18} /></span><span className="library-row__body"><strong>{set.title}</strong><span>{path(set.id)} · {data.questions.filter((q) => q.setId === set.id).length}問</span></span></button>)
        : result.questions.map(({ question, choiceOnly }) => <button className="library-row" key={question.id} onClick={() => onOpenQuestion(question.id)}><span className="library-row__body"><strong>{question.question}</strong><span>{path(question.setId)}{choiceOnly ? ' · 選択肢に一致' : ''}</span></span></button>)}
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
