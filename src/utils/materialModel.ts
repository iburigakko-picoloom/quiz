import type { MaterialReference } from '../types';

export interface MaterialPage { id: string; kind: 'pdf' | 'blank'; pdfPage?: number }
export interface StudyMaterial { id: string; title: string; pages: MaterialPage[] }
export interface MaterialIndex { kind: 'quiz-material-index'; version: 1; problemSetId: string; materials: StudyMaterial[]; updatedAt: string }
export interface MaterialFile { kind: 'quiz-material-file'; version: 1; materialId: string; dataUrl: string; updatedAt: string }
export const MAX_MATERIAL_PDF_BYTES = 50 * 1024 * 1024;
export const MATERIAL_BUCKET = 'quiz-material-pdfs';
export interface RemoteMaterialFile {
  kind: 'quiz-material-remote-file'; version: 1; materialId: string; updatedAt: string;
  bucket: typeof MATERIAL_BUCKET; path: string; sha256: string; size: number;
}

export function isMaterialFile(value: unknown): value is MaterialFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as MaterialFile;
  if (file.kind !== 'quiz-material-file' || file.version !== 1 || typeof file.materialId !== 'string'
    || !file.materialId || typeof file.updatedAt !== 'string' || typeof file.dataUrl !== 'string') return false;
  const prefix = 'data:application/pdf;base64,';
  if (!file.dataUrl.startsWith(prefix)) return false;
  const length = file.dataUrl.length - prefix.length;
  const padding = file.dataUrl.endsWith('==') ? 2 : file.dataUrl.endsWith('=') ? 1 : 0;
  return length > 0 && length % 4 === 0 && length / 4 * 3 - padding <= MAX_MATERIAL_PDF_BYTES;
}

export function isRemoteMaterialFile(value: unknown): value is RemoteMaterialFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as RemoteMaterialFile;
  return file.kind === 'quiz-material-remote-file' && file.version === 1 && typeof file.materialId === 'string'
    && !!file.materialId && typeof file.updatedAt === 'string' && file.bucket === MATERIAL_BUCKET
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)
    && typeof file.path === 'string' && /^[a-f0-9-]{36}\/[a-f0-9]{64}\.pdf$/.test(file.path)
    && file.path.endsWith('/' + file.sha256 + '.pdf')
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_MATERIAL_PDF_BYTES;
}

export function materialFileEntry(key: string, raw: string): MaterialFile | RemoteMaterialFile | null {
  if (!key.startsWith('quizMake:notes:') || !key.includes(':__material_pdf_')) return null;
  try {
    const file: unknown = JSON.parse(raw);
    return (isMaterialFile(file) || isRemoteMaterialFile(file)) && key.endsWith(':__material_pdf_' + file.materialId) ? file : null;
  } catch { return null; }
}

/** Only PDF bytes are excluded from the existing metadata/handwriting quota. */
export function materialMetadataOnly<T extends { localStorage: Record<string, string>; indexedDbNotes?: Record<string, string> }>(payload: T): T {
  const strip = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([key, raw]) => {
    const file = materialFileEntry(key, raw);
    return [key, file?.kind === 'quiz-material-file' ? JSON.stringify({ ...file, dataUrl: '[separate PDF]' }) : raw];
  }));
  return { ...payload, localStorage: strip(payload.localStorage), indexedDbNotes: strip(payload.indexedDbNotes ?? {}) };
}

export function insertMaterialPage(material: StudyMaterial, page: MaterialPage, position: number): StudyMaterial {
  if (material.pages.some(item => item.id === page.id)) throw new Error('ページIDが重複しています。');
  const pages = [...material.pages]; pages.splice(Math.max(0, Math.min(pages.length, position)), 0, page);
  return { ...material, pages };
}
export function moveMaterialPage(material: StudyMaterial, pageId: string, position: number): StudyMaterial {
  const page = material.pages.find(item => item.id === pageId);
  if (!page) throw new Error('ページが見つかりません。');
  const pages = material.pages.filter(item => item.id !== pageId); pages.splice(Math.max(0, Math.min(pages.length, position)), 0, page);
  return { ...material, pages };
}

export function normalizeMaterialReferences(value: unknown): MaterialReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.filter((ref): ref is MaterialReference => !!ref && typeof ref === 'object'
    && typeof ref.materialId === 'string' && ref.materialId.length > 0 && ref.materialId.length <= 200
    && typeof ref.pageId === 'string' && ref.pageId.length > 0 && ref.pageId.length <= 200);
  return refs.length ? [...new Map(refs.map(ref => [JSON.stringify([ref.materialId, ref.pageId]), { materialId: ref.materialId, pageId: ref.pageId }])).values()] : undefined;
}

export function validMaterialRecord(value: Record<string, unknown>): boolean {
  if (value.version !== 1 || typeof value.updatedAt !== 'string') return false;
  if (value.kind === 'quiz-material-file') return isMaterialFile(value);
  if (value.kind === 'quiz-material-remote-file') return isRemoteMaterialFile(value);
  if (value.kind !== 'quiz-material-index' || typeof value.problemSetId !== 'string' || !Array.isArray(value.materials)) return false;
  const ids = new Set<string>();
  return value.materials.every(material => {
    if (!material || typeof material.id !== 'string' || ids.has(material.id) || typeof material.title !== 'string' || !Array.isArray(material.pages) || !material.pages.length) return false;
    ids.add(material.id);
    const pageIds = new Set<string>();
    return material.pages.every((page: MaterialPage) => {
      if (!page || typeof page.id !== 'string' || pageIds.has(page.id)) return false;
      pageIds.add(page.id);
      return page.kind === 'blank' || (page.kind === 'pdf' && Number.isInteger(page.pdfPage) && (page.pdfPage ?? 0) > 0);
    });
  });
}

export function materialReferencePrompt(material: StudyMaterial): string {
  return '\n参照元の登録済み資料です。同じPDFを添付します。各問題に materialReferences: [{"materialId":"' + material.id + '","pageId":"対応するページID"}] を追加してください。ページ番号から次の対応表を使い、IDを変更・推測しないでください。参照箇所が不明なら空配列にしてください。\n'
    + JSON.stringify(material.pages.filter(page => page.kind === 'pdf').map(page => ({ pdfPage: page.pdfPage, pageId: page.id })));
}
