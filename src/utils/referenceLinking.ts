import type { AppData, MaterialReference, Question } from '../types';
import type { StudyMaterial } from './materialModel';

export interface ReferenceLink { questionId: string; sourcePage: string; reference: MaterialReference; references?: MaterialReference[] }
/** Parse explicit page expressions, never trailing chapter/question numbers. */
export function referencePages(text: string): number[] {
  const value = text.normalize('NFKC');
  const expression = '(\\d+(?:\\s*[-–—~〜～]\\s*\\d+)?(?:\\s*[,、]\\s*\\d+(?:\\s*[-–—~〜～]\\s*\\d+)?)*)';
  const pattern = new RegExp('(?:\\b(?:pp?\\.?|pages?)\\s*' + expression + '|(?:第\\s*)?' + expression + '\\s*(?:ページ|頁|p\\b)|ページ\\s*' + expression + ')', 'gi');
  const pages: number[] = [];
  for (const match of value.matchAll(pattern)) {
    if (/^\.\d/.test(value.slice(match.index! + match[0].length))) return [];
    const group = match[1] ?? match[2] ?? match[3];
    for (const part of group.split(/[,、]/)) {
      const range = part.trim().split(/\s*[-–—~〜～]\s*/).map(Number);
      const start = range[0], end = range[1] ?? start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 100) return [];
      for (let n = start; n <= end; n++) pages.push(n);
      if (pages.length > 100) return [];
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}
export function referencePage(text: string): number | null {
  const pages = referencePages(text);
  return pages.length === 1 ? pages[0] : null;
}
export function referenceCandidates(questions: Question[], material: StudyMaterial, offset = 0) {
  return questions.filter(q => !q.materialReferences?.length).map(question => {
    const numbers = referencePages(question.sourcePage ?? '');
    const matches = numbers.map(number => material.pages.find(p => p.kind === 'pdf' && p.pdfPage === number + offset));
    const pages = matches.every(Boolean) ? matches.filter(p => p !== undefined) : [];
    return { question, number: numbers[0] ?? null, pages, page: pages[0], reason: !numbers.length ? 'ページを特定できません' : !pages.length ? 'PDFの範囲外です' : '' };
  });
}
export function applyReferenceLinks(data: AppData, setId: string, links: ReferenceLink[], updatedAt: string): AppData {
  const ids = new Set<string>();
  for (const link of links) {
    const question = data.questions.find(q => q.id === link.questionId && q.setId === setId);
    const references = link.references ?? [link.reference];
    if (ids.has(link.questionId) || !question || (question.sourcePage ?? '') !== link.sourcePage || question.materialReferences?.length || !references.length || references.length > 100 || references.some(r => !r.materialId || !r.pageId)) throw new Error('問題または参照が変更されています。候補を開き直してください。');
    ids.add(link.questionId);
  }
  const map = new Map(links.map(link => [link.questionId, link.references ?? [link.reference]]));
  return { ...data, questions: data.questions.map(q => map.has(q.id) ? { ...q, materialReferences: map.get(q.id)!, updatedAt } : q) };
}
