import type { QuestionImageDescriptor, StoredQuestionImage } from './questionImageRecords';

export const QUESTION_IMAGE_BUCKET = 'quiz-question-images';
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

export interface QuestionImageTransport {
  userId: string;
  exists(descriptor: QuestionImageDescriptor): Promise<boolean>;
  upload(descriptor: QuestionImageDescriptor, blob: Blob): Promise<void>;
  download(descriptor: QuestionImageDescriptor): Promise<Blob>;
}

export function remoteQuestionImageDescriptor(descriptor: QuestionImageDescriptor, userId: string): QuestionImageDescriptor {
  const ext = extension[descriptor.type];
  if (!ext) throw new Error('画像形式を確認できませんでした。');
  return { ...descriptor, path: `${userId}/${descriptor.sha256}.${ext}` };
}

export async function verifyQuestionImageBlob(blob: Blob, descriptor: QuestionImageDescriptor): Promise<boolean> {
  if (blob.size !== descriptor.size || blob.type !== descriptor.type) return false;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  return hash === descriptor.sha256;
}

export function createQuestionImageTransport(config: { url: string; anonKey: string }, access: { userId: string; accessToken: string }): QuestionImageTransport {
  const headers = { apikey: config.anonKey, Authorization: `Bearer ${access.accessToken}` };
  const root = config.url.replace(/\/$/, '') + `/storage/v1/object/${QUESTION_IMAGE_BUCKET}/`;
  const objectUrl = (descriptor: QuestionImageDescriptor) => {
    if (!descriptor.path || descriptor.path !== remoteQuestionImageDescriptor(descriptor, access.userId).path) throw new Error('画像の所有者または保存先が不正です。');
    return root + descriptor.path;
  };
  return {
    userId: access.userId,
    async exists(descriptor) {
      const response = await fetch(objectUrl(descriptor), { method: 'HEAD', headers, signal: AbortSignal.timeout(30000) });
      if (response.ok) return true;
      if (response.status === 400 || response.status === 404) return false;
      throw new Error('画像の保存先を確認できませんでした。');
    },
    async upload(descriptor, blob) {
      if (!await verifyQuestionImageBlob(blob, descriptor)) throw new Error('端末の画像が保存情報と一致しません。');
      const { Upload } = await import('tus-js-client');
      const endpoint = config.url.replace(/\/$/, '').replace('.supabase.co', '.storage.supabase.co') + '/storage/v1/upload/resumable';
      await new Promise<void>((resolve, reject) => {
        const upload = new Upload(blob, { endpoint, headers, chunkSize: 6 * 1024 * 1024,
          retryDelays: [0, 1000, 3000, 5000], uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
          fingerprint: async () => `${config.url}/${QUESTION_IMAGE_BUCKET}/${descriptor.path}`,
          metadata: { bucketName: QUESTION_IMAGE_BUCKET, objectName: descriptor.path!, contentType: descriptor.type, cacheControl: '3600' },
          onSuccess: () => { clearTimeout(timer); resolve(); },
          onError: () => { clearTimeout(timer); void this.exists(descriptor).then(found => found ? resolve() : reject(new Error('画像をクラウドへ保存できませんでした。端末の画像は保持しています。')), reject); },
        });
        const timer = setTimeout(() => { void upload.abort(); reject(new Error('画像の送信が時間切れになりました。再試行してください。')); }, 5 * 60 * 1000);
        void upload.findPreviousUploads().then(previous => { if (previous[0]) upload.resumeFromPreviousUpload(previous[0]); upload.start(); }, () => upload.start());
      });
    },
    async download(descriptor) {
      const response = await fetch(objectUrl(descriptor), { headers, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('クラウドの画像を取得できませんでした。端末データは変更していません。');
      const advertised = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertised) && advertised > descriptor.size) throw new Error('画像サイズが登録情報と一致しません。');
      const blob = new Blob([await response.arrayBuffer()], { type: descriptor.type });
      if (!await verifyQuestionImageBlob(blob, descriptor)) throw new Error('画像の内容を検証できませんでした。端末データは変更していません。');
      return blob;
    },
  };
}

export function storedQuestionImage(descriptor: QuestionImageDescriptor, blob: Blob): StoredQuestionImage {
  return { id: descriptor.id, questionId: descriptor.questionId, name: descriptor.name, type: descriptor.type, blob, addedAt: descriptor.addedAt };
}
