export interface ImportFileItem {
  id: string; fileName: string; fallbackTitle: string; detectedSetTitle: string;
  editableSetTitle: string; userEditedTitle: boolean; size: number; rawText: string; readError?: string;
}
export interface ImportDraft { title: string; titleEdited: boolean; jsonText: string; files: ImportFileItem[]; savedCount: number }
const sessions = new Map<string, ImportDraft>();
export function readImportSession(key: string) { return sessions.get(key); }
export function storeImportSession(key: string, draft: ImportDraft) { sessions.set(key, draft); }
export function hasPendingImportSession(key: string) {
  const draft = sessions.get(key); return Boolean(draft && (draft.jsonText.trim() || draft.files.length));
}
