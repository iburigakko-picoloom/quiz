import { MAX_MATERIAL_PDF_BYTES } from './materialModel';

export async function createPhotoPdf(images: { bytes: Uint8Array; type: 'image/jpeg' | 'image/png' }[]): Promise<Uint8Array> {
  if (!images.length || images.length > 500) throw new Error('写真を1〜500枚選んでください。');
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  for (const image of images) {
    const embedded = image.type === 'image/png' ? await document.embedPng(image.bytes) : await document.embedJpg(image.bytes);
    const page = document.addPage([embedded.width * .75, embedded.height * .75]);
    page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  const bytes = await document.save();
  if (bytes.byteLength > MAX_MATERIAL_PDF_BYTES) throw new Error('写真の合計サイズを50MB以下にしてください。');
  return bytes;
}

/** Photos use the existing private material file and separate handwriting layer. */
export async function photosToMaterialFile(files: File[]): Promise<File> {
  if (!files.length || files.length > 500) throw new Error('写真を1〜500枚選んでください。');
  if (files.some(file => !/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type))) throw new Error('PNG・JPEG・WebP形式の写真を選んでください。');
  if (files.some(file => !file.size) || files.reduce((sum, file) => sum + file.size, 0) > MAX_MATERIAL_PDF_BYTES) {
    throw new Error('写真の合計サイズを50MB以下にしてください。');
  }
  const images: { bytes: Uint8Array; type: 'image/jpeg' }[] = [];
  let encodedBytes = 0;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const canvas = document.createElement('canvas');
    try {
      const image = new Image(); image.src = url;
      try { await image.decode(); } catch { throw new Error('写真を読み込めません。JPEG・PNG・WebP形式で保存して選び直してください。'); }
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('写真を縮小してから選んでください。');
      // Browser decoding applies photo orientation before creating the page.
      const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('写真を読み込めません。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('写真を資料に追加できませんでした。')), 'image/jpeg', .95));
      encodedBytes += blob.size;
      if (encodedBytes > MAX_MATERIAL_PDF_BYTES) throw new Error('写真の合計サイズを50MB以下にしてください。');
      images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' });
    } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
  }
  const bytes = await createPhotoPdf(images);
  return new File([new Uint8Array(bytes).buffer], '写真.pdf', { type: 'application/pdf' });
}
