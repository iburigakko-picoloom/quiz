import { boundedNoteScale } from './noteGestures';
import { beginMarkerStroke, drawInkSegment, type InkSettings, type MarkerStroke } from './noteDrawing';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react';
import type { MaterialImageReference } from '../utils/materialImageReferences';

export interface ReferenceImageEditorHandle { flush: () => Promise<void>; undo: () => void; resetZoom: () => void }

export const ReferenceImageEditor = forwardRef<ReferenceImageEditorHandle, {
  item: MaterialImageReference;
  url: string;
  save: (ink: Blob) => Promise<void>;
  settings: InkSettings;
  onActivate: () => void;
  onUndoChange: (available: boolean) => void;
  disabled: boolean;
  onScaleChange: (scale: number) => void;
}>(function ReferenceImageEditor({ item, url, save, settings, onActivate, onUndoChange, disabled, onScaleChange }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number; x: number; y: number; centerX: number; centerY: number } | null>(null);
  const frame = useRef<number | null>(null);
  const updateView = (next: typeof view) => {
    const width = paper.current?.offsetWidth ?? 0, height = paper.current?.offsetHeight ?? 0;
    const limitX = Math.max(0, (next.scale - 1) * width / 2), limitY = Math.max(0, (next.scale - 1) * height / 2);
    viewRef.current = { scale: next.scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setView(viewRef.current); onScaleChange(viewRef.current.scale); });
  };
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const touchStart = (event: PointerEvent<HTMLCanvasElement>) => {
    onActivate(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...touches.current.values()];
    if (points.length === 2) {
      const [a, b] = points;
      pinch.current = { distance: Math.max(1, Math.hypot(a.x-b.x,a.y-b.y)), ...viewRef.current, centerX: (a.x+b.x)/2, centerY: (a.y+b.y)/2 };
    }
  };
  const touchMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const old = touches.current.get(event.pointerId); if (!old) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...touches.current.values()], start = pinch.current;
    if (points.length === 2 && start) {
      const [a, b] = points;
      updateView({ scale: boundedNoteScale(start.scale * Math.hypot(a.x-b.x,a.y-b.y) / start.distance), x: start.x+(a.x+b.x)/2-start.centerX, y: start.y+(a.y+b.y)/2-start.centerY });
    } else if (points.length === 1) updateView({ ...viewRef.current, x: viewRef.current.x + event.clientX-old.x, y: viewRef.current.y + event.clientY-old.y });
  };
  const [aspect, setAspect] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const history = useRef<ImageData[]>([]);
  const stroke = useRef<{ id: number; x: number; y: number } | null>(null);
  const marker = useRef<MarkerStroke | null>(null);
  const dirty = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.src = url;
    void (async () => {
      await image.decode();
      if (cancelled || !canvas.current) return;
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const target = canvas.current;
      target.width = Math.max(1, Math.round(image.naturalWidth * scale));
      target.height = Math.max(1, Math.round(image.naturalHeight * scale));
      setAspect(image.naturalWidth / image.naturalHeight);
      if (item.ink) {
        const inkUrl = URL.createObjectURL(item.ink);
        try {
          const ink = new Image(); ink.src = inkUrl; await ink.decode();
          if (cancelled) return;
          target.getContext('2d')!.drawImage(ink, 0, 0, target.width, target.height);
        } finally { URL.revokeObjectURL(inkUrl); }
      }
      if (!cancelled) setReady(true);
    })().catch(() => { if (!cancelled) setError('書き込みを読み込めません。画像を開き直してください。'); });
    return () => { cancelled = true; };
  }, [url, item.id]);

  const persist = () => {
    if (!dirty.current || !canvas.current) return queue.current;
    dirty.current = false;
    // Capture now so a later stroke cannot change this save's contents.
    const blob = new Promise<Blob>((resolve, reject) => canvas.current!.toBlob(value => value ? resolve(value) : reject(new Error('画像化に失敗しました。')), 'image/png'));
    void blob.catch(() => {});
    const write = saveRef.current;
    queue.current = queue.current.catch(() => {}).then(async () => { await write(await blob); });
    void queue.current.then(() => setError(''), () => {
      dirty.current = true;
      setError('書き込みを保存できません。「再試行」を押してください。');
    });
    return queue.current;
  };
  useImperativeHandle(ref, () => ({
    flush: async () => { stroke.current = null; marker.current = null; await persist(); },
    resetZoom: () => { touches.current.clear(); pinch.current = null; updateView({ scale: 1, x: 0, y: 0 }); },
    undo: () => {
      if (!ready || disabled || stroke.current) return;
      const previous = history.current.pop(); if (!previous) return;
      canvas.current!.getContext('2d')!.putImageData(previous, 0, 0);
      onUndoChange(history.current.length > 0); dirty.current = true; void persist().catch(() => {});
    },
  }));
  const remember = () => {
    const target = canvas.current!;
    // Keep undo bounded to roughly 24 MB, including large reference images.
    const limit = Math.max(1, Math.min(20, Math.floor(24 * 1024 * 1024 / (target.width * target.height * 4))));
    history.current = [...history.current, target.getContext('2d')!.getImageData(0, 0, target.width, target.height)].slice(-limit);
    onUndoChange(history.current.length > 0);
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * event.currentTarget.width / bounds.width, y: (event.clientY - bounds.top) * event.currentTarget.height / bounds.height };
  };
  const draw = (x: number, y: number) => {
    const target = canvas.current!, context = target.getContext('2d')!, previous = stroke.current!;
    drawInkSegment(target, context, previous, { x, y }, { ...settings, width: settings.width * target.width / target.getBoundingClientRect().width }, marker.current);
    stroke.current = { ...previous, x, y }; dirty.current = true;
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') { touches.current.delete(event.pointerId); pinch.current = null; return; }
    if (stroke.current?.id !== event.pointerId) return;
    stroke.current = null;
    void persist().catch(() => {});
  };
  return <>
    {error ? <p className="reference-image-error" role="alert">{error}{ready ? <button type="button" onClick={() => void persist().catch(() => {})}>再試行</button> : null}</p> : null}
    <div className="reference-image-stage"><div ref={paper} className="reference-image-paper" style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, aspectRatio: aspect, width: `min(100%, ${aspect * 100}cqh)` }}>
      <img src={url} alt={`参照画像${item.number}`} draggable={false} />
      <canvas ref={canvas} aria-label="参照画像への書き込み" onPointerDown={event => {
        if (!ready || disabled) return;
        if (event.pointerType === 'touch') { touchStart(event); return; }
        if (stroke.current || event.button !== 0 || !event.isPrimary) return;
        onActivate(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); remember();
        const position = point(event); stroke.current = { id: event.pointerId, ...position };
        marker.current = settings.tool === 'marker' ? beginMarkerStroke(event.currentTarget, position) : null;
      }} onPointerMove={event => { if (event.pointerType === 'touch') { touchMove(event); return; } if (stroke.current?.id === event.pointerId) { const position = point(event); draw(position.x, position.y); } }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
    </div></div>
  </>;
});
