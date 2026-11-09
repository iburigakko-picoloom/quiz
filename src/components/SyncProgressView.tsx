import type { SyncProgress } from '../utils/syncAttemptStatus';
import { syncStageLabel } from '../utils/syncStatusReason';

const amount = (value: number, unit: SyncProgress['unit']) => unit === 'bytes'
  ? value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`
  : `${value.toLocaleString('ja-JP')} ${unit === 'parts' ? '分割' : '件'}`;

/** Percentages describe only measurable work in the current stage. */
export function SyncProgressView({complete, progress, step, stopped = false}: {
  complete: boolean; progress?: SyncProgress; step: string; stopped?: boolean;
}) {
  const percent = complete ? 100 : progress?.total != null && progress.total > 0
    ? Math.floor(progress.completed / progress.total * 100) : undefined;
  const label = complete ? '同期完了' : progress?.label ?? syncStageLabel(step);
  return <div className="sync-progress">
    <div className="sync-progress__label"><strong>{stopped ? '一時停止：' : ''}{label}</strong>{percent !== undefined ? <span>{percent}%</span> : null}</div>
    <div className={`sync-progress__track${percent === undefined && !stopped ? ' is-indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent === undefined ? label : `${label} ${percent}%`}>
      <span className="sync-progress__fill" style={{width:percent === undefined ? '30%' : `${percent}%`}}/>
    </div>
    {!complete && progress && (progress.total !== null || progress.completed > 0) ? <p className="sync-progress__count">{amount(progress.completed,progress.unit)}{progress.total !== null ? ` / ${amount(progress.total,progress.unit)}` : progress.unit === 'bytes' ? ' 受信済み' : ' 完了'}</p> : null}
  </div>;
}
