export async function imageMarkdown(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10_000_000) throw new Error('10MB以下のPNG・JPEG・WebP画像を選んでください。');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error('画像を縮小してから選んでください。');
    const canvas = document.createElement('canvas');
    for (const max of [1200, 900, 650]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('画像を読み込めません。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', .75);
      if (data.length < 180_000) return `![添付画像](${data})`;
    }
    throw new Error('画像が大きすぎます。必要な範囲を切り抜いて再度添付してください。');
  } finally { URL.revokeObjectURL(url); }
}
