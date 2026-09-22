import { useId } from 'react';
import type { FolderColor } from '../types';
import { FOLDER_COLORS } from '../utils/folderColors';
import { FolderOutlineIcon } from './UiIcons';
import './FolderColorPicker.css';

export function FolderColorPicker({ value, onChange, disabled = false }: {
  value: FolderColor;
  onChange: (color: FolderColor) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="folder-color-picker" disabled={disabled}>
    <legend>フォルダの色</legend>
    <div className="folder-color-picker__grid">
      {FOLDER_COLORS.map((color) => <label key={color.value} className="folder-color-picker__option">
        <input type="radio" name={name} value={color.value} checked={value === color.value} onChange={() => onChange(color.value)} />
        <span className="folder-color-picker__preview">
          <FolderOutlineIcon size={36} folderColor={color.value} />
          <span>{color.label}</span>
          {value === color.value ? <span className="folder-color-picker__check" aria-hidden="true">✓</span> : null}
        </span>
      </label>)}
    </div>
  </fieldset>;
}
