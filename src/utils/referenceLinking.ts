import type { AppData, MaterialReference, Question } from '../types';
import type { StudyMaterial } from './materialModel';

export interface ReferenceLink { questionId: string; sourcePage: string; reference: MaterialReference }
/** Only one explicit page marker is accepted. Years, question numbers and ranges are not guessed. */
export function referencePage(text: string): number | null {
  const value = text.normalize('NFKC');
  const matches = [...value.matchAll(/(?:\b(?:pp?\.?|pages?)\s*(\d+)|(?:第\s*)?(\d+)\s*(?:ページ|頁|p\b)|ページ\s*(\d+))/gi)];
  if (matches.length !== 1 || /\d\s*(?:[-–—~〜～/,、.]|と|及び|and)\s*(?:p\.?\s*)?\d/i.test(value)) return null;
  const number = Number(matches[0][1] ?? matches[0][2] ?? matches[0][3]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
export function referenceCandidates(questions: Question[], material: StudyMaterial, offset = 0) {
  return questions.filter(q => !q.materialReferences?.length).map(question => {
    const number = referencePage(question.sourcePage ?? '');
    const page = number === null ? undefined : material.pages.find(p => p.kind === 'pdf' && p.pdfPage === number + offset);
    return { question, number, page, reason: number === null ? 'ページを特定できません' : !page ? 'PDFの範囲外です' : '' };
  });
}
export function applyReferenceLinks(data: AppData, setId: string, links: ReferenceLink[], updatedAt: string): AppData {
  const ids = new Set<string>();
  for (const link of links) {
    const question = data.questions.find(q => q.id === link.questionId && q.setId === setId);
    if (ids.has(link.questionId) || !question || (question.sourcePage ?? '') !== link.sourcePage || question.materialReferences?.length || !link.reference.materialId || !link.reference.pageId) throw new Error('問題または参照が変更されています。候補を開き直してください。');
    ids.add(link.questionId);
  }
  const map = new Map(links.map(link => [link.questionId, link.reference]));
  return { ...data, questions: data.questions.map(q => map.has(q.id) ? { ...q, materialReferences: [map.get(q.id)!], updatedAt } : q) };
}
