import type { PDFDocumentProxy } from 'pdfjs-dist';
import { annotationCategory, loadMaterialFile } from './materialStorage';
import { loadCategoryNoteRaw } from './noteStorage';
import type { MaterialPage } from './materialModel';
import { ByteBudgetLruCache, estimateDataUrlMemoryBytes, estimateRgbaPixelBytes } from '../components/noteMemory';

export interface MaterialPagePreview { url?: string; inkUrl?: string; aspect: number }
type Background = Omit<MaterialPagePreview, 'inkUrl'>;

/** Only a few neighbouring pages are requested; original PDF and ink stay separate. */
export class MaterialPreviewCache {
  private images = new ByteBudgetLruCache<string, Background>(32 * 1024 * 1024);
  private pending = new Map<string, Promise<Background>>();
  private document: { key: string; cancelled: boolean; task?: ReturnType<(typeof import('./pdfReader'))['openPdf']>; ready: Promise<PDFDocumentProxy> } | null = null;

  clear() {
    if (this.document) { this.document.cancelled = true; void this.document.task?.destroy(); }
    this.document = null; this.images.clear(); this.pending.clear();
  }

  private pdf(ownerId: string, materialId: string) {
    const key = `${ownerId}/${materialId}`;
    if (this.document?.key === key) return this.document.ready;
    this.clear();
    const session: NonNullable<MaterialPreviewCache['document']> = { key, cancelled: false, ready: Promise.resolve(null as unknown as PDFDocumentProxy) };
    this.document = session;
    session.ready = (async () => {
      const [{ openPdf, pdfBytes }, raw] = await Promise.all([import('./pdfReader'), loadMaterialFile(ownerId, materialId)]);
      if (session.cancelled) throw new Error('資料の読込を中止しました。');
      session.task = openPdf(pdfBytes(raw));
      return session.task.promise;
    })().catch(error => { if (this.document === session) this.clear(); throw error; });
    return session.ready;
  }

  private async background(ownerId: string, materialId: string, page: MaterialPage): Promise<Background> {
    if (page.kind === 'blank') return { aspect: 210 / 297 };
    const docPromise = this.pdf(ownerId, materialId);
    const session = this.document!;
    const key = `${ownerId}/${materialId}/${page.pdfPage}`;
    const cached = this.images.get(key);
    if (cached) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const doc = await docPromise;
      const pdfPage = await doc.getPage(page.pdfPage!);
      if (session.cancelled) throw new Error('資料の読込を中止しました。');
      const native = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(2, 1800 / Math.max(native.width, native.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try {
        await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
        if (session.cancelled) throw new Error('資料の読込を中止しました。');
        const result = { url: canvas.toDataURL('image/png'), aspect: native.width / native.height };
        this.images.set(key, result, estimateDataUrlMemoryBytes(result.url) + estimateRgbaPixelBytes(canvas.width, canvas.height));
        return result;
      } finally { canvas.width = 0; canvas.height = 0; }
    })();
    this.pending.set(key, pending);
    try { return await pending; } finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  async load(ownerId: string, materialId: string, page: MaterialPage): Promise<MaterialPagePreview> {
    const [background, raw] = await Promise.all([
      this.background(ownerId, materialId, page),
      loadCategoryNoteRaw(`quizMake:notes:${ownerId}:${annotationCategory(materialId, page.id)}`),
    ]);
    const note = raw ? JSON.parse(raw) : null;
    const ink = note?.pages?.[Math.max(0, Math.min(note.currentPageIndex ?? 0, note.pages.length - 1))]?.dataUrl ?? note?.dataUrl;
    const inkUrl = typeof ink === 'string' && ink ? ink : undefined;
    await Promise.all([background.url, inkUrl].filter((url): url is string => !!url).map(async url => {
      const image = new Image(); image.src = url; await image.decode();
    }));
    return { ...background, inkUrl };
  }
}
