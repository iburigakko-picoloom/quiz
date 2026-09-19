import { loadCategoryNoteRaw, saveCategoryNoteRaw } from './noteStorage';
import { createId } from './id';
import { validMaterialRecord, MAX_MATERIAL_PDF_BYTES, type MaterialIndex, type MaterialFile, type StudyMaterial } from './materialModel';

export const materialIndexKey = (setId: string) => `quizMake:notes:${setId}:__materials_v1`;
export const materialFileKey = (setId: string, materialId: string) => `quizMake:notes:${setId}:__material_pdf_${materialId}`;
export const annotationCategory = (materialId: string, pageId: string) => `__material_ink_${materialId}_${pageId}`;
export async function loadMaterials(setId: string): Promise<MaterialIndex> {
  const raw = await loadCategoryNoteRaw(materialIndexKey(setId));
  if (!raw) return { kind: 'quiz-material-index', version: 1, problemSetId: setId, materials: [], updatedAt: new Date().toISOString() };
  const parsed = JSON.parse(raw);
  if (!validMaterialRecord(parsed) || parsed.kind !== 'quiz-material-index') throw new Error('資料情報を読み込めません。上書きせず、再読み込みしてください。');
  return parsed;
}
export async function saveMaterials(index: MaterialIndex) {
  if (!validMaterialRecord(index as unknown as Record<string, unknown>)) throw new Error('資料情報が不正です。');
  await saveCategoryNoteRaw(materialIndexKey(index.problemSetId), JSON.stringify({ ...index, updatedAt: new Date().toISOString() }));
}
export async function loadMaterialFile(setId: string, id: string): Promise<string> {
  const raw = await loadCategoryNoteRaw(materialFileKey(setId, id));
  const file = raw ? JSON.parse(raw) as MaterialFile : null;
  if (!file || !validMaterialRecord(file as unknown as Record<string, unknown>)) throw new Error('PDF本体が見つかりません。資料を保存した端末のバックアップを確認してください。');
  return file.dataUrl;
}
export async function storeMaterialPdf(setId: string, file: File, pageCount: number): Promise<StudyMaterial> {
  if (!file.size || file.size > MAX_MATERIAL_PDF_BYTES) throw new Error('PDFは1ファイル50MB以下にしてください。');
  const id = createId('material');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('PDFを読み込めません。'));
    reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(new Blob([file], { type: 'application/pdf' }));
  });
  await saveCategoryNoteRaw(materialFileKey(setId, id), JSON.stringify({ kind: 'quiz-material-file', version: 1, materialId: id, dataUrl, updatedAt: new Date().toISOString() }));
  return { id, title: file.name, pages: Array.from({ length: pageCount }, (_, index) => ({ id: createId('page'), kind: 'pdf' as const, pdfPage: index + 1 })) };
}
