import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
export function openPdf(data: Uint8Array) {
  const base = new URL(import.meta.env.BASE_URL + 'assets/pdfjs/', document.baseURI).href;
  return getDocument({ data, isEvalSupported: false, stopAtErrors: true, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/' });
}
