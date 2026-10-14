import { useEffect, useRef, useState } from 'react';
import type { CompanionReaction } from '../utils/companionCare';
import { COMPANION_IDLE_CLIPS, blendCompanionPose, companionActivityPose, companionEase, companionMotionDuration,
  companionActivityMessage, nextCompanionIdle, restingCompanionPose, type CompanionActivity, type CompanionMotion } from '../utils/companionAnimation';
import { drawCompanionRig, loadCompanionRig, type CompanionRigAssets } from './companionRig';
import helloImage from '../assets/companion/hello.webp';
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
    let stopped = false, inView = true, frame = 0, lastTick = 0, clock = 0;
    let rig: CompanionRigAssets | null = null;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = media.matches;
    let idleIndex = 0, inExtra = false, clip: { activity: CompanionActivity; duration: number } = COMPANION_IDLE_CLIPS[0];
    let elapsed = 0, motionId: number | null = null, announced = '';
    let pose = restingCompanionPose(), fromPose = pose;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr)), height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    };
    const announce = (activity: CompanionActivity) => {
      if (announced === activity) return;
      announced = activity; canvas.dataset.activity = activity;
      const reaction = ['watch', 'happy', 'approach', 'cuddle', 'relax'].includes(activity) ? activity as CompanionReaction : 'watch';
      latest.current.onReaction?.(reaction); latest.current.onActivity?.(activity);
    };
    const beginClip = (next: typeof clip) => {
      fromPose = pose; clip = next; elapsed = 0; announce(next.activity);
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
      if (stopped || !rig || !inView || document.visibilityState === 'hidden') return;
      frame = window.requestAnimationFrame(render);
      if (lastTick && now - lastTick < (reduced ? 75 : 1000 / 30)) return;
      const dt = lastTick ? Math.min(100, now - lastTick) : 0; lastTick = now;
      clock += dt; elapsed += dt;
      const action = latest.current.motion;
      if (action && motionId !== action.id) {
        motionId = action.id; beginClip({ activity: action.kind, duration: companionMotionDuration(action.kind, action.awkward) });
      } else if (!action && motionId !== null) {
        motionId = null; idleIndex = pose.lying > .5 ? 4 : 0; inExtra = false;
        beginClip(COMPANION_IDLE_CLIPS[idleIndex]);
      } else if (!action && !reduced && elapsed >= clip.duration) advanceIdle();
      const activity = !action && reduced ? 'sit' : clip.activity;
      announce(activity);
      const target = companionActivityPose(activity, reduced && action ? clip.duration * .55 : elapsed, clip.duration, clock, action?.awkward);
      pose = blendCompanionPose(fromPose, target, companionEase(elapsed / (reduced ? 200 : action ? 560 : 1_100)));
      drawCompanionRig(ctx, rig, pose, clock, canvas.width, canvas.height);
    };
    const wake = () => {
      window.cancelAnimationFrame(frame); frame = 0; lastTick = 0;
      if (!stopped && rig && inView && document.visibilityState !== 'hidden') frame = window.requestAnimationFrame(render);
    };
    const preference = () => { reduced = media.matches; canvas.dataset.reducedMotion = String(reduced); fromPose = pose; elapsed = 0; wake(); };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; wake(); }, { threshold: 0 }) : null;
    const dimensions = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas); dimensions?.observe(canvas);
    resize(); canvas.dataset.reducedMotion = String(reduced);
    document.addEventListener('visibilitychange', wake); media.addEventListener('change', preference);
    void loadCompanionRig().then(image => {
      if (stopped) return;
      rig = image; canvas.dataset.renderer = 'rig'; setLoaded(true); announce('sit'); resize(); wake();
    }).catch(() => { if (!stopped) setFailed(true); });
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
