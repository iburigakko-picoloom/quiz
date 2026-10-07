import './SyncDataChoice.css';

interface SyncDataChoiceProps {
  name: string;
  value: string;
  title: string;
  timestamp: string;
  questionCount?: number;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}

export function SyncDataChoice({ name, value, title, timestamp, questionCount, note, checked, disabled, onChange }: SyncDataChoiceProps) {
  return (
    <label className={`sync-data-choice${checked ? ' sync-data-choice--selected' : ''}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} />
      <span className="sync-data-choice__content">
        <strong>{title}</strong>
        <span>{timestamp}</span>
        <small>{questionCount === undefined ? '問題件数不明' : `問題 ${questionCount.toLocaleString('ja-JP')}件`}</small>
        {note ? <small className="sync-data-choice__note">{note}</small> : null}
      </span>
    </label>
  );
}
