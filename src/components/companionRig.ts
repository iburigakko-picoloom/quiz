import rigImage from '../assets/companion/papillon-rig-v2.webp';
import sleepingHeadImage from '../assets/companion/papillon-sleep-head-v2.webp';
import { solveCompanionLeg, type CompanionPose } from '../utils/companionAnimation';

type Sprite = { x: number; y: number; w: number; h: number };
// Coordinates belong to this checked atlas, rather than automatic crops of a
// face-only photograph. Joint overlaps keep the fine fur edges intact.
const SPRITES: Sprite[] = [
  { x: 43, y: 48, w: 248, h: 255 }, { x: 358, y: 48, w: 249, h: 255 },
  { x: 652, y: 40, w: 267, h: 273 }, { x: 980, y: 40, w: 245, h: 272 },
  { x: 32, y: 327, w: 282, h: 291 }, { x: 346, y: 329, w: 284, h: 287 },
  { x: 638, y: 344, w: 283, h: 275 }, { x: 970, y: 345, w: 255, h: 273 },
  { x: 124, y: 630, w: 129, h: 290 }, { x: 404, y: 630, w: 128, h: 290 },
  { x: 695, y: 633, w: 184, h: 282 }, { x: 997, y: 632, w: 189, h: 281 },
  { x: 34, y: 944, w: 280, h: 292 }, { x: 383, y: 948, w: 183, h: 270 },
  { x: 642, y: 951, w: 276, h: 263 }, { x: 941, y: 973, w: 295, h: 192 },
];
export type CompanionRigAssets = { atlas: HTMLImageElement; sleepingHead: HTMLImageElement };
let rigPromise: Promise<CompanionRigAssets> | undefined;
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.decoding = 'async';
    image.onload = () => resolve(image); image.onerror = () => reject(new Error('キャラの動作素材を読み込めませんでした。'));
    image.src = src;
  });
}
export function loadCompanionRig(): Promise<CompanionRigAssets> {
  return rigPromise ??= Promise.all([loadImage(rigImage), loadImage(sleepingHeadImage)])
    .then(([atlas, sleepingHead]) => ({ atlas, sleepingHead }))
    .catch(error => { rigPromise = undefined; throw error; });
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));

function sprite(ctx: CanvasRenderingContext2D, image: HTMLImageElement, index: number, x: number, y: number, w: number, h: number,
  angle = 0, pivotX = .5, pivotY = .5, alpha = 1, flip = false, cropStart = 0, cropEnd = 1) {
  if (alpha < .002) return;
  const source = SPRITES[index];
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); if (flip) ctx.scale(-1, 1); ctx.globalAlpha *= alpha;
  if (cropStart > 0 || cropEnd < 1) {
    const left = -w * pivotX, top = -h * pivotY, radius = Math.min(w * .34, h * .18);
    ctx.beginPath(); ctx.moveTo(left + radius, top);
    ctx.lineTo(left + w - radius, top); ctx.quadraticCurveTo(left + w, top, left + w, top + radius);
    ctx.lineTo(left + w, top + h - radius); ctx.quadraticCurveTo(left + w, top + h, left + w - radius, top + h);
    ctx.lineTo(left + radius, top + h); ctx.quadraticCurveTo(left, top + h, left, top + h - radius);
    ctx.lineTo(left, top + radius); ctx.quadraticCurveTo(left, top, left + radius, top); ctx.closePath(); ctx.clip();
  }
  ctx.drawImage(image, source.x, source.y + source.h * cropStart, source.w, source.h * (cropEnd - cropStart), -w * pivotX, -h * pivotY, w, h);
  ctx.restore();
}

function leg(ctx: CanvasRenderingContext2D, image: HTMLImageElement, index: number, start: { x: number; y: number },
  foot: { x: number; y: number }, upper: number, lower: number, width: number, bend = 1, alpha = 1, upperSprite = index) {
  const solved = solveCompanionLeg(start, foot, upper, lower, bend);
  sprite(ctx, image, upperSprite, start.x, start.y, width * 1.05, upper + 15, solved.upperAngle, .5, .05, alpha, false, 0, .57);
  sprite(ctx, image, index, solved.knee.x, solved.knee.y, width, lower + 14, solved.lowerAngle, .5, .075, alpha, false, .40, 1);
}

/** Shared renderer for home and care. Only bones and individual sprites move;
 * the entire dog is never spun as a flat photo or cropped to its head. */
export function drawCompanionRig(ctx: CanvasRenderingContext2D, rig: CompanionRigAssets, pose: CompanionPose, time: number, width: number, height: number) {
  const image = rig.atlas;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
  const scale = Math.min(width / 510, height / 470);
  ctx.setTransform(scale, 0, 0, scale, (width - 510 * scale) / 2 - 45 * scale, (height - 470 * scale) / 2 - 40 * scale);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const sec = time / 1_000, side = Math.sin(pose.yaw), facing = Math.cos(pose.yaw), profile = Math.abs(side);
  // Opaque directional views avoid translucent double faces during a turn.
  // Position, silhouette width, feet and ear bones still turn continuously.
  const front = facing > .46 ? 1 : 0, back = facing < -.46 ? 1 : 0, sideAlpha = 1 - front - back;
  const direction = side >= 0 ? 1 : -1;
  const baseX = 300 + pose.rootX, baseY = pose.rootY;
  ctx.save(); ctx.translate(baseX, baseY);
  const shadow = ctx.createRadialGradient(0, 482, 8, 0, 482, pose.lying > .5 ? 138 : 103);
  shadow.addColorStop(0, 'rgba(89,74,59,.13)'); shadow.addColorStop(1, 'rgba(89,74,59,0)');
  ctx.save(); ctx.translate(0, 482); ctx.scale(1, .13); ctx.fillStyle = shadow; ctx.beginPath(); ctx.ellipse(0, 0, 150, 120, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();

  const bodyX = pose.bodyX - side * 8;
  const bellyUp = Math.sin(pose.roll / 2) ** 2;
  const tailX = 66 * (1 - profile) - side * 89;
  const tailAngle = Math.sin(sec * 5.2) * pose.tailWag * .26 - side * .12;
  sprite(ctx, image, 12, tailX, pose.bodyY + pose.bodyHeight * .25, pose.lying ? 125 : 133, pose.lying ? 113 : 160,
    tailAngle, .18, .88, .94, side > .6);

  // Hind paws are behind the chest. During the ear scratch the near leg reaches
  // the ear through two joints, while the other three paws support the body.
  for (const direction of [-1, 1]) {
    const stride = Math.sin(sec * 11 + (direction > 0 ? Math.PI : 0)) * pose.stepping;
    const hipX = bodyX + direction * pose.hipSpread - side * 28;
    const footX = bodyX + direction * pose.hindFootSpread - side * 50 + stride * 10;
    const footY = pose.hindFootY - Math.max(0, stride) * 12;
    const alpha = (direction < 0 ? 1 - pose.scratch : 1) * (1 - bellyUp);
    sprite(ctx, image, direction < 0 ? 10 : 11, footX, footY, pose.lying ? 66 : 78, Math.max(68, footY - pose.hipY + 25),
      stride * .08 + Math.sin(pose.roll) * direction * .12, .5, .94, alpha);
    if (pose.roll > .1) {
      leg(ctx, image, direction < 0 ? 8 : 9, { x: hipX, y: pose.hipY }, { x: footX, y: footY }, 50, 52, 40, direction, bellyUp);
      sprite(ctx, image, 13, footX, footY, 38, 50, direction * .13, .5, .5, bellyUp);
    }
  }

  const torsoWidth = pose.bodyWidth * (1 - .18 * profile);
  sprite(ctx, image, 4, bodyX, pose.bodyY, torsoWidth, pose.bodyHeight, 0, .5, .5, front * (1 - pose.lying));
  sprite(ctx, image, 6, bodyX, pose.bodyY, torsoWidth, pose.bodyHeight, 0, .5, .5, back * (1 - pose.lying));
  sprite(ctx, image, 5, bodyX, pose.bodyY, pose.bodyWidth + profile * 55, pose.bodyHeight * .94, 0, .5, .5, sideAlpha * (1 - pose.lying), side > 0);
  sprite(ctx, image, 15, bodyX, pose.bodyY, pose.bodyWidth, pose.bodyHeight, 0, .5, .5, pose.lying && bellyUp < .5 ? 1 : 0, side < -.6);
  sprite(ctx, image, 4, bodyX, pose.bodyY, pose.bodyWidth * .78, pose.bodyHeight * 1.14, Math.sin(pose.roll) * .12, .5, .5, pose.lying && bellyUp >= .5 ? 1 : 0);

  for (const direction of [-1, 1]) {
    const stride = Math.sin(sec * 11 + (direction > 0 ? 0 : Math.PI)) * pose.stepping;
    const start = { x: bodyX + direction * pose.shoulderSpread + side * 45, y: pose.shoulderY };
    const foot = { x: direction * pose.frontFootSpread + side * 57 + stride * 9, y: pose.frontFootY - Math.max(0, stride) * 13 };
    if (direction > 0 && pose.touch > .001) {
      foot.x += pose.touch * 53; foot.y -= pose.touch * 230;
      leg(ctx, image, 9, start, foot, 88, 79, 43, -1);
      sprite(ctx, image, 13, foot.x, foot.y, 49, 67, -.1 + Math.sin(sec * 7) * pose.touch * .03, .5, .55, pose.touch);
    } else if (pose.headPitch > .25 || pose.roll > .1) {
      leg(ctx, image, direction < 0 ? 8 : 9, start, foot, pose.lying ? 65 : 88, pose.lying ? 60 : 79, pose.lying ? 43 : 47, -direction);
      if (bellyUp > .001) sprite(ctx, image, 13, foot.x, foot.y, 41, 55, direction * .15, .5, .5, bellyUp);
    } else {
      const length = Math.max(53, Math.hypot(foot.x - start.x, foot.y - start.y));
      sprite(ctx, image, direction < 0 ? 8 : 9, foot.x, foot.y, pose.lying ? 47 : 49, length + 11,
        -Math.atan2(foot.x - start.x, foot.y - start.y), .5, .94);
    }
  }
  if (pose.scratch > .001) {
    const start = { x: -69, y: 393 }, target = { x: -78 + Math.sin(time / 85) * 5, y: pose.headY + 10 + Math.sin(time / 85) * 7 };
    const neutral = { x: -72, y: 477 };
    const foot = { x: neutral.x + (target.x - neutral.x) * pose.scratch, y: neutral.y + (target.y - neutral.y) * pose.scratch };
    leg(ctx, image, 8, start, foot, 75, 92, 43, -1, 1, 10);
  }

  const headX = pose.headX + side * 51, headY = pose.headY + profile * 10;
  // A fur-covered neck overlaps both parts, including profile/back views. Its
  // ends follow the head and chest rather than leaving a floating cutout head.
  const neckTop = { x: headX, y: headY + pose.headSize * .27 };
  const neckBase = { x: bodyX + side * torsoWidth * .27, y: pose.bodyY - pose.bodyHeight * .22 };
  const neckLength = Math.hypot(neckBase.x - neckTop.x, neckBase.y - neckTop.y);
  sprite(ctx, image, 4, neckTop.x, neckTop.y, pose.headSize * .59, Math.max(48, neckLength + 31),
    -Math.atan2(neckBase.x - neckTop.x, neckBase.y - neckTop.y), .5, .05, 1 - pose.lying, false, 0, .57);
  ctx.save(); ctx.translate(headX, headY); ctx.rotate(pose.headTilt); ctx.scale(1, 1 - pose.headPitch * .10);
  const headWidth = pose.headSize, headHeight = pose.headSize * 1.04;
  const earWidth = headWidth * .85, earHeight = headWidth * .94;
  const droop = pose.earDroop * .65, flutter = pose.earFlutter;
  const leftEarX = -headWidth * .32 + side * 16, rightEarX = headWidth * .32 - side * 28;
  sprite(ctx, image, 2, leftEarX, -headHeight * .25, earWidth * (1 - profile * .12), earHeight,
    -.43 - droop + flutter, .85, .84, 1);
  sprite(ctx, image, 3, rightEarX, -headHeight * .25, earWidth * (1 - profile * .12), earHeight,
    .43 + droop - flutter, .17, .84, 1);
  sprite(ctx, image, 0, 0, 0, headWidth, headHeight, 0, .5, .5, front);
  sprite(ctx, image, 1, 0, 0, headWidth, headHeight, 0, .5, .5, front * pose.eyesClosed * (1 - pose.asleep));
  if (front && pose.asleep > .001) {
    ctx.save(); ctx.globalAlpha *= pose.asleep;
    ctx.drawImage(rig.sleepingHead, 150, 179, 951, 930, -headWidth / 2, -headHeight / 2, headWidth, headHeight);
    ctx.restore();
  }
  sprite(ctx, image, 14, 0, 0, headWidth, headHeight, 0, .5, .5, back);
  sprite(ctx, image, 7, side * 7, 0, headWidth * 1.02, headHeight, 0, .5, .5, sideAlpha, side < 0);
  ctx.restore(); ctx.restore();
}
