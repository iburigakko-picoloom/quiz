import { useRef, useEffect, useState } from 'react';
import type { AppData } from '../types';
import { folderSubtreeIds } from '../utils/folderHierarchy';
import { ChevronRightIcon, FolderOutlineIcon, ProblemSetIcon } from './UiIcons';
import './PublishPicker.css';

function Selection({ checked, partial = false, disabled, label, onChange }: { checked: boolean; partial?: boolean; disabled: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <label className="publish-picker__check"><input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} /></label>;
}

export function PublishPicker({ data, selected, onChange }: { data: AppData; selected: string[]; onChange: (ids: string[]) => void }) {
  const [opened, setOpened] = useState<string[]>([]);
  const toggle = (ids: string[]) => {
    const next = new Set(selected);
    const remove = ids.every((id) => next.has(id));
    ids.forEach((id) => { if (remove) next.delete(id); else next.add(id); });
    onChange([...next]);
  };
  const renderSets = (folderId?: string) => data.problemSets.filter((set) => folderId ? set.folderId === folderId : !data.folders.some((folder) => folder.id === set.folderId)).map((set) => <div className="publish-picker__row" key={set.id}>
    <Selection checked={selected.includes(set.id)} disabled={false} label={`${set.title}を選択`} onChange={() => toggle([set.id])} />
    <button type="button" className="publish-picker__item" onClick={() => toggle([set.id])}><ProblemSetIcon size={24} /><span>{set.title}<small>{data.questions.filter((q) => q.setId === set.id).length}問</small></span></button>
  </div>);
  const renderFolders = (parentId?: string, ancestors: string[] = []): React.ReactNode => data.folders.filter((folder) => folder.parentFolderId === parentId && !ancestors.includes(folder.id)).map((folder) => {
    const descendants = folderSubtreeIds(data.folders, folder.id);
    const ids = data.problemSets.filter((set) => descendants.has(set.folderId)).map((set) => set.id);
    const count = ids.filter((id) => selected.includes(id)).length;
    const open = opened.includes(folder.id);
    return <div className="publish-picker__folder" key={folder.id}>
      <div className="publish-picker__row">
        <Selection checked={ids.length > 0 && count === ids.length} partial={count > 0 && count < ids.length} disabled={!ids.length} label={`${folder.name}内をまとめて選択`} onChange={() => toggle(ids)} />
        <button type="button" className="publish-picker__item" aria-expanded={open} onClick={() => setOpened(open ? opened.filter((id) => id !== folder.id) : [...opened, folder.id])}>
          <FolderOutlineIcon size={26} /><span>{folder.name}<small>{ids.length}セット{count ? ` · ${count}選択` : ''}</small></span><ChevronRightIcon size={18} className="publish-picker__arrow" style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        </button>
      </div>
      <div className={`publish-picker__children${open ? ' is-open' : ''}`} inert={!open} aria-hidden={!open}><div>
        {renderFolders(folder.id, [...ancestors, folder.id])}{renderSets(folder.id)}
        {!ids.length ? <p>問題セットがありません</p> : null}
      </div></div>
    </div>;
  });
  return <div className="publish-picker">
    <p className="publish-picker__help">□で選択 · フォルダ名を押すと中を表示</p>
    {renderFolders()}{renderSets()}
    {!data.problemSets.length ? <p>公開できる問題セットがありません</p> : null}
  </div>;
}
