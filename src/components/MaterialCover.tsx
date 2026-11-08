import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getAccountStorageSession } from '../utils/accountStorage';
import type { MaterialPage } from '../utils/materialModel';
import { MaterialPreviewCache, type MaterialPagePreview } from '../utils/materialPreview';
import { DocumentOutlineIcon } from './UiIcons';

/** A single renderer avoids decoding many large PDFs concurrently on phones. */
export class MaterialCoverQueue {
  private cache = new MaterialPreviewCache();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  load(ownerId: string, materialId: string, page: MaterialPage, current: () => boolean) {
    const owner = getAccountStorageSession();
    const task = this.tail.then(async () => {
      if (this.closed || !current() || owner !== getAccountStorageSession()) return null;
      let preview: MaterialPagePreview;
      try { preview = await this.cache.load(ownerId, materialId, page, 192); }
      catch {
        if (this.closed || !current() || owner !== getAccountStorageSession()) return null;
        // A damaged note must not hide an otherwise readable PDF page.
        preview = await this.cache.loadBackground(ownerId, materialId, page, 192);
      }
      if (this.closed || !current() || owner !== getAccountStorageSession()) return null;
      owner?.assertCurrent();
      return preview;
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  close() { this.closed = true; this.cache.clear(); }
}

export function MaterialCover({ ownerId, materialId, page, enabled, queue }: {
  ownerId: string; materialId: string; page?: MaterialPage; enabled: boolean;
  queue: MutableRefObject<MaterialCoverQueue | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<MaterialPagePreview | null>(null);
  useEffect(() => {
    setPreview(null);
    const node = ref.current;
    if (!node || !page || !enabled) return;
    let active = true, generation = 0;
    const load = () => {
      const request = ++generation;
      const renderer = queue.current ?? (queue.current = new MaterialCoverQueue());
      void renderer.load(ownerId, materialId, page, () => active && request === generation)
        .then(result => { if (active && request === generation && result) setPreview(result); })
        .catch(() => { if (active && request === generation) setPreview(null); });
    };
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { active = false; generation++; }; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) load();
      else { generation++; setPreview(null); }
    }, { rootMargin: '100px' });
    observer.observe(node);
    return () => { active = false; generation++; observer.disconnect(); };
  }, [ownerId, materialId, page?.id, page?.kind, page?.pdfPage, enabled, queue]);
  return <span ref={ref} className="quiz-home__material-cover" aria-hidden="true">
    {preview ? <span className="quiz-home__material-page" style={{ aspectRatio: String(preview.aspect) }}>
      {preview.url ? <img src={preview.url} alt="" /> : null}
      {preview.inkUrl ? <img className="quiz-home__material-ink" src={preview.inkUrl} alt="" /> : null}
    </span> : <DocumentOutlineIcon size={40} />}
  </span>;
}
