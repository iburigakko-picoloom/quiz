import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { lockMemoKeyboard, memoDockTop } from '../utils/memoKeyboard';
import './MemoComposer.css';

export function MemoComposer({ id, value, disabled, canSave = false, onChange, onSave, label = '詳しく知りたいこと' }: {
  id: string; value: string; disabled: boolean; canSave?: boolean; label?: string;
  onChange: (value: string) => void; onSave?: () => void;
}) {
  const row = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), dock = useRef<HTMLDivElement>(null);
  const release = useRef<(() => void) | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [bottom, setBottom] = useState(0), [dockHeight, setDockHeight] = useState(164);
  const mobile = () => window.matchMedia('(any-pointer: coarse)').matches;
  const open = () => {
    if (position || disabled || !row.current) return;
    const bounds = row.current.getBoundingClientRect();
    setBottom(window.innerHeight);
    release.current = lockMemoKeyboard(row.current, setBottom);
    setPosition({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
  };
  const close = () => { release.current?.(); release.current = null; setPosition(null); };
  useEffect(() => () => { release.current?.(); }, []);
  useLayoutEffect(() => {
    if (!position) return;
    if (dock.current) setDockHeight(dock.current.getBoundingClientRect().height);
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(value.length, value.length);
  }, [Boolean(position)]);
  const pointerDown = (event: PointerEvent<HTMLTextAreaElement>) => {
    if (!position && mobile()) { event.preventDefault(); flushSync(open); }
  };
  const textarea = <textarea ref={input} id={id} className="answer-sheet__detail-input" value={value} disabled={disabled} maxLength={4000}
    onPointerDown={pointerDown} onFocus={() => { if (!position && mobile()) flushSync(open); }}
    onBlur={event => { if (position && !dock.current?.contains(event.relatedTarget as Node | null)) close(); }}
    onChange={event => onChange(event.target.value)} />;
  const save = onSave ? <button type="button" className="weakness-primary" onPointerDown={event => { if (position) event.preventDefault(); }} onClick={onSave} disabled={disabled || !canSave} aria-label="苦手メモに保存">↑</button> : null;
  return <div className="weakness-composer">
    <label htmlFor={id}>{label}</label>
    {position ? <div className="memo-composer-placeholder" style={{ height: position.height }} /> : <div ref={row} className="weakness-compose-row">{textarea}{save}</div>}
    {position ? createPortal(<div ref={dock} className="weakness-detail memo-keyboard-dock" style={{ top: memoDockTop(position.top, dockHeight, bottom), left: Math.max(8, position.left), width: Math.min(position.width, window.innerWidth - 16), maxHeight: Math.max(80, bottom - 16) }}>
      <div className="memo-keyboard-dock__header"><label htmlFor={id}>{label}</label><button type="button" onPointerDown={event => event.preventDefault()} onClick={close}>完了</button></div>
      <div className="weakness-compose-row">{textarea}{save}</div>
    </div>, document.body) : null}
  </div>;
}
