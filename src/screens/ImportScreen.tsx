import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { useAccountWork, useRestoredAccountWork } from '../hooks/useAccountWork';
import { isAccountWorkReloadApproved } from '../utils/accountWork';
import { BackButton } from '../components/BackButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Layout } from '../components/Layout';
import {
  getImportFileSelectionError,
  IMPORT_RESOURCE_LIMITS,
  type ImportFileDescriptor,
} from '../utils/importValidator';
import { readClipboardText } from '../utils/nativePlatform';
import './ImportScreen.css';
import { runImportQueue } from '../utils/importQueue';
import { readImportSession, storeImportSession, type ImportDraft, type ImportFileItem } from '../utils/importDraftSessions';

interface ImportScreenProps {
  sessionKey: string;
  registerExitGuard: (guard: ((proceed: () => void) => Promise<boolean>) | null) => void;
  folderName: string;
  onBack: () => void;
  onImport: (titleOverride: string, jsonText: string, stayOnScreen?: boolean) => Promise<string | null>;
  onImportComplete: () => void;
}

interface ImportResult {
  successCount: number;
  failures: { fileName: string; error: string }[];
}

export function ImportScreen({ sessionKey, registerExitGuard, folderName, onBack, onImport, onImportComplete }: ImportScreenProps) {
  const workKey = `import:${sessionKey}`;
  const recovered = useRestoredAccountWork<ImportDraft>(workKey);
  const initial = recovered ?? readImportSession(sessionKey);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [titleEdited, setTitleEdited] = useState(initial?.titleEdited ?? false);
  const [jsonText, setJsonText] = useState(initial?.jsonText ?? '');
  const [importFiles, setImportFiles] = useState<ImportFileItem[]>(initial?.files ?? []);
  const [savedCount, setSavedCount] = useState(initial?.savedCount ?? 0);
  const [error, setError] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importProgress, setImportProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingClipboardText, setPendingClipboardText] = useState<string | null>(null);
  const activeRef = useRef(true), stopRef = useRef(false), preparingRef = useRef(false);
  const runningRef = useRef<Promise<void> | null>(null);
  const draftRef = useRef<ImportDraft>({ title, titleEdited, jsonText, files: importFiles, savedCount });
  draftRef.current = { title, titleEdited, jsonText, files: importFiles, savedCount };
  useAccountWork(workKey, () => draftRef.current, async () => { if(preparingRef.current || runningRef.current)throw new Error('取り込み完了を待っています。'); });
  const exitResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [exitWaiting, setExitWaiting] = useState(false);

  useEffect(() => { storeImportSession(sessionKey, draftRef.current); }, [sessionKey, title, titleEdited, jsonText, importFiles, savedCount]);
  useEffect(() => {
    activeRef.current = true;
    registerExitGuard(async proceed => {
      if (preparingRef.current) { setError('ファイルの読み込みが完了してから戻れます。'); return false; }
      if (exitResolver.current) return false;
      if (runningRef.current) {
        const confirmed = await new Promise<boolean>(resolve => { exitResolver.current = resolve; setExitOpen(true); });
        if (!confirmed) return false;
      }
      storeImportSession(sessionKey, draftRef.current); proceed(); return true;
    });
    return () => { activeRef.current = false; stopRef.current = true; registerExitGuard(null); storeImportSession(sessionKey, draftRef.current); exitResolver.current?.(false); exitResolver.current = null; };
  }, [sessionKey, registerExitGuard]);
  useEffect(() => {
    if (!isImporting && !isPreparingFiles && !jsonText.trim() && !importFiles.length) return;
    const protect = (event: BeforeUnloadEvent) => { if(isAccountWorkReloadApproved())return;event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [isImporting, isPreparingFiles, jsonText, importFiles.length]);
  const resolveExit = async (confirmed: boolean) => {
    if (confirmed) { stopRef.current = true; setExitWaiting(true); await runningRef.current; }
    const resolve = exitResolver.current; exitResolver.current = null;
    setExitWaiting(false); setExitOpen(false); resolve?.(confirmed);
  };

  const handleReadClipboard = async () => {
    setError('');
    setNotice('');
    try {
      const text = await readClipboardText();
      if (!text.trim()) {
        setError('クリップボードが空です。現在の入力内容は変更していません。');
        return;
      }
      if (jsonText.trim() && text !== jsonText) {
        setPendingClipboardText(text);
        return;
      }
      applyClipboardText(text);
    } catch {
      setError('クリップボードを読み込めませんでした。ブラウザの権限を確認してください。');
    }
  };

  const applyClipboardText = (text: string) => {
    setJsonText(text);
    const extractedTitle = extractSetTitle(text);
    if (extractedTitle) {
      setTitle(extractedTitle);
      setTitleEdited(false);
    }
    setNotice('クリップボードから読み込みました');
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setError('');
    setNotice('');
    setImportResult(null);
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const incomingFiles: ImportFileDescriptor[] = files.map((file) => ({
      id: `${file.name}_${file.lastModified}_${file.size}`,
      name: file.name,
      size: file.size,
    }));
    const selectionError = getImportFileSelectionError(
      importFiles.map((file) => ({ id: file.id, name: file.fileName, size: file.size })),
      incomingFiles,
    );
    if (selectionError) {
      setError(selectionError);
      return;
    }
    setIsPreparingFiles(true);
    preparingRef.current = true;
    const items = await Promise.all(files.map(async (file) => {
      const fallbackTitle = getFileBaseName(file.name);
      try {
        const rawText = normalizeJsonText(await file.text());
        const detectedSetTitle = extractSetTitle(rawText);
        return {
          id: `${file.name}_${file.lastModified}_${file.size}`,
          fileName: file.name,
          fallbackTitle: fallbackTitle || '無題の問題セット',
          detectedSetTitle,
          editableSetTitle: detectedSetTitle || fallbackTitle || '無題の問題セット',
          userEditedTitle: false,
          size: file.size,
          rawText,
        };
      } catch (readError) {
        return {
          id: `${file.name}_${file.lastModified}_${file.size}`,
          fileName: file.name,
          fallbackTitle: fallbackTitle || '無題の問題セット',
          detectedSetTitle: '',
          editableSetTitle: fallbackTitle || '無題の問題セット',
          userEditedTitle: false,
          size: file.size,
          rawText: '',
          readError: readError instanceof Error ? readError.message : 'ファイルの読み込みに失敗しました。',
        };
      }
    }));
    setImportFiles((current) => {
      const nextIds = new Set(items.map((item) => item.id));
      return [...current.filter((item) => !nextIds.has(item.id)), ...items];
    });
    setIsPreparingFiles(false);
    preparingRef.current = false;
  };
  const handleJsonTextChange = (value: string) => {
    setJsonText(value);
    setImportResult(null);
    setNotice('');
    const titleResult = readSetTitle(value);
    if (!titleEdited && titleResult.parsed) {
      setTitle(titleResult.title || '無題の問題セット');
    }
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    setTitleEdited(true);
  };

  const handleFileTitleChange = (id: string, value: string) => {
    setImportFiles((items) => items.map((item) => (
      item.id === id ? { ...item, editableSetTitle: value, userEditedTitle: true } : item
    )));
  };

  const handleRemoveFile = (id: string) => {
    setImportFiles((items) => items.filter((item) => item.id !== id));
    setImportResult(null);
    setNotice('');
  };

  const handleImport = async () => {
    if (runningRef.current || preparingRef.current) return;
    const files = [...importFiles];
    const queue = [
      ...(jsonText.trim() ? [{ id: '__paste__', fileName: '貼り付けJSON', rawText: normalizeJsonText(jsonText), finalTitle: title.trim() || extractSetTitle(jsonText) || '無題の問題セット', readError: undefined as string | undefined }] : []),
      ...files.map(file => ({ ...file, finalTitle: getFinalFileTitle(file, files.length === 1 ? title.trim() : '') })),
    ];
    if (!queue.length) return;
    stopRef.current = false;
    setIsImporting(true); setError(''); setNotice(''); setImportResult(null);
    const work = (async () => {
      await yieldToUi();
      const result = await runImportQueue(queue, {
        stopped: () => stopRef.current,
        progress: (item, index) => { if (activeRef.current) setImportProgress(item.fileName + ' を取り込み中… ' + (index + 1) + ' / ' + queue.length); },
        save: item => item.readError ? Promise.resolve(item.readError) : onImport(item.finalTitle, item.rawText, true),
        saved: item => {
          const state = { ...draftRef.current, jsonText: item.id === '__paste__' ? '' : draftRef.current.jsonText, files: draftRef.current.files.filter(file => file.id !== item.id), savedCount: draftRef.current.savedCount + 1 };
          draftRef.current = state; storeImportSession(sessionKey, state);
          if (activeRef.current) { setJsonText(state.jsonText); setImportFiles(state.files); setSavedCount(state.savedCount); }
        },
      });
      if (activeRef.current) {
        setImportResult({ successCount: result.saved, failures: result.failures.map(f => ({ fileName: queue.find(item => item.id === f.id)?.fileName ?? f.id, error: f.error })) });
        setImportProgress('');
        setNotice(result.stopped ? '取り込みを中断しました。保存済みの教材は残り、残りだけ再開できます。' : result.failures.length ? '未保存の項目を残しています。内容を確認して再試行できます。' : '取り込み完了。保存先を開けます。');
      }
    })();
    runningRef.current = work;
    try { await work; } finally { runningRef.current = null; if (activeRef.current) setIsImporting(false); }
  };

  return (
    <Layout>
      <div className="quiz-import">
        <header className="quiz-import__header">
          <BackButton onClick={onBack} className="quiz-import__back" />
          <div className="quiz-import__title-wrap">
            <h1 className="quiz-import__title">問題セット追加</h1>
            <p className="quiz-import__subtitle">{folderName}</p>
          </div>
          <div className="quiz-import__spacer" />
        </header>

        <main className="quiz-import__content">
          <fieldset disabled={isImporting || isPreparingFiles} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="quiz-import__title-card">
            <div className="quiz-import__card-heading">
              <span>1</span>
              <h2>問題セット名</h2>
            </div>
            <label htmlFor="setTitle" className="quiz-import__label">問題セット名</label>
            <input
              id="setTitle"
              value={title}
              onChange={(event) => handleTitleChange(event.target.value)}
              maxLength={IMPORT_RESOURCE_LIMITS.setTitle}
              className="quiz-import__input"
            />
          </section>

          <section className="quiz-import__file-card">
            <div className="quiz-import__card-heading">
              <span>2</span>
              <h2>JSONを読み込む</h2>
            </div>
            <button type="button" onClick={handleReadClipboard} className="quiz-import__clipboard-button">
              クリップボードから読み込む
            </button>
            <label htmlFor="jsonFiles" className="quiz-import__label">JSONファイル選択</label>
            <input
              id="jsonFiles"
              type="file"
              accept=".json,application/json"
              multiple
              onChange={handleFileChange}
              className="quiz-import__file-input"
            />
            {isPreparingFiles ? <p className="quiz-import__file-preparing">ファイルを読み込み中...</p> : null}
            {importFiles.length > 0 ? (
              <div className="quiz-import__file-list">
                <div className="quiz-import__file-list-heading">
                  <p>取り込み予定：{importFiles.length}件</p>
                  <button type="button" onClick={() => setImportFiles([])}>すべて解除</button>
                </div>
                {importFiles.map((file, index) => (
                  <div key={file.id} className="quiz-import__file-item">
                    <div className="quiz-import__file-item-heading">
                      <span>{index + 1}. {file.fileName}</span>
                      <button type="button" onClick={() => handleRemoveFile(file.id)} aria-label={`${file.fileName}を解除`}>
                        解除
                      </button>
                    </div>
                    <input
                      value={file.editableSetTitle}
                      onChange={(event) => handleFileTitleChange(file.id, event.target.value)}
                      className="quiz-import__file-title-input"
                      maxLength={IMPORT_RESOURCE_LIMITS.setTitle}
                      aria-label={`${file.fileName}の問題セット名`}
                    />
                    {file.readError ? <small>{file.readError}</small> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="quiz-import__json-card">
            <div className="quiz-import__card-heading">
              <span>3</span>
              <h2>JSON貼り付け欄</h2>
            </div>
            <label htmlFor="jsonText" className="quiz-import__label">JSON貼り付け欄</label>
            <textarea
              id="jsonText"
              value={jsonText}
              onChange={(event) => handleJsonTextChange(event.target.value)}
              className="quiz-import__textarea"
            />
          </section>

          {notice ? <div className="quiz-import__notice" role="status" aria-live="polite">{notice}</div> : null}
          {importProgress ? <div className="quiz-import__progress" role="status" aria-live="polite"><span />{importProgress}</div> : null}

          {importResult ? (
            <div className={importResult.failures.length > 0 ? 'quiz-import__result quiz-import__result--mixed' : 'quiz-import__result'} role="status" aria-live="polite">
              <p>取り込み完了：{importResult.successCount}件</p>
              <p>失敗：{importResult.failures.length}件</p>
              {importResult.failures.length > 0 ? (
                <ul>
                  {importResult.failures.map((failure) => (
                    <li key={failure.fileName}>
                      <strong>{failure.fileName}</strong>：{failure.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="quiz-import__error" role="alert">{error}</div> : null}
          {savedCount ? <p role="status">保存済み：{savedCount}件。再開時は未保存の項目だけ取り込みます。</p> : null}
          </fieldset>
          {!isImporting && !jsonText.trim() && !importFiles.length && savedCount ? <button type="button" className="quiz-import__clipboard-button" onClick={onImportComplete}>保存先を開く</button> : null}
        </main>

        <button
          type="button"
          onClick={handleImport}
          disabled={isImporting || isPreparingFiles || (!jsonText.trim() && importFiles.length === 0)}
          className="quiz-import__submit"
        >
          {isImporting ? '取り込み中…' : savedCount && (jsonText.trim() || importFiles.length) ? '残りを取り込む' : '取り込む'}
        </button>
      </div>
      <ConfirmDialog open={exitOpen} title="取込を中断して戻りますか？" message="今保存している1件の完了を待って戻ります。保存済みの教材は残り、未保存の入力はこの画面に戻ると再開できます。アプリを閉じる前に元のファイルを保管してください。" busy={exitWaiting} confirmLabel={exitWaiting ? '今の1件を保存中…' : '中断して戻る'} onCancel={() => void resolveExit(false)} onConfirm={() => void resolveExit(true)} />
      <ConfirmDialog
        open={pendingClipboardText !== null}
        title="入力内容を置き換えますか？"
        message="現在のJSON貼り付け欄を、クリップボードの内容で置き換えます。"
        confirmLabel="置き換える"
        onCancel={() => setPendingClipboardText(null)}
        onConfirm={() => {
          if (pendingClipboardText !== null) applyClipboardText(pendingClipboardText);
          setPendingClipboardText(null);
        }}
      />
    </Layout>
  );
}

function extractSetTitle(text: string) {
  return readSetTitle(text).title;
}

function getFinalFileTitle(file: ImportFileItem, globalTitle = '') {
  const editedTitle = file.editableSetTitle.trim();
  const globalOverride = globalTitle.trim();
  if (globalOverride) return globalOverride;
  if (file.userEditedTitle && editedTitle) return editedTitle;
  return file.detectedSetTitle.trim() || extractSetTitle(file.rawText) || file.fallbackTitle.trim() || '無題の問題セット';
}
function readSetTitle(text: string): { parsed: boolean; title: string } {
  const normalizedText = normalizeJsonText(text);
  try {
    const parsed = JSON.parse(normalizedText) as { setTitle?: unknown; title?: unknown };
    const setTitle = typeof parsed.setTitle === 'string' && parsed.setTitle.trim() ? parsed.setTitle.trim() : '';
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '';
    return {
      parsed: true,
      title: setTitle || title,
    };
  } catch {
    const title = extractSetTitleByRegex(normalizedText);
    return { parsed: Boolean(title), title };
  }
}

function getFileBaseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/u, '').trim();
}

function normalizeJsonText(text: string) {
  return text.replace(/^\uFEFF/u, '').trim();
}

function extractSetTitleByRegex(text: string) {
  const match = text.match(/"setTitle"\s*:\s*"((?:\\.|[^"\\])*)"/u) ?? text.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/u);
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return match[1].trim();
  }
}

function yieldToUi() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
