import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;
export function openPdf(data: Uint8Array) {
  const base = import.meta.env.BASE_URL + 'assets/pdfjs/';
  return getDocument({ data, isEvalSupported: false, stopAtErrors: true, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/' });
}
export function pdfBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
