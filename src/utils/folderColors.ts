import type { AppData, FolderColor } from '../types';

export const FOLDER_COLORS: ReadonlyArray<{ value: FolderColor; label: string; back: string; edge: string; front: string; light: string }> = [
  { value: 'blue', label: '青', back: '#81d0f5', edge: '#519be9', front: '#6564cf', light: '#6bbaf2' },
  { value: 'teal', label: '青緑', back: '#8fe0df', edge: '#36aaa9', front: '#268d96', light: '#63c9c5' },
  { value: 'green', label: '緑', back: '#b1e3ab', edge: '#5aaf69', front: '#43855a', light: '#83c987' },
  { value: 'orange', label: 'オレンジ', back: '#ffda96', edge: '#edac52', front: '#d18539', light: '#f8be68' },
  { value: 'red', label: '赤', back: '#ffb1ad', edge: '#eb7477', front: '#c95160', light: '#f28b87' },
  { value: 'pink', label: 'ピンク', back: '#f6c1da', edge: '#dc83b5', front: '#b86096', light: '#ed9cc4' },
  { value: 'purple', label: '紫', back: '#d2c1f5', edge: '#a08ade', front: '#8161bc', light: '#b49ce8' },
  { value: 'gray', label: 'グレー', back: '#cbd5e1', edge: '#94a3b8', front: '#64748b', light: '#a7b4c4' },
];
export const isFolderColor = (value: unknown): value is FolderColor => FOLDER_COLORS.some(color => color.value === value);
export const folderPalette = (value?: string) => FOLDER_COLORS.find(color => color.value === value) ?? FOLDER_COLORS[0];
export function changeFolderColor(data: AppData, id: string, color: string): AppData {
  if (!isFolderColor(color)) throw new Error('フォルダの色を選んでください。');
  if (!data.folders.some(folder => folder.id === id)) throw new Error('フォルダが見つかりません。');
  return { ...data, folders: data.folders.map(folder => folder.id === id ? { ...folder, color, updatedAt: new Date().toISOString() } : folder) };
}
