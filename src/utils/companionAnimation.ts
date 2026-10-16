import { pickCompanionReaction, type CompanionReaction, type CompanionTrickId } from './companionCare';

export type CompanionAction = CompanionTrickId | 'feed' | 'pet';
export type CompanionActivity = 'sit' | 'stand' | 'scratch' | 'lie' | 'sleep' | 'stretch' | CompanionReaction | CompanionAction;
export type CompanionMotion = { id: number; kind: CompanionAction; awkward?: boolean };
export type CompanionSheet = 'idle' | 'scratch' | 'sleep' | 'spin' | 'spinSmooth' | 'touch' | 'bow' | 'roll' | 'care';
export const COMPANION_MOTION_MS: Record<CompanionAction, number> = {
  spin: 1_600, touch: 1_800, bow: 1_800, roll: 1_800, sleep: 4_600, feed: 2_000, pet: 2_400,
};
export function companionMotionDuration(kind: CompanionAction, awkward = false): number {
  return COMPANION_MOTION_MS[kind] * (awkward ? 1.25 : 1);
}

export const COMPANION_IDLE_CLIPS: readonly { activity: CompanionActivity; duration: number }[] = [
  { activity: 'sit', duration: 6_000 },
  { activity: 'scratch', duration: 2_400 },
  { activity: 'sit', duration: 4_000 },
  { activity: 'stand', duration: 3_000 },
  { activity: 'lie', duration: 4_000 },
  { activity: 'sleep', duration: 6_000 },
  { activity: 'stretch', duration: 2_500 },
  { activity: 'sit', duration: 4_000 },
];

// Every index is ONE complete full-body drawing. Transitions mix whole cels;
// there are no bones, body-part transforms, or geometry deformation.
type Cel = readonly [frame: number, weight: number];
type Clip = { sheet: CompanionSheet; cels: readonly Cel[]; continuous?: boolean; transitionMs?: number };
const sequence = (frames: readonly number[], weight = 1): Cel[] => frames.map(frame => [frame, weight]);
const idle: Clip = { sheet: 'idle', cels: [[0, 3], [1, 3], [2, 3], [3, 3], [4, 2], [5, .7], [6, .6], [7, .7], ...sequence([8, 9, 10, 11, 12, 13, 14, 15], 2)] };
const sleep: Clip = { sheet: 'sleep', transitionMs: 80, cels: [...sequence([0, 1, 2, 3, 4, 5, 6]), [7, 4], [8, 18], [9, 18], ...sequence([10, 11, 12, 13, 14, 15])] };
const bow: Clip = { sheet: 'bow', transitionMs: 70, cels: [...sequence([0, 1, 2, 3, 4, 5, 6]), [7, 2], [8, 2], ...sequence([9, 10, 11, 12, 13, 14, 15])] };
const clips: Record<CompanionActivity, Clip> = {
  sit: idle, happy: idle,
  watch: { sheet: 'care', cels: [[0, 3], [1, 2], [2, 2], [1, 2], [0, 3]] },
  scratch: { sheet: 'scratch', cels: sequence([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) },
  stand: { sheet: 'spin', cels: [[0, 4], [1, 10], [2, 4], [1, 10], [14, 1], [15, 4]] },
  lie: { sheet: 'sleep', cels: [...sequence([0, 1, 2, 3]), [4, 28], [3, 1], [2, 1], [1, 1], [0, 2]] },
  sleep, relax: sleep, stretch: bow, bow,
  spin: { sheet: 'spinSmooth', continuous: true, cels: sequence(Array.from({ length: 32 }, (_, i) => i)) },
  // Later generated cels swap the offered paw. Use only the six consistent
  // drawings, then retrace them so the SAME paw returns to the floor.
  touch: { sheet: 'touch', transitionMs: 80, cels: [[0, 2], ...sequence([1, 2, 3, 4]), [5, 4], ...sequence([4, 3, 2, 1]), [0, 2]] },
  roll: { sheet: 'roll', transitionMs: 36, cels: sequence([0, 1, 2, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]) },
  pet: { sheet: 'care', cels: [[0, 1], [1, 1], [2, 1], [3, 2], [4, 2], [5, 1], [6, 1], [7, 1]] },
  cuddle: { sheet: 'care', cels: [[0, 1], [1, 1], [2, 1], [3, 2], [4, 2], [5, 1], [6, 1], [7, 1]] },
  feed: { sheet: 'care', cels: [[8, 1], [9, 1], [10, 1], [11, 1], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1]] },
  approach: { sheet: 'spin', cels: [[0, 1], [1, 1], [2, 1], [1, 1], [2, 1], [1, 1], [14, 1], [15, 2]] },
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function companionFrame(activity: CompanionActivity, elapsed: number, duration: number, _awkward = false, reduced = false) {
  const clip = clips[activity];
  // Practice already has a longer duration. Keep its timeline continuous;
  // the old mid-action freeze made every learning attempt visibly stutter.
  let t = clamp(Number.isFinite(elapsed / duration) ? elapsed / duration : 0);
  if (reduced) t = .5;
  const total = clip.cels.reduce((sum, [, weight]) => sum + weight, 0);
  let remaining = t * total;
  let index = clip.cels[clip.cels.length - 1][0];
  let nextIndex = index, mix = 0;
  for (let i = 0; i < clip.cels.length; i++) {
    const [frame, weight] = clip.cels[i];
    if (remaining < weight) {
      index = frame;
      nextIndex = clip.cels[Math.min(i + 1, clip.cels.length - 1)][0];
      const seated = activity === 'sit' || activity === 'happy';
      if (!reduced && (seated || clip.continuous || clip.transitionMs)) {
        const segmentMs = weight / total * duration;
        // Moving clips interpolate for the entire interval. Holding each cel
        // then easing into the next stops/starts a spin sixteen times. Keep
        // linear velocity across cel boundaries; resting clips may still hold.
        const continuous = seated || clip.continuous;
        const fadeMs = continuous ? segmentMs : Math.min(segmentMs, clip.transitionMs!);
        const progress = clamp((remaining / weight * segmentMs - (segmentMs - fadeMs)) / fadeMs);
        const blend = continuous ? progress : progress * progress * (3 - 2 * progress);
        mix = Math.round(blend * 1000) / 1000;
      }
      break;
    }
    remaining -= weight;
  }
  return { sheet: clip.sheet, index, nextIndex, mix };
}

export function nextCompanionIdle(index: number, friendship: number, variant: number) {
  const base = COMPANION_IDLE_CLIPS[index % COMPANION_IDLE_CLIPS.length];
  const reaction = pickCompanionReaction(friendship, variant);
  return { ...base, reaction, extra: reaction === 'watch' ? null : { activity: reaction as CompanionActivity, duration: reaction === 'relax' ? 5_500 : 3_500 } };
}

export const companionActivityMessage = (activity: CompanionActivity): string => ({
  sit: 'ちょこんと座って、あなたを見ている。', stand: '立ち上がって、あたりを見ている。', scratch: '後ろ足で耳をかいている。',
  lie: '前足を伸ばして、ゆっくり伏せている。', sleep: '目を閉じて、すやすや休んでいる。', stretch: 'ぐーっと伸びて、ひと休み。',
  watch: '首をかしげて、あなたを見ている。', happy: 'しっぽを振って、うれしそう。', approach: 'あなたのそばに寄ってきた。',
  cuddle: 'そっと体を寄せて、甘えている。', relax: 'あなたのそばで、安心してくつろいでいる。',
  spin: '足を踏みかえて、くるっとひと回り。', touch: '前足をあげて、タッチ！', bow: '前足を曲げて、ぺこり。',
  roll: 'ころんと横になって、ごろん。', feed: 'おいしそうに食べている。', pet: 'なでてもらって、気持ちよさそう。',
})[activity];
