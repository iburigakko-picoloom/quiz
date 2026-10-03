import { useEffect, useRef, useState } from 'react';
import type { AppData } from '../types';
import { Layout } from '../components/Layout';
import { Header } from '../components/Header';
import { createId } from '../utils/id';
import { getStudyTimeZone, PLAN_PREFIX, readPlans, savePlan } from '../utils/studyPlanStorage';
import { nextDay, parseStudyPlan, scheduleFor, snapshotTargets, studyDay, validDay, validTimeZone, type PlanKind, type StudyPlan } from '../utils/studyPlans';
import './PlansScreen.css';

export function PlanEditorScreen({ data, planId, initialSetId, onBack, onSaved, onDirtyChange }: { data: AppData; planId?: string; initialSetId?: string; onBack: () => void; onSaved: (id: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const originalRaw = useRef(planId ? localStorage.getItem(PLAN_PREFIX + planId) : null);
  const [original] = useState(() => { try { return originalRaw.current ? parseStudyPlan(originalRaw.current) : null; } catch { return null; } });
  const [draftId] = useState(() => original?.id ?? createId('plan'));
  const attemptedSave = useRef<{ committedRaw: string | null }>({ committedRaw: null });
  const day = studyDay(new Date(), original?.timeZone ?? getStudyTimeZone());
  const schedule = original ? scheduleFor(original, nextDay(day)) : null;
  const [setId, setSetId] = useState(original?.setId ?? initialSetId ?? data.problemSets[0]?.id ?? '');
  const [title, setTitle] = useState(original?.title ?? '');
  const [kind, setKind] = useState<PlanKind>(schedule?.kind ?? 'deadline');
  const [deadline, setDeadline] = useState(schedule?.deadline ?? nextDay(day, 30));
  const [timeZone, setTimeZone] = useState(original?.timeZone ?? getStudyTimeZone());
  const [weekdays, setWeekdays] = useState(schedule?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [dailyCounts, setDailyCounts] = useState(schedule?.dailyCounts ?? [10, 10, 10, 10, 10, 10, 10]);
  const [holidays, setHolidays] = useState(schedule?.holidays.join(', ') ?? '');
  const [category, setCategory] = useState('all');
  const [start, setStart] = useState(1); const [end, setEnd] = useState(10000);
  const [error, setError] = useState(planId && !original ? '編集する計画を読み込めません。' : '');
  const [busy, setBusy] = useState(false); const saving = useRef(false);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const questions = data.questions.filter(q => q.setId === setId);
  const selected = questions.filter(q => category === 'all' || q.category === category).slice(Math.max(0, start - 1), end);
  const set = data.problemSets.find(s => s.id === setId);
  const dailyRoutine = weekdays.length === 7 && dailyCounts.every(n => n === dailyCounts[0]);
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const targetCount = original?.targets.length ?? selected.length;
  const rangeLabel = original ? '作成時の範囲・版を維持' : category === 'all' && start === 1 && end >= questions.length ? '全ての問題' : `${category === 'all' ? '全分類' : category || '未分類'} · ${start}〜${Math.min(end, questions.filter(q => category === 'all' || q.category === category).length)}問目`;
  const scheduleLabel = kind === 'deadline' ? `${deadline}までに1周` : dailyRoutine ? `毎日${dailyCounts[0]}問` : weekdays.map(d => `${weekdayNames[d]} ${dailyCounts[d]}問`).join('・');
  const dirty = () => onDirtyChange(true);
  const save = async () => {
    if (saving.current) return;
    setError('');
    const holidayList = holidays.split(/[\s,、]+/).filter(Boolean);
    if (!set || !validTimeZone(timeZone) || !validDay(deadline) || (kind === 'deadline' && (deadline < (original ? nextDay(day) : day) || deadline > nextDay(day, 3660))) || !holidayList.every(validDay) || !weekdays.length || !dailyCounts.every(n => Number.isInteger(n) && n >= 0 && n <= 10000) || (!original && !selected.length)) { setError('対象、期限、学習曜日、問題数、休日の日付を確認してください。'); return; }
    saving.current = true; setBusy(true);
    try {
      const now = new Date().toISOString(); const id = draftId;
      const effectiveDay = original ? nextDay(day) : studyDay(new Date(), timeZone);
      const nextSchedule = { effectiveDay, kind, deadline, weekdays, holidays: holidayList, dailyCounts, paused: schedule?.paused ?? false };
      const plan: StudyPlan = { schema: 1, id, title: title.trim() || set.title, setId, setTitle: original?.setTitle ?? set.title, sourceVersionId: original?.sourceVersionId ?? set.sourceVersionId, timeZone, createdAt: original?.createdAt ?? now, updatedAt: now, targets: original?.targets ?? snapshotTargets(selected, data.answerLogs), schedules: [...(original?.schedules.filter(s => s.effectiveDay < effectiveDay) ?? []), nextSchedule] };
      await savePlan(plan, originalRaw.current, attemptedSave.current); onDirtyChange(false); onSaved(id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存できません。入力は残っています。'); }
    finally { saving.current = false; setBusy(false); }
  };
  let duplicateCount = 0; try { duplicateCount = readPlans().filter(p => p.setId === setId).length; } catch { /* Saving reports malformed storage through its guarded write. */ }
  return <Layout><div className="plans-screen"><Header title={original ? '計画を編集' : '計画を作成'} leftLabel="戻る" onLeft={onBack} />
    <form className="plans-body plan-form" onChange={dirty} onSubmit={event => { event.preventDefault(); void save(); }}>
      {error ? <p className="plan-warning" role="alert">{error}</p> : null}
      <label>何を学ぶ？<select aria-label="問題集" disabled={Boolean(original)} value={setId} onChange={e => { setSetId(e.target.value); setCategory('all'); setStart(1); setEnd(10000); }}>{data.problemSets.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <fieldset><legend>どう続ける？</legend><div className="plan-segment"><button type="button" aria-pressed={kind === 'deadline'} onClick={() => { setKind('deadline'); dirty(); }}>期限までに1周</button><button type="button" aria-pressed={kind === 'habit'} onClick={() => { setKind('habit'); dirty(); }}>毎日○問</button></div></fieldset>
      {kind === 'deadline' ? <label>いつまで？<input aria-label="期限" type="date" min={original ? nextDay(day) : day} max={nextDay(day, 3660)} value={deadline} onChange={e => setDeadline(e.target.value)} required /></label> : dailyRoutine ? <label>毎日の問題数<input aria-label="毎日の問題数" type="number" min="0" max="10000" value={dailyCounts[0]} onChange={e => setDailyCounts(Array(7).fill(Number(e.target.value)))} /></label> : <p className="plan-muted">曜日ごとの目標を設定しています。<button type="button" className="plan-inline-button" onClick={() => { if (optionsRef.current) optionsRef.current.open = true; optionsRef.current?.querySelector<HTMLElement>('summary')?.focus(); }}>確認・変更</button></p>}
      <details ref={optionsRef} className="plan-options"><summary>詳細を変える（任意）</summary><div className="plan-options-body">
        <label>計画名<input value={title} onChange={e => setTitle(e.target.value)} placeholder={set?.title ?? '問題集名を使います'} maxLength={100} /><span className="plan-muted">空欄なら問題集名を使います。</span></label>
        {!original ? <fieldset><legend>出題範囲</legend><label>分類<select value={category} onChange={e => setCategory(e.target.value)}><option value="all">全て</option>{[...new Set(questions.map(q => q.category))].map(c => <option key={c} value={c}>{c || '未分類'}</option>)}</select></label><div className="plan-form-row"><label>範囲の先頭<input type="number" min="1" max={Math.max(1, questions.length)} value={start} onChange={e => setStart(Number(e.target.value))} /></label><label>範囲の末尾<input type="number" min={start} max="10000" value={end} onChange={e => setEnd(Number(e.target.value))} /></label></div></fieldset> : null}
        <fieldset><legend>学習曜日{kind === 'habit' ? 'と問題数' : ''}</legend><div className="plan-weekdays">{weekdayNames.map((label, i) => <div key={label}><label><input type="checkbox" checked={weekdays.includes(i)} onChange={e => setWeekdays(e.target.checked ? [...weekdays, i].sort() : weekdays.filter(d => d !== i))} />{label}</label>{kind === 'habit' ? <input type="number" min="0" max="10000" aria-label={`${label}曜日の問題数`} disabled={!weekdays.includes(i)} value={dailyCounts[i]} onChange={e => setDailyCounts(dailyCounts.map((n, d) => d === i ? Number(e.target.value) : n))} /> : null}</div>)}</div></fieldset>
        <label>休日（YYYY-MM-DD、カンマ区切り）<input value={holidays} onChange={e => setHolidays(e.target.value)} placeholder="2026-10-12, 2026-11-03" /></label>
        <label>学習日のタイムゾーン（作成後は固定）<input disabled={Boolean(original)} value={timeZone} onChange={e => setTimeZone(e.target.value)} list="plan-timezones" /><datalist id="plan-timezones"><option value="Asia/Tokyo" /><option value="UTC" /><option value="America/New_York" /></datalist></label>
        <p className="plan-muted">対象の追加・編集・削除で計画の問題数は変わりません。同日反復は達成を増やさず、休んだ分は翌日へ積みません。</p>
        {duplicateCount && !original ? <p className="plan-muted">この問題集の計画が{duplicateCount}件あります。同じ回答を各計画へ反映できます。</p> : null}
      </div></details>
      <section className="plan-card plan-confirmation" aria-label="保存する計画の確認"><h2>この内容で保存</h2><p><strong>{original?.setTitle ?? set?.title ?? '問題集を選択'}</strong></p><p>{rangeLabel} · {targetCount}問</p><p>{scheduleLabel}</p>{kind === 'deadline' && weekdays.length !== 7 ? <p className="plan-muted">学習曜日：{weekdays.map(d => weekdayNames[d]).join('・')}</p> : null}{holidays.trim() ? <p className="plan-muted">休日：{holidays}</p> : null}<p className="plan-muted">学習日の区切り：{timeZone}（固定）{original ? ' · 予定の変更は明日から' : ''}</p>{set?.sourceSetId && !set.sourceVersionId ? <p className="plan-warning">古いコピーの公開版は復元できません。端末内の計画として利用できます。</p> : null}</section>
      <button className="plan-primary" type="submit" disabled={busy || Boolean(planId && !original)}>{busy ? '保存中…' : 'この対象と予定で保存'}</button>
    </form>
  </div></Layout>;
}
