import type { Question } from '../types';
import type { StudyMaterial } from './materialModel';

export function relatedMaterialQuestions(questions: readonly Question[], materialId: string, pageId: string) {
  return questions.filter(question => question.materialReferences?.some(reference => reference.materialId === materialId && reference.pageId === pageId));
}
export const normalizedMaterialText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/gu, ' ').trim();
export interface SearchMark { points: string }
export interface MaterialTextMatch { pageId: string; pageNumber: number; pdfPage: number; excerpt: string; marks?: SearchMark[] }
export interface MaterialTextResult { matches: MaterialTextMatch[]; textPages: number; imagePages: number; limited: boolean }
interface SearchablePdf { getPage(page: number): Promise<{ getViewport?(options: {scale: number}): {width:number;height:number;convertToViewportPoint(x:number,y:number):number[]}; getTextContent(): Promise<{items: readonly ({str?: string; hasEOL?: boolean} | object)[]}>; cleanup(): void }> }

/** Search the immutable PDF page number but return the stable material page ID.
 * No text, answer content or handwriting is persisted or sent to a server. */
export async function searchMaterialDocument(document: SearchablePdf, material: StudyMaterial, query: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<MaterialTextResult> {
  const needle = normalizedMaterialText(query);
  const result: MaterialTextResult = { matches: [], textPages: 0, imagePages: 0, limited: false };
  if (!needle) return result;
  const pages = material.pages.flatMap((page, index) => page.kind === 'pdf' && page.pdfPage ? [{...page, index}] : []);
  for (let index = 0; index < pages.length; index++) {
    signal?.throwIfAborted();
    const item = pages[index], page = await document.getPage(item.pdfPage!);
    try {
      const content = await page.getTextContent();
      signal?.throwIfAborted();
      const text = normalizedMaterialText(content.items.map(item => 'str' in item && typeof item.str === 'string' ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ') : '').join(''));
      if (!text) result.imagePages++;
      else {
        result.textPages++;
        const exact = text.indexOf(needle);
        const searchable = exact >= 0 ? text : text.replace(/\s/gu, '');
        const term = exact >= 0 ? needle : needle.replace(/\s/gu, '');
        const found = searchable.indexOf(term);
        if (found >= 0) {
          if (result.matches.length < 200) result.matches.push({ pageId: item.id, pageNumber: item.index + 1, pdfPage: item.pdfPage!, excerpt: searchable.slice(Math.max(0, found - 32), found + term.length + 72), marks: searchMarks(content.items, needle, page.getViewport?.({scale:1})) });
          else result.limited = true;
        }
      }
    } finally { page.cleanup(); }
    onProgress?.(index + 1, pages.length);
  }
  return result;
}
export async function searchMaterialPdf(ownerId: string, material: StudyMaterial, query: string, signal: AbortSignal, onProgress?: (done: number, total: number) => void) {
  const [{openPdf, pdfBytes}, {loadMaterialFile}] = await Promise.all([import('./pdfReader'), import('./materialStorage')]);
  signal.throwIfAborted();
  const raw = await loadMaterialFile(ownerId, material.id);
  signal.throwIfAborted();
  const task = openPdf(pdfBytes(raw));
  const cancel = () => { void task.destroy(); };
  signal.addEventListener('abort', cancel, {once: true});
  try { return await searchMaterialDocument(await task.promise, material, query, signal, onProgress); }
  finally { signal.removeEventListener('abort', cancel); await task.destroy(); }
}

/** Transient polygons in page percentages; never written into PDF or ink. */
export function searchMarks(items: readonly object[], query: string, viewport?: {width:number;height:number;convertToViewportPoint(x:number,y:number):number[]}): SearchMark[] {
  if (!viewport) return [];
  const needle = normalizedMaterialText(query).replace(/\s/gu,'');
  if (!needle) return [];
  const runs = items.flatMap(value => {
    const item = value as {str?:string;transform?:number[];width?:number;height?:number;dir?:string};
    return typeof item.str==='string' ? [{item,text:normalizedMaterialText(item.str).replace(/\s/gu,'')}] : [];
  });
  const text=runs.map(run=>run.text).join(''), ranges: Array<[number,number]>=[];
  for(let start=text.indexOf(needle);start>=0;start=text.indexOf(needle,start+needle.length)) ranges.push([start,start+needle.length]);
  let offset=0; const marks:SearchMark[]=[];
  for(const {item,text:run} of runs){
    const start=offset;offset+=run.length;
    if(!item.transform || !run.length)continue;
    const [a,b,c,d,e,f]=item.transform, length=Math.hypot(a,b),height=Math.hypot(c,d);
    if(!length || !height || !item.width)continue;
    for(const [from,to] of ranges){
      if(to<=start || from>=offset)continue;
      let left=Math.max(0,from-start)/run.length,right=Math.min(run.length,to-start)/run.length;
      if(item.dir==='rtl')[left,right]=[1-right,1-left];
      const point=(fraction:number,up:number)=>viewport.convertToViewportPoint(e+a/length*item.width!*fraction+c/height*height*up,f+b/length*item.width!*fraction+d/height*height*up).map((v,i)=>v/(i?viewport.height:viewport.width)*100).join(',');
      marks.push({points:[point(left,-.2),point(right,-.2),point(right,.85),point(left,.85)].join(' ')});
    }
  }
  return marks;
}
