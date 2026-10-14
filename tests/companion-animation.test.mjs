import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMPANION_IDLE_CLIPS, COMPANION_MOTION_MS, companionFrame,
  companionMotionDuration, nextCompanionIdle } from '../src/utils/companionAnimation.ts';

test('idle includes full-body scratching, standing, lying and sleeping without food or friendship', () => {
  const clips = new Set(COMPANION_IDLE_CLIPS.map(clip => clip.activity));
  for (const activity of ['sit', 'scratch', 'stand', 'lie', 'sleep', 'stretch']) assert.ok(clips.has(activity));
  for (let i = 0; i < COMPANION_IDLE_CLIPS.length; i++) assert.equal(nextCompanionIdle(i, 0, .1).extra, null);
  assert.equal(nextCompanionIdle(0, 100, .4).extra.activity, 'cuddle');
});

test('every activity resolves to a complete existing cel at start, end, interruptions and practice times', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/assets/companion/frames-v3/manifest.json', import.meta.url)));
  const activities = [...COMPANION_IDLE_CLIPS.map(clip => clip.activity), ...Object.keys(COMPANION_MOTION_MS), 'watch', 'happy', 'approach', 'cuddle', 'relax'];
  for (const activity of activities) for (const awkward of [false, true]) {
    for (const elapsed of [-100, ...Array.from({ length: 101 }, (_, i) => i * 40), 9000, NaN]) {
      const frame = companionFrame(activity, elapsed, 4000, awkward);
      assert.ok(manifest.sheets[frame.sheet], activity);
      assert.ok(Number.isInteger(frame.index) && frame.index >= 0 && frame.index < manifest.sheets[frame.sheet].frames);
    }
  }
});

test('idle draws different complete cels including a blink; tricks progress and return to seated artwork', () => {
  for (const activity of ['sit', ...Object.keys(COMPANION_MOTION_MS)]) {
    const frames = Array.from({ length: 101 }, (_, i) => companionFrame(activity, i * 40, 4000));
    assert.ok(new Set(frames.map(frame => frame.index)).size >= 6, activity);
    assert.ok([0, 7, 15].includes(frames.at(-1).index), activity + ' returns to sitting');
  }
  const blink = Array.from({ length: 101 }, (_, i) => companionFrame('sit', i * 40, 4000).index);
  assert.ok(blink.includes(6));
  const touch = Array.from({ length: 101 }, (_, i) => companionFrame('touch', i * 40, 4000).index);
  assert.ok(touch.every(index => index <= 5), 'reject drawings that switch the offered paw');
});

test('practice takes longer without freezing in the middle of a trick', () => {
  assert.ok(companionMotionDuration('spin', true) > companionMotionDuration('spin'));
  for (const activity of ['spin', 'touch', 'bow', 'roll', 'sleep']) {
    const duration = companionMotionDuration(activity, true);
    // Sleep intentionally rests after lying down; inspect its entry instead.
    const start = activity === 'sleep' ? .02 : .3;
    const frames = Array.from({ length: 13 }, (_, i) => companionFrame(activity, duration * (start + i / 100), duration, true));
    assert.ok(new Set(frames.map(frame => `${frame.index}:${frame.mix}`)).size > 1, activity + ' no hard practice pause');
    assert.equal(companionFrame(activity, duration, duration, true).index, companionFrame(activity, 1, 1).index);
  }
});

test('reduced motion shows a stable complete drawing throughout an action', () => {
  for (const activity of ['sit', ...Object.keys(COMPANION_MOTION_MS)]) {
    assert.deepEqual(companionFrame(activity, 100, 4000, false, true), companionFrame(activity, 3600, 4000, false, true));
  }
});

test('seated contributions remain continuous across every cut and stay opaque', () => {
  const weights = frame => {
    const result = new Map();
    for (const [index, weight] of [[frame.index, 1 - frame.mix], [frame.nextIndex, frame.mix]]) result.set(index, (result.get(index) ?? 0) + weight);
    return result;
  };
  for (const activity of ['sit', 'happy']) {
    let previous = weights(companionFrame(activity, 0, 4000));
    for (let elapsed = 1; elapsed <= 4000; elapsed++) {
      const frame = companionFrame(activity, elapsed, 4000);
      const current = weights(frame);
      assert.ok(frame.mix >= 0 && frame.mix <= 1);
      assert.ok(Math.abs([...current.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
      for (const index of new Set([...previous.keys(), ...current.keys()])) {
        assert.ok(Math.abs((current.get(index) ?? 0) - (previous.get(index) ?? 0)) < .035, `${activity}: abrupt cel cut at ${elapsed}ms`);
      }
      previous = current;
    }
  }
});

test('all five tricks soften cuts while large pose changes remain brief and fully opaque', () => {
  for (const activity of ['spin', 'touch', 'bow', 'roll', 'sleep']) {
    const duration = companionMotionDuration(activity);
    let transitionRun = 0, longestTransition = 0, transitions = 0, previous = new Map();
    for (let elapsed = 0; elapsed <= duration; elapsed++) {
      const frame = companionFrame(activity, elapsed, duration);
      const current = new Map();
      for (const [index, weight] of [[frame.index, 1 - frame.mix], [frame.nextIndex, frame.mix]]) current.set(index, (current.get(index) ?? 0) + weight);
      assert.ok(Math.abs([...current.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
      if (elapsed) for (const index of new Set([...previous.keys(), ...current.keys()])) {
        assert.ok(Math.abs((current.get(index) ?? 0) - (previous.get(index) ?? 0)) < .05, `${activity} has a hard cut at ${elapsed}ms`);
      }
      if (frame.index !== frame.nextIndex && frame.mix > 0 && frame.mix < 1) {
        transitions++; longestTransition = Math.max(longestTransition, ++transitionRun);
      } else transitionRun = 0;
      previous = current;
    }
    assert.ok(transitions > 100, activity + ' has intermediate drawings');
    assert.ok(longestTransition <= (['spin', 'roll'].includes(activity) ? 45 : 85), activity + ' avoids sustained double silhouettes');
  }
});
