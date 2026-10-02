import { useState } from 'react';
import type { AppData, Question } from '../types';
import { Layout } from '../components/Layout';
import { Header } from '../components/Header';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useStudyPlans } from '../hooks/useStudyPlans';
import { deletePlan, PLAN_PREFIX, savePlan } from '../utils/studyPlanStorage';
import { planStatus, scheduleFor, studyDay, type StudyPlan } from '../utils/studyPlans';
import './PlansScreen.css';

export function PlansScreen({ data, planId, onBack, onCreate, onOpen, onEdit, onStart }: { data: AppData; planId?: string; onBack: () => void; onCreate: (setId?: string) => void; onOpen: (id: string) => void; onEdit: (id: string) => void; onStart: (questions: Question[], plan: StudyPlan) => void }) {
  const { entries, error } = useStudyPlans(data.answerLogs);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const entry = entries.find(e => e.plan.id === planId);
  const togglePause = async () => {
    if (!entry || busy) return;
    setBusy(true); setActionError('');
    try {
      const plan = entry.plan; const day = studyDay(new Date(), plan.timeZone); const schedule = scheduleFor(plan, day);
      await savePlan({ ...plan, updatedAt: new Date().toISOString(), schedules: [...plan.schedules.filter(s => s.effectiveDay < day), { ...schedule, effectiveDay: day, paused: !schedule.paused }, ...plan.schedules.filter(s => s.effectiveDay > day).map(s => ({ ...s, paused: !schedule.paused }))] }, localStorage.getItem(PLAN_PREFIX + plan.id));
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : '保存できません。'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!entry || busy) return; setBusy(true);
    try { await deletePlan(entry.plan, localStorage.getItem(PLAN_PREFIX + entry.plan.id)!); onBack(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : '削除できません。'); }
    finally { setBusy(false); setConfirmDelete(false); }
  };
  const status = entry ? planStatus(entry.plan, data, entry.daily) : null;
  return <Layout><div className="plans-screen">
    <Header title={planId ? '計画の詳細' : '学習計画'} leftLabel="戻る" onLeft={onBack} right={!planId ? <button className="plan-header-button" onClick={() => onCreate()}>作成</button> : undefined} />
    <main className="plans-body">
      {error || actionError ? <p role="alert" className="plan-warning">{error || actionError}</p> : null}
      {!planId ? <>
        <p className="plan-muted">期限までに1周する計画と、日々の習慣を一緒に使えます。</p>
        {!entries.length && !error ? <div className="plan-card"><h2>自分に合う計画を作ろう</h2><p>問題セットを選び、対象の版と範囲を固定します。</p><button className="plan-primary" onClick={() => onCreate()}>計画を作成</button></div> : null}
        {entries.map(({ plan, daily }) => <button key={plan.id} className="plan-card plan-list-card" onClick={() => onOpen(plan.id)}><PlanSummary plan={plan} data={data} daily={daily} /><span aria-hidden="true">›</span></button>)}
      </> : entry && status ? <>
        <section className="plan-card"><PlanSummary {...entry} data={data} /><p className="plan-muted">学習日：{entry.plan.timeZone}（固定）</p><p>対象：{entry.plan.setTitle} / 固定した{status.total}問</p><p className="plan-muted">{entry.plan.sourceVersionId ? `公開版 ${entry.plan.sourceVersionId.slice(0, 8)}` : '端末内の作成時の版'}</p>
          <dl className="plan-metrics"><div><dt>1周の回答済み</dt><dd>{status.answered}/{status.total}問</dd></div><div><dt>当日の達成</dt><dd>{status.done}/{status.goal}問</dd></div><div><dt>対象版の正答率</dt><dd>{status.accuracy === null ? '—' : `${status.accuracy}%`}</dd></div><div><dt>対象版の回答回数</dt><dd>{status.answerCount}回</dd></div></dl>
          {status.expired ? <p className="plan-warning">期限を過ぎています。期限は変更していません。編集で今後の予定を変更できます。</p> : null}
          {status.missing ? <p className="plan-warning">{status.missing}問が変更・削除されています。固定した分母は変えていません。現在版で作り直すと、対象と実績の違いを確認できます。</p> : null}
          <div className="plan-actions"><button disabled={busy} onClick={() => onEdit(entry.plan.id)}>編集</button><button disabled={busy} onClick={() => void togglePause()}>{status.paused ? '再開' : '休止'}</button><button disabled={busy} onClick={() => setConfirmDelete(true)}>削除</button></div>
          {status.missing ? <button onClick={() => onCreate(entry.plan.setId)}>現在版で新しい計画を作る</button> : null}
        </section>
        <section className="plan-card"><h2>今日の対象を確認</h2><p>{entry.plan.setTitle}</p><p>{scheduleFor(entry.plan, entry.daily.day).kind === 'deadline' ? '固定版の未回答' : '固定版の今日まだ回答していない問題（復習を含む）'}</p><strong>{status.questions.length}問</strong><ol className="plan-question-preview">{status.questions.slice(0, 4).map(q => <li key={q.id}>{q.question}</li>)}</ol>
          {status.goal === 0 ? <p className="plan-muted">今日は予定のない日です。フォルダから自由に学習できます。</p> : null}
          <button className="plan-primary" disabled={status.paused || status.expired || !status.questions.length} onClick={() => onStart(status.questions, entry.plan)}>この{status.questions.length}問を演習する</button>
          <p className="plan-muted">同じ日の同じ問題は1問として数えます。回答回数・復習状態はそれぞれ別の記録です。</p>
        </section>
      </> : !error ? <p>計画を読み込み中、または削除されています。<button onClick={onBack}>一覧へ戻る</button></p> : null}
    </main>
    <ConfirmDialog open={confirmDelete} title="計画を削除しますか？" message="計画と日次目標を削除します。問題セットと保存済みの回答は残ります。" confirmLabel="削除" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
  </div></Layout>;
}
export function PlanSummary({ plan, daily, data }: { plan: StudyPlan; daily: import('../utils/studyPlans').PlanDay; data: AppData }) {
  const s = planStatus(plan, data, daily); const schedule = scheduleFor(plan, daily.day);
  return <div className="plan-summary"><span className="plan-kind">{schedule.kind === 'deadline' ? '期限型' : '習慣型'}{s.paused ? ' · 休止中' : ''}</span><strong>{plan.title}</strong><span>{plan.setTitle}：{s.expired ? '期限超過' : s.todayComplete ? '今日の目標達成' : `今日あと${s.remaining}問`}</span><small>{s.done}/{s.goal}問{schedule.kind === 'deadline' ? ` · ${schedule.deadline}まで · 未回答あと${s.total - s.answered}問` : ' · 同日の反復は1問'}</small><progress max={Math.max(1, s.goal)} value={Math.min(s.done, s.goal)} aria-label={`${plan.title} 今日の計画 ${s.done}/${s.goal}問`} /></div>;
}
