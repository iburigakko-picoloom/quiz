import { createId } from './id';
import { MAX_LOCAL_QUESTION_IMAGE_BYTES, MAX_QUESTION_DETAIL_IMAGES } from './imageLimits';
import { requestPersistentStorage } from './noteStorage';
import { readQuestionImages, removeQuestionImages, saveQuestionImage, type StoredQuestionImage } from './questionImageRecords';
import { withCoordinatedDataMutation } from './dataCoordination';

export { MAX_LOCAL_QUESTION_IMAGE_BYTES, MAX_QUESTION_DETAIL_IMAGES } from './imageLimits';
export type LocalQuestionImage = StoredQuestionImage;

export async function saveLocalQuestionImage(questionId: string, file: Blob, id = createId('image')): Promise<string> {
  validateImageFile(file);
  if (!questionId.trim()) throw new Error('画像の保存先を確認できません。');
  void requestPersistentStorage();
  await withCoordinatedDataMutation(['app'], () => saveQuestionImage({ id, questionId, name: typeof File !== 'undefined' && file instanceof File && file.name ? file.name : '共有画像',
    type: file.type, blob: new Blob([file], { type: file.type }), addedAt: new Date().toISOString() }));
  return id;
}

export function loadLocalQuestionImages(questionId: string, imageIds: readonly string[]): Promise<LocalQuestionImage[]> {
  return readQuestionImages(questionId, imageIds);
}
export function deleteLocalQuestionImage(id: string): Promise<void> {
  return withCoordinatedDataMutation(['app'], () => removeQuestionImages(image => image.id === id));
}
export function deleteLocalQuestionImages(questionId: string): Promise<void> {
  return withCoordinatedDataMutation(['app'], () => removeQuestionImages(image => image.questionId === questionId));
}
export function pruneLocalQuestionImages(questionIds: Iterable<string>): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  const keep = new Set(questionIds);
  return withCoordinatedDataMutation(['app'], () => removeQuestionImages(image => !keep.has(image.questionId)));
}
function validateImageFile(file: Blob) {
  if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type)) throw new Error('PNG・JPEG・WebP・HEIC・HEIF画像を選んでください。');
  if (!file.size || file.size > MAX_LOCAL_QUESTION_IMAGE_BYTES) throw new Error('画像は1枚50MB以下にしてください。');
}
