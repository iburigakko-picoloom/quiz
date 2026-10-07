import { useRef, useState } from 'react';
import { writeClipboardText } from '../utils/nativePlatform';
import './ClipboardCopyFallback.css';

export function ClipboardCopyFallback({ text, onCopied }: { text: string; onCopied: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const retry = async () => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await writeClipboardText(text); onCopied(); }
    catch { setMessage('「全文を選択」を押し、長押しメニューからコピーしてください。'); }
    finally { setBusy(false); }
  };
  return <section className="clipboard-copy-fallback" aria-label="コピーする文章">
    <p>自動コピーが使えません。もう一度コピーするか、文章を選択してコピーできます。</p>
    <div><button type="button" disabled={busy} onClick={() => void retry()}>{busy ? 'コピー中…' : 'もう一度コピー'}</button><button type="button" onClick={() => { field.current?.focus({ preventScroll: true }); field.current?.select(); field.current?.setSelectionRange(0, text.length); }}>全文を選択</button></div>
    <textarea ref={field} readOnly value={text} rows={6} aria-label="コピー用の全文" spellCheck={false} />
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
