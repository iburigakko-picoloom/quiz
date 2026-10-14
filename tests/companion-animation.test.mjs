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

test('practice hesitates using the same drawings and lasts longer, without deforming anatomy', () => {
  assert.ok(companionMotionDuration('spin', true) > companionMotionDuration('spin'));
  assert.deepEqual(companionFrame('spin', 1250, 4000, true), companionFrame('spin', 1600, 4000, true));
  assert.notDeepEqual(companionFrame('spin', 1600, 4000, true), companionFrame('spin', 1600, 4000));
});

test('reduced motion shows a stable complete drawing throughout an action', () => {
  for (const activity of ['sit', ...Object.keys(COMPANION_MOTION_MS)]) {
    assert.deepEqual(companionFrame(activity, 100, 4000, false, true), companionFrame(activity, 3600, 4000, false, true));
  }
});
