export const STUDY_COMPANION_KEY = 'quiz-make-study-companion';
export const STUDY_COMPANION_EVENT = 'quiz-make-study-companion-change';
export function isStudyCompanionEnabled(): boolean {
  try { return localStorage.getItem(STUDY_COMPANION_KEY) !== 'off'; } catch { return true; }
}
export function setStudyCompanionEnabled(enabled: boolean): void {
  localStorage.setItem(STUDY_COMPANION_KEY, enabled ? 'on' : 'off');
  window.dispatchEvent(new Event(STUDY_COMPANION_EVENT));
}
export function companionPraise(answered: number, correct: number): string {
  if (!answered) return 'また一緒に学習しよう！';
  if (correct === answered) return '全問正解！よく頑張ったね！';
  return '最後までよく頑張ったね！';
}
