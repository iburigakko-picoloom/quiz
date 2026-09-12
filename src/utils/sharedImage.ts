import type { AppData } from '../types';

export const SHARE_IMAGE_CACHE = 'quiz-make-shared-images-v1';
const TARGET_KEY = 'quiz-make-image-target-v1';
export function rememberImageTarget(questionId: string) {
  try { localStorage.setItem(TARGET_KEY, JSON.stringify({questionId, updatedAt: Date.now()})); } catch { /* Receiver still allows an explicit choice. */ }
}
export function readImageTarget(): string {
  try {
    const target = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null');
    return target && typeof target.questionId === 'string' && Number.isFinite(target.updatedAt) && Date.now() >= target.updatedAt && Date.now() - target.updatedAt < 30 * 60_000 ? target.questionId : '';
  } catch { return ''; }
}
export function appendSharedImage(data: AppData, questionId: string, originalQuestion: string, image: string, shareId: string): AppData {
  if (!/^[a-f0-9-]{36}$/.test(shareId) || !/^!\[添付画像\]\(data:image\/jpeg;base64,[a-zA-Z0-9+/=]+\)$/.test(image)) throw new Error('画像データを確認できません。');
  const question = data.questions.find(q=>q.id===questionId);
  if (!question || question.question !== originalQuestion) throw new Error('問題が変更・削除されています。追加先を確認してください。');
  const marker = `<!-- qm-image:${shareId} -->`;
  const existing = question.detailedAnswer?.body ?? question.detailedExplanation ?? '';
  if (existing.includes(marker)) return data;
  const body = `${existing}${existing.trim() ? '\n\n' : ''}${marker}\n${image}`;
  if (body.length > 250_000) throw new Error('画像を含む解説が保存上限を超えます。画像を小さくしてください。');
  const now = new Date().toISOString();
  return {...data, questions:data.questions.map(q=>q.id!==questionId?q:{...q,detailedExplanation:body,detailedAnswer:{...q.detailedAnswer,body,imageIds:q.detailedAnswer?.imageIds??[],updatedAt:now},updatedAt:now})};
}
