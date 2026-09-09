import { useState } from 'react';
import type { CloudProblemSet } from '../utils/cloudService';
import { sharedFolderTree, folderSets, type SharedFolderNode } from '../utils/sharedFolders';
import { ChevronRightIcon, FolderOutlineIcon, DocumentOutlineIcon } from './UiIcons';
import './SharedLibrary.css';
import { PublicationMenu } from './PublicationMenu';

export function SharedLibrary({ sets, userId, busy, onOpen, onRemove, loadFolder }: {
  sets: CloudProblemSet[]; userId?: string; busy: boolean;
  onOpen: (set: CloudProblemSet) => void;
  onRemove: (sets: CloudProblemSet[], title: string) => void;
  loadFolder?: (ownerId: string, folderId: string) => Promise<CloudProblemSet[]>;
}) {
  const [opened, setOpened] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<Record<string, CloudProblemSet[]>>({});
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const tree = sharedFolderTree(sets);
  const ensure = async (node: SharedFolderNode) => {
    if (!loadFolder) return folderSets(node);
    setLoading(node.key); setError('');
    try { const result = await loadFolder(node.ownerId, node.id); setLoaded((old) => ({ ...old, [node.key]: result })); return result; }
    catch { setError('読み込めませんでした。もう一度お試しください。'); return null; }
    finally { setLoading(''); }
  };
  const renderSet = (set: CloudProblemSet) => <div className="shared-library__row" key={set.id}>
    <button type="button" className="shared-library__open" disabled={busy} onClick={() => onOpen(set)}><DocumentOutlineIcon size={28} /><span><strong>{set.title}</strong><small>{[set.audience, `${set.questionCount}問`, set.ownerId === userId ? '自分の公開' : set.authorName].filter(Boolean).join(' · ')}</small></span><ChevronRightIcon size={18} /></button>
    {set.ownerId === userId ? <PublicationMenu title={set.title} busy={busy || !!loading} onRemove={() => onRemove([set], set.title)} /> : null}
  </div>;
  const renderFolder = (original: SharedFolderNode, depth = 0): React.ReactNode => {
    const cached = loaded[original.key];
    const node = cached ? sharedFolderTree(cached).folders.find((item) => item.key === original.key) ?? original : original;
    const open = opened.includes(node.key);
    return <section className="shared-library__folder" key={node.key}>
      <div className="shared-library__row">
        <button type="button" className="shared-library__open" aria-expanded={open} disabled={busy || !!loading} onClick={async () => {
          if (open) setOpened((old) => old.filter((key) => key !== node.key));
          else { if (depth === 0 && loadFolder && !await ensure(node)) return; setOpened((old) => [...old, node.key]); }
        }}><FolderOutlineIcon size={30} /><span><strong>{node.name}</strong><small>{loading === node.key ? '読み込み中…' : node.ownerId === userId ? '自分の公開' : node.authorName}</small></span><ChevronRightIcon className="shared-library__arrow" size={18} style={{ transform: open ? 'rotate(90deg)' : undefined }} /></button>
        {node.ownerId === userId ? <PublicationMenu title={node.name} busy={busy || !!loading} onRemove={() => { void ensure(node).then((contents) => { if (contents?.length) onRemove(contents, node.name); }); }} /> : null}
      </div>
      <div className={`shared-library__children${open ? ' is-open' : ''}`} inert={!open} aria-hidden={!open}><div>{node.folders.map((folder) => renderFolder(folder, depth + 1))}{node.sets.map(renderSet)}</div></div>
    </section>;
  };
  return <div className="shared-library">{error ? <p role="alert">{error}</p> : null}{tree.folders.map((node) => renderFolder(node))}{tree.sets.map(renderSet)}</div>;
}
