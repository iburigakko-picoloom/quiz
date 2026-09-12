import { useEffect, useRef } from 'react';

/** Local image zoom; a single finger still scrolls normally at the original size. */
export function PinchImage({ src, alt }: { src: string; alt: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = frame.current!, img = image.current!;
    let scale = 1, x = 0, y = 0;
    let gesture: { distance: number; cx: number; cy: number; scale: number; x: number; y: number } | null = null;
    const paint = () => {
      const maxX = img.clientWidth * (scale - 1) / 2;
      const maxY = img.clientHeight * (scale - 1) / 2;
      x = Math.max(-maxX, Math.min(maxX, x));
      y = Math.max(-maxY, Math.min(maxY, y));
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };
    const point = (touches: TouchList) => {
      const a = touches[0], b = touches[1] ?? a, rect = el.getBoundingClientRect();
      return { cx: (a.clientX + b.clientX) / 2 - rect.left - rect.width / 2,
        cy: (a.clientY + b.clientY) / 2 - rect.top - rect.height / 2,
        distance: touches.length > 1 ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0 };
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length > 1 || scale > 1) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        gesture = { ...point(event.touches), scale, x, y };
      }
    };
    const move = (event: TouchEvent) => {
      if (!gesture || !event.touches.length) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const p = point(event.touches);
      scale = gesture.distance && p.distance ? Math.max(1, Math.min(4, gesture.scale * p.distance / gesture.distance)) : scale;
      const ratio = scale / gesture.scale;
      x = p.cx - (gesture.cx - gesture.x) * ratio;
      y = p.cy - (gesture.cy - gesture.y) * ratio;
      paint();
    };
    const end = (event: TouchEvent) => {
      gesture = event.touches.length && scale > 1 ? { ...point(event.touches), scale, x, y } : null;
    };
    const cancel = () => { gesture = null; };
    const key = (event: KeyboardEvent) => {
      if (!['+', '=', '-', '0', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      scale = event.key === '0' || event.key === 'Escape' ? 1 : Math.max(1, Math.min(4, scale + (event.key === '-' ? -.5 : .5)));
      paint();
    };
    paint();
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', cancel); el.removeEventListener('keydown', key);
    };
  }, [src]);
  return <span ref={frame} className="weakness-pinch-image" data-no-page-swipe tabIndex={0}
    role="group" aria-label={`${alt || '画像'}：2本指で拡大・縮小。キーボードは＋・−、0で元に戻す`}>
    <img ref={image} src={src} alt={alt} loading="lazy" draggable={false}/>
  </span>;
}
