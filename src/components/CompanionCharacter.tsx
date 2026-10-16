import { useEffect, useRef, useState } from 'react';
import type { CompanionReaction } from '../utils/companionCare';
import { COMPANION_IDLE_CLIPS, companionFrame, companionMotionDuration,
  companionActivityMessage, nextCompanionIdle, type CompanionSheet, type CompanionActivity, type CompanionMotion } from '../utils/companionAnimation';
import { drawCompanionFrame, loadCompanionSheet, type CompanionFrameDrawing } from './companionFrames';
import helloImage from '../assets/companion/hello.webp';
import { companionSheetLayout } from '../utils/companionFrameLayout';
import './CompanionCharacter.css';

export type { CompanionMotion, CompanionActivity } from '../utils/companionAnimation';
export { companionActivityMessage } from '../utils/companionAnimation';
export const companionReactionMessage = (reaction: CompanionReaction) => companionActivityMessage(reaction);

export function CompanionCharacter({ friendship = 0, motion = null, large = false, onReaction, onActivity }: {
  friendship?: number; motion?: CompanionMotion | null; large?: boolean;
  onReaction?: (reaction: CompanionReaction) => void; onActivity?: (activity: CompanionActivity) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ friendship, motion, onReaction, onActivity });
  latest.current = { friendship, motion, onReaction, onActivity };
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx) { setFailed(true); return; }
    let stopped = false, inView = true, frame = 0, lastTick = 0, lastDraw = '';
    let displayed: { image: HTMLImageElement; index: number; options: CompanionFrameDrawing } | null = null;
    let entranceFrom: CompanionFrameDrawing['from'];
    const sheets = new Map<CompanionSheet, HTMLImageElement>();
    const pending = new Set<CompanionSheet>();
    const failedSheets = new Set<CompanionSheet>();
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = media.matches;
    let idleIndex = 0, inExtra = false, clip: { activity: CompanionActivity; duration: number } = COMPANION_IDLE_CLIPS[0];
    let elapsed = 0, motionId: number | null = null, announced = '';

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr)), height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height; lastDraw = '';
        if (displayed) drawCompanionFrame(ctx, displayed.image, displayed.index, width, height, displayed.options);
      }
    };
    const announce = (activity: CompanionActivity) => {
      if (announced === activity) return;
      announced = activity; canvas.dataset.activity = activity;
      const reaction = ['watch', 'happy', 'approach', 'cuddle', 'relax'].includes(activity) ? activity as CompanionReaction : 'watch';
      latest.current.onReaction?.(reaction); latest.current.onActivity?.(activity);
    };
    const beginClip = (next: typeof clip) => {
      const seated = displayed && (displayed.options.sheet === 'idle' || displayed.index === 0 || displayed.index === companionSheetLayout(displayed.options.sheet).frames - 1);
      entranceFrom = seated && displayed ? { image: displayed.image, index: displayed.index, sheet: displayed.options.sheet,
        nextIndex: displayed.options.nextIndex, mix: displayed.options.mix } : undefined;
      clip = next; elapsed = 0; announce(next.activity);
      requestSheet(companionFrame(next.activity, 0, next.duration).sheet);
    };
    const advanceIdle = () => {
      if (!inExtra) {
        const extra = nextCompanionIdle(idleIndex, latest.current.friendship, Math.random()).extra;
        if (extra) { inExtra = true; beginClip(extra); return; }
      }
      inExtra = false; idleIndex = (idleIndex + 1) % COMPANION_IDLE_CLIPS.length;
      beginClip(COMPANION_IDLE_CLIPS[idleIndex]);
    };
    const render = (now: number) => {
      frame = 0;
      if (stopped || !sheets.has('idle') || !inView || document.visibilityState === 'hidden') return;
      frame = window.requestAnimationFrame(render);
      // Follow the display clock: a 60 Hz cutoff skips every other tick on
      // 90 Hz screens. Unchanged cels still skip the expensive canvas draw.
      const dt = lastTick ? Math.min(100, now - lastTick) : 0; lastTick = now;
      // A delayed sheet must not consume the beginning of the movement.
      if (sheets.has(companionFrame(clip.activity, 0, clip.duration).sheet)) elapsed += dt;
      const action = latest.current.motion;
      if (action && motionId !== action.id) {
        motionId = action.id; beginClip({ activity: action.kind, duration: companionMotionDuration(action.kind, action.awkward) });
      } else if (!action && motionId !== null) {
        motionId = null; idleIndex = 0; inExtra = false;
        beginClip(COMPANION_IDLE_CLIPS[idleIndex]);
      } else if (!action && !reduced && elapsed >= clip.duration) advanceIdle();
      const activity = !action && reduced ? 'sit' : clip.activity;
      announce(activity);
      const cel = companionFrame(activity, elapsed, clip.duration, action?.awkward, reduced);
      requestSheet(cel.sheet);
      const image = sheets.get(cel.sheet);
      // Keep the last complete dog while a new sheet loads; never draw pieces.
      if (image) {
        const phase = Math.min(1, elapsed / 120);
        const entrance = reduced ? 1 : Math.round(phase * phase * (3 - 2 * phase) * 1000) / 1000;
        const options: CompanionFrameDrawing = { ...cel, from: entrance < 1 ? entranceFrom : undefined, entrance };
        const key = `${cel.sheet}:${cel.index}:${cel.nextIndex}:${cel.mix}:${entrance}`;
        if (key !== lastDraw) {
          drawCompanionFrame(ctx, image, cel.index, canvas.width, canvas.height, options);
          displayed = { image, index: cel.index, options };
          lastDraw = key; canvas.dataset.cel = `${cel.sheet}:${cel.index}`;
          canvas.dataset.frameBlend = String(cel.mix);
        }
      }
    };
    const wake = () => {
      window.cancelAnimationFrame(frame); frame = 0; lastTick = 0;
      if (!stopped && sheets.has('idle') && inView && document.visibilityState !== 'hidden') frame = window.requestAnimationFrame(render);
    };
    const requestSheet = (sheet: CompanionSheet) => {
      if (sheets.has(sheet) || pending.has(sheet) || failedSheets.has(sheet)) return;
      pending.add(sheet);
      void loadCompanionSheet(sheet).then(image => {
        if (stopped) return;
        sheets.set(sheet, image); pending.delete(sheet); lastDraw = '';
        if (sheet === 'idle') {
          displayed = { image, index: 0, options: { sheet: 'idle' } };
          drawCompanionFrame(ctx, image, 0, canvas.width, canvas.height);
          canvas.dataset.renderer = 'full-body-frames'; setLoaded(true); announce('sit');
          // Prepare the small set of whole-body clips before the first action.
          for (const name of ['spinSmooth', 'scratch', 'sleep', 'spin', 'touch', 'bow', 'roll', 'care'] as const) requestSheet(name);
        }
        // Background preloads must not reset the running action's clock.
        if (sheet === 'idle' || sheet === companionFrame(clip.activity, 0, clip.duration).sheet) wake();
      }).catch(() => {
        pending.delete(sheet); failedSheets.add(sheet);
        if (!stopped && sheet === 'idle') setFailed(true);
      });
    };
    const preference = () => { reduced = media.matches; canvas.dataset.reducedMotion = String(reduced); elapsed = 0; lastDraw = ''; wake(); };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; wake(); }, { threshold: 0 }) : null;
    const dimensions = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas); dimensions?.observe(canvas);
    resize(); canvas.dataset.reducedMotion = String(reduced);
    document.addEventListener('visibilitychange', wake); media.addEventListener('change', preference);
    requestSheet('idle');
    return () => {
      stopped = true; window.cancelAnimationFrame(frame); observer?.disconnect(); dimensions?.disconnect();
      document.removeEventListener('visibilitychange', wake); media.removeEventListener('change', preference);
    };
  }, []);

  return <span className={`companion-character${large ? ' companion-character--large' : ''}`} aria-hidden="true">
    <canvas ref={canvasRef} width={600} height={520} className={`companion-character__canvas${loaded ? ' companion-character__canvas--ready' : ''}`} />
    {!loaded && <img className={`companion-character__fallback${failed ? ' companion-character__fallback--breathing' : ''}`} src={helloImage} alt="" draggable={false} />}
    {(motion?.kind === 'pet' || motion?.kind === 'feed') && <span key={motion.id} className="companion-character__heart">♡</span>}
    {motion?.kind === 'sleep' && <span className="companion-character__sleep">z z z</span>}
  </span>;
}
