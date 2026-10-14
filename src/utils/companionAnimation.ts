import { pickCompanionReaction, type CompanionReaction, type CompanionTrickId } from './companionCare';

export type CompanionAction = CompanionTrickId | 'feed' | 'pet';
export type CompanionActivity = 'sit' | 'stand' | 'scratch' | 'lie' | 'sleep' | 'stretch' | CompanionReaction | CompanionAction;
export type CompanionMotion = { id: number; kind: CompanionAction; awkward?: boolean };
export const COMPANION_MOTION_MS: Record<CompanionAction, number> = {
  spin: 3_200, touch: 3_000, bow: 3_200, roll: 4_400, sleep: 4_600, feed: 2_400, pet: 2_600,
};
export function companionMotionDuration(kind: CompanionAction, awkward = false): number {
  return COMPANION_MOTION_MS[kind] * (awkward ? 1.25 : 1);
}

export const COMPANION_IDLE_CLIPS: readonly { activity: CompanionActivity; duration: number }[] = [
  { activity: 'sit', duration: 5_000 },
  { activity: 'scratch', duration: 4_800 },
  { activity: 'sit', duration: 3_000 },
  { activity: 'stand', duration: 4_000 },
  { activity: 'lie', duration: 6_000 },
  { activity: 'sleep', duration: 8_000 },
  { activity: 'stretch', duration: 4_500 },
  { activity: 'stand', duration: 3_000 },
];

export interface CompanionPose {
  rootX: number; rootY: number; yaw: number;
  headY: number; headX: number; headSize: number; headTilt: number; headPitch: number;
  bodyY: number; bodyX: number; bodyWidth: number; bodyHeight: number; lying: number;
  shoulderY: number; shoulderSpread: number; frontFootY: number; frontFootSpread: number;
  hipY: number; hipSpread: number; hindFootY: number; hindFootSpread: number;
  earDroop: number; earFlutter: number; tailWag: number; eyesClosed: number; asleep: number;
  touch: number; scratch: number; roll: number; stepping: number;
}

const standing: CompanionPose = {
  rootX: 0, rootY: 0, yaw: 0, headY: 180, headX: 0, headSize: 144, headTilt: 0, headPitch: 0,
  bodyY: 313, bodyX: 0, bodyWidth: 166, bodyHeight: 193, lying: 0,
  shoulderY: 310, shoulderSpread: 32, frontFootY: 478, frontFootSpread: 36,
  hipY: 335, hipSpread: 55, hindFootY: 474, hindFootSpread: 66,
  earDroop: 0, earFlutter: 0, tailWag: 0.4, eyesClosed: 0, asleep: 0, touch: 0, scratch: 0, roll: 0, stepping: 0,
};
const seated: CompanionPose = { ...standing, headY: 195, bodyY: 354, bodyWidth: 192, bodyHeight: 213,
  shoulderY: 331, hipY: 394, hindFootSpread: 72, tailWag: 0.22 };
const lying: CompanionPose = { ...standing, headY: 350, headSize: 138, bodyY: 413, bodyWidth: 308, bodyHeight: 129, lying: 1,
  shoulderY: 424, shoulderSpread: 33, frontFootSpread: 58, hipY: 435, hindFootSpread: 120, earDroop: 0.22, tailWag: 0.12 };
const sleeping: CompanionPose = { ...lying, headY: 401, headSize: 131, headPitch: 0.1, bodyY: 422, bodyHeight: 115,
  shoulderY: 444, frontFootSpread: 52, earDroop: 0.5, eyesClosed: 1, asleep: 1, tailWag: 0.03 };
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const companionEase = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const pulse = (t: number, start: number, peak: number, end: number) => t < peak
  ? companionEase((t - start) / (peak - start)) : 1 - companionEase((t - peak) / (end - peak));
export function blendCompanionPose(a: CompanionPose, b: CompanionPose, weight: number): CompanionPose {
  const result = {} as CompanionPose;
  const t = clamp(weight);
  for (const key of Object.keys(a) as (keyof CompanionPose)[]) result[key] = a[key] + (b[key] - a[key]) * t;
  return result;
}
export const restingCompanionPose = () => ({ ...seated });

/** A continuous pose, not a list of photographs. Feet remain planted while the torso lowers. */
export function companionActivityPose(activity: CompanionActivity, elapsed: number, duration: number, clock: number, awkward = false): CompanionPose {
  const t = clamp(elapsed / duration);
  const seconds = clock / 1_000;
  let pose = { ...seated };
  const slow = awkward ? 0.78 : 1;
  if (activity === 'stand' || activity === 'approach' || activity === 'spin' || activity === 'bow' || activity === 'stretch') pose = { ...standing };
  if (activity === 'lie' || activity === 'roll') pose = { ...lying };
  if (activity === 'sleep' || activity === 'relax') pose = { ...sleeping };
  if (activity === 'scratch') {
    const reach = pulse(t, .05, .3, .95);
    pose.headY += reach * 34; pose.headX = -12 * reach; pose.headTilt = -.16 * reach;
    pose.scratch = reach; pose.eyesClosed = reach * .55;
    pose.earFlutter = Math.sin(elapsed / 90) * reach * .14;
  }
  if (activity === 'spin') {
    const phase = companionEase((t - .08) / .82);
    pose.yaw = phase * Math.PI * 2;
    if (awkward) pose.yaw += Math.sin(phase * Math.PI * 12) * Math.sin(phase * Math.PI) * .07;
    pose.stepping = Math.sin(Math.PI * clamp((t - .02) / .95));
    pose.rootX = Math.sin(pose.yaw) * 14; pose.tailWag = .65;
  }
  if (activity === 'touch') {
    pose.touch = pulse(t, .08, .44, .93) * (awkward ? .85 : 1);
    pose.headTilt = pose.touch * -.09; pose.tailWag = .55;
  }
  if (activity === 'bow' || activity === 'stretch') {
    const bow = pulse(t, .04, .43, .96) * (awkward ? .72 : 1);
    pose.headY += 111 * bow; pose.headPitch = bow * .85;
    pose.bodyY += 35 * bow; pose.bodyHeight -= 27 * bow;
    pose.shoulderY += 65 * bow; pose.earDroop = .2 * bow;
    pose.frontFootSpread += 14 * bow;
  }
  if (activity === 'roll') {
    const turn = companionEase((t - .16) / .66) * Math.PI * 2;
    const envelope = pulse(t, .02, .42, .97);
    pose.roll = turn; pose.headX = -57 * envelope; pose.headY = 389 + 15 * envelope;
    pose.bodyX = 23 * envelope; pose.bodyWidth = 282;
    pose.bodyY -= Math.sin(turn) ** 2 * 12;
    pose.bodyHeight += Math.sin(turn) ** 2 * 25;
    const bellyUp = Math.sin(turn / 2) ** 2;
    pose.headTilt = Math.sin(turn) * .65;
    pose.frontFootY = 478 - bellyUp * 146;
    pose.hindFootY = 472 - bellyUp * 128;
    pose.earDroop = .3 + Math.sin(turn) ** 2 * .25;
    pose.tailWag = .4;
  }
  if (activity === 'sleep') {
    pose = blendCompanionPose(lying, sleeping, companionEase(t / .48));
    pose.eyesClosed = companionEase((t - .14) / .35);
  }
  if (activity === 'feed') {
    const nibble = pulse(t, .03, .38, .96);
    pose.headY += nibble * 36 + Math.sin(elapsed / 120) * nibble * 3;
    pose.headPitch = nibble * .35; pose.tailWag = .65;
  }
  if (activity === 'pet' || activity === 'cuddle') {
    const lean = pulse(t, .03, .5, .97);
    pose.headTilt = -.15 * lean; pose.headX = -9 * lean; pose.eyesClosed = lean * .85; pose.tailWag = .65;
    pose.earDroop = .16 * lean;
  }
  if (activity === 'happy') { pose.tailWag = .85; pose.earFlutter = Math.sin(seconds * 4) * .025; }
  if (activity === 'approach') {
    const walk = pulse(t, .02, .46, .97);
    pose.rootX = -28 * walk; pose.rootY = 9 * walk; pose.stepping = walk * .5; pose.tailWag = .65;
  }
  if (activity === 'watch' || activity === 'sit') pose.headTilt += Math.sin(seconds * .58) * .045;
  // Tiny overlapping motions continue even between the larger behaviours.
  const breath = Math.sin(seconds * (pose.eyesClosed > .8 ? 1.65 : 2.05));
  pose.bodyHeight += breath * (pose.lying ? 2.2 : 2.5);
  pose.headY += breath * .9;
  pose.earFlutter += Math.sin(seconds * 2.3 + .4) * .018;
  const blinkCycle = ((seconds % 4.7) + 4.7) % 4.7;
  const blink = Math.max(pulse(blinkCycle, 3.6, 3.71, 3.86), pulse(blinkCycle, 4.03, 4.11, 4.23) * .8);
  pose.eyesClosed = Math.max(pose.eyesClosed, blink);
  if (awkward) pose.headTilt += Math.sin(seconds * 7 * slow) * .022;
  return pose;
}

/** Reachable two-bone limb; knees bend instead of stretching the bitmap. */
export function solveCompanionLeg(start: { x: number; y: number }, target: { x: number; y: number }, upper: number, lower: number, bend = 1) {
  const dx = target.x - start.x, dy = target.y - start.y;
  const requested = Math.hypot(dx, dy);
  const distance = Math.max(Math.abs(upper - lower) + .001, Math.min(requested, upper + lower - .001));
  const foot = requested > .001 ? { x: start.x + dx / requested * distance, y: start.y + dy / requested * distance }
    : { x: start.x, y: start.y + distance };
  const offset = Math.acos(clamp((upper * upper + distance * distance - lower * lower) / (2 * upper * distance), -1, 1)) * bend;
  const angle = Math.atan2(dy, dx) + offset;
  const knee = { x: start.x + Math.cos(angle) * upper, y: start.y + Math.sin(angle) * upper };
  const endAngle = Math.atan2(foot.y - knee.y, foot.x - knee.x);
  return { knee, foot, upperAngle: angle - Math.PI / 2, lowerAngle: endAngle - Math.PI / 2 };
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
