import type { Question } from '../types';
import { getAnswerIndexes } from '../utils/quiz';
import { questionRevision } from '../utils/studyPlans';
import { readPlans } from '../utils/studyPlanStorage';

export function QuestionEditNotice({ original, next }: { original: Question; next: Question }) {
  if (questionRevision(original) === questionRevision(next)) return null;
  const reset = original.question.trim() !== next.question.trim() || JSON.stringify(original.choices) !== JSON.stringify(next.choices)
    || JSON.stringify(getAnswerIndexes(original)) !== JSON.stringify(getAnswerIndexes(next));
  let plans: number | null = null;
  try { plans = readPlans().filter(plan => plan.targets.some(target => target.questionId === original.id)).length; } catch { /* Preserve the editor when plan storage cannot be read. */ }
  return <aside className="plan-warning" aria-label="変更による影響">
    <p>旧版の回答履歴は残ります。{reset ? '現在版の復習状態・成績は初期化します。' : '復習状態は変更しません。'}</p>
    {plans ? <p>固定計画{plans}件の対象・分母は変わりません。変更後の回答は旧版の目標に加算されません。</p> : null}
    {plans === null ? <p>計画への影響を読み取れません。固定計画の対象・分母は自動では変わりません。</p> : null}
    {original.origin ? <p>編集後の回答は、共通の公開版の共有進捗に含めません。</p> : null}
    <details><summary>旧版と成績について</summary><p>過去の正誤は当時の内容と正解に対応する履歴として保持します。全回答の実績には残り、変更後の正解へ旧成績を足しません。固定計画の版を更新するときは、計画の編集で対象と影響を確認してください。</p></details>
  </aside>;
}
