import type { AppData, FolderColor } from '../types';

export const FOLDER_COLORS: ReadonlyArray<{ value: FolderColor; label: string; back: string; edge: string; front: string; light: string }> = [
  { value: 'blue', label: '青', back: '#81d0f5', edge: '#519be9', front: '#6564cf', light: '#6bbaf2' },
  { value: 'teal', label: '青緑', back: '#6ce7df', edge: '#11bdbb', front: '#0095a5', light: '#3bdad0' },
  { value: 'green', label: '緑', back: '#a6ec86', edge: '#39c66b', front: '#159554', light: '#65da7a' },
  { value: 'orange', label: 'オレンジ', back: '#ffd178', edge: '#ff9d34', front: '#dc6b20', light: '#ffb54a' },
  { value: 'red', label: '赤', back: '#ff9d9e', edge: '#f45868', front: '#d93550', light: '#ff7380' },
  { value: 'pink', label: 'ピンク', back: '#ffabd3', edge: '#ed5caa', front: '#ca338b', light: '#ff83c0' },
  { value: 'purple', label: '紫', back: '#c8a7ff', edge: '#9162e9', front: '#7045c8', light: '#a87aef' },
  { value: 'gray', label: 'グレー', back: '#d4deeb', edge: '#8b9db6', front: '#52647f', light: '#a4b4ca' },
];
export const isFolderColor = (value: unknown): value is FolderColor => FOLDER_COLORS.some(color => color.value === value);
export const folderPalette = (value?: string) => FOLDER_COLORS.find(color => color.value === value) ?? FOLDER_COLORS[0];
export function changeFolderColor(data: AppData, id: string, color: string): AppData {
  if (!isFolderColor(color)) throw new Error('フォルダの色を選んでください。');
  if (!data.folders.some(folder => folder.id === id)) throw new Error('フォルダが見つかりません。');
  return { ...data, folders: data.folders.map(folder => folder.id === id ? { ...folder, color, updatedAt: new Date().toISOString() } : folder) };
}
