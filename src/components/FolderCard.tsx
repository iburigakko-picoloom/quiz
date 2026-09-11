import type { Folder } from '../types';
import { FolderOutlineIcon } from './UiIcons';
import { formatDisplayDate } from '../utils/date';

interface FolderCardProps {
  folder: Folder;
  setCount: number;
  questionCount: number;
  reviewCount: number;
  correctRate: number;
  editMode: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

export function FolderCard({ folder, setCount, questionCount, reviewCount, correctRate, editMode, onOpen, onDelete }: FolderCardProps) {
  return (
    <div className="rounded-2xl bg-[#2A2A2A] p-3">
      <button type="button" onClick={onOpen} className="block h-[88px] w-full text-left active:scale-[0.99]" disabled={editMode}>
        <div className="flex h-full items-center gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center"><FolderOutlineIcon /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-base font-bold text-white">{folder.name}</h3>
              {!editMode ? <span className="shrink-0 text-xl font-semibold text-[#A3A3A3]">›</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold text-[#A3A3A3]">
              <span>セット {setCount}</span>
              <span>問題 {questionCount}</span>
              <span>復習 {reviewCount}</span>
              <span>正答率 {correctRate}%</span>
            </div>
            <p className="mt-1 text-[11px] font-semibold text-neutral-500">更新 {formatDisplayDate(folder.updatedAt)}</p>
          </div>
        </div>
      </button>

      {editMode ? (
        <button
          type="button"
          onClick={onDelete}
          className="mt-3 h-10 w-full rounded-2xl bg-rose-500/15 text-sm font-bold text-rose-200 active:scale-[0.98]"
        >
          フォルダ削除
        </button>
      ) : null}
    </div>
  );
}
