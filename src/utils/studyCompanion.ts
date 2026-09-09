export const STUDY_COMPANION_KEY = 'quiz-make-study-companion';
export const STUDY_COMPANION_EVENT = 'quiz-make-study-companion-change';
export function isStudyCompanionEnabled(): boolean {
  try { return localStorage.getItem(STUDY_COMPANION_KEY) !== 'off'; } catch { return true; }
}
export function setStudyCompanionEnabled(enabled: boolean): void {
  localStorage.setItem(STUDY_COMPANION_KEY, enabled ? 'on' : 'off');
  window.dispatchEvent(new Event(STUDY_COMPANION_EVENT));
}
function pickMessage(messages: string[], variant: number): string {
  return messages[Math.min(messages.length - 1, Math.max(0, Math.floor(variant * messages.length)))];
}
export function companionGreeting(variant = 0): string {
  return pickMessage(['学習頑張ろう！', '今日も一緒に学ぼう！', 'まずは1問、やってみよう！', '自分のペースで進もうね！', '少しずつで大丈夫！', 'いつでも応援してるよ！'], variant);
}
export function companionPraise(answered: number, correct: number, variant = 0): string {
  if (!answered) return pickMessage(['また一緒に学習しよう！', 'ひと休みして、また会おうね！'], variant);
  if (correct === answered) return pickMessage(['全問正解！よく頑張ったね！', '全問正解！すごいね！', '全問正解！ばっちりだね！'], variant);
  return pickMessage(['最後までよく頑張ったね！', 'おつかれさま！ひと休みしよう！', '今日の積み重ね、えらいね！', '一緒に取り組めてうれしいよ！', '最後まで挑戦できたね！'], variant);
}
