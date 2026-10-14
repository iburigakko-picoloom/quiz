import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_IDLE_CLIPS, COMPANION_MOTION_MS, companionActivityPose, restingCompanionPose,
  companionMotionDuration, blendCompanionPose, solveCompanionLeg, nextCompanionIdle } from '../src/utils/companionAnimation.ts';

test('idle choreography includes scratching, standing, lying and sleeping without requiring friendship or food', () => {
  const clips = new Set(COMPANION_IDLE_CLIPS.map(clip => clip.activity));
  for (const activity of ['sit', 'scratch', 'stand', 'lie', 'sleep', 'stretch']) assert.ok(clips.has(activity));
  for (let i = 0; i < COMPANION_IDLE_CLIPS.length; i++) assert.equal(nextCompanionIdle(i, 0, .1).extra, null);
  assert.equal(nextCompanionIdle(0, 100, .4).extra.activity, 'cuddle');
});

test('breathing and blinking continue during a stationary seated pose', () => {
  const first = companionActivityPose('sit', 1000, 5000, 1000), second = companionActivityPose('sit', 1800, 5000, 1800);
  assert.notEqual(first.bodyHeight, second.bodyHeight); assert.notEqual(first.earFlutter, second.earFlutter);
  const open = companionActivityPose('sit', 1000, 5000, 1000), closed = companionActivityPose('sit', 3710, 5000, 3710);
  assert.equal(open.eyesClosed, 0); assert.ok(closed.eyesClosed > .99);
});

test('a turn uses front, profile and rear directions while the feet stay near the ground', () => {
  const duration = companionMotionDuration('spin');
  const angles = Array.from({ length: 120 }, (_, i) => companionActivityPose('spin', duration * i / 119, duration, i * 25));
  assert.ok(angles.some(pose => Math.cos(pose.yaw) < -.99));
  assert.ok(angles.some(pose => Math.abs(Math.sin(pose.yaw)) > .99));
  assert.ok(Math.abs(angles.at(-1).yaw - Math.PI * 2) < .001);
  assert.ok(angles.every(pose => pose.frontFootY >= 465 && pose.frontFootY <= 485));
});

test('paid practice can be hesitant while a learned trick has full reach and a shorter coherent duration', () => {
  const learnedDuration = companionMotionDuration('touch'), awkwardDuration = companionMotionDuration('touch', true);
  assert.ok(awkwardDuration > learnedDuration);
  const learned = companionActivityPose('touch', learnedDuration * .44, learnedDuration, 0);
  const awkward = companionActivityPose('touch', awkwardDuration * .44, awkwardDuration, 0, true);
  assert.ok(learned.touch > awkward.touch);
});

test('limbs bend with fixed lengths; interpolation cannot stretch a leg or produce nonfinite poses', () => {
  for (const target of [{ x: 52, y: -118 }, { x: -70, y: -155 }, { x: 2, y: 148 }]) {
    const leg = solveCompanionLeg({ x: 0, y: 0 }, target, 88, 79, -1);
    assert.ok(Math.abs(Math.hypot(leg.knee.x, leg.knee.y) - 88) < 1e-6);
    assert.ok(Math.abs(Math.hypot(leg.foot.x - leg.knee.x, leg.foot.y - leg.knee.y) - 79) < 1e-6);
    assert.ok(Math.hypot(leg.foot.x, leg.foot.y) < 167);
  }
  const seated = restingCompanionPose();
  for (const [activity, duration] of Object.entries(COMPANION_MOTION_MS)) for (let i = 0; i <= 100; i++) {
    const pose = companionActivityPose(activity, duration * i / 100, duration, duration * i / 100);
    const blended = blendCompanionPose(seated, pose, i / 100);
    assert.ok(Object.values(blended).every(Number.isFinite), `${activity} at ${i}%`);
  }
});
