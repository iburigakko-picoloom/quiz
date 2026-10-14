import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve(process.env.QUIZMAKE_PLAYWRIGHT_MODULE, 'index.mjs')).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const origin = process.env.QUIZMAKE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5188/quiz';
const screenshotDirectory = `tmp/companion-care-screenshots/${Date.now()}`;
await mkdir(screenshotDirectory, { recursive: true });
const errors = [];
async function page(answers) {
  const target = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  target.setDefaultTimeout(15_000);
  target.on('pageerror', error => errors.push(error.message));
  await target.route('https://**/*', route => route.abort());
  await target.goto(`${origin}/tests/browser/companion-care-preview.html?answers=${answers}`);
  await target.getByRole('button', { name: 'パピィのお世話をする' }).waitFor();
  return target;
}
const readCare = target => target.evaluate(async () => (await import('/quiz/src/utils/companionCareStorage.ts')).readCompanionCare());
try {
  const study = await page(19);
  await study.screenshot({ path: `${screenshotDirectory}/home-390.png` });
  assert.equal((await readCare(study)).food, 0);
  await study.locator('.quiz-home__folder-main').click();
  await study.getByText('確認クイズ', { exact: true }).click();
  await study.getByRole('button', { name: '登録順で解く' }).click();
  await study.getByRole('button', { name: /不正解/ }).click();
  await study.getByRole('button', { name: '解答する', exact: true }).click();
  await study.getByRole('button', { name: '結果へ', exact: true }).click();
  await study.getByText('ごはんを1個獲得！', { exact: true }).waitFor();
  assert.equal((await readCare(study)).food, 1);
  await study.screenshot({ path: `${screenshotDirectory}/result-390.png` });
  await study.getByRole('button', { name: 'お世話へ ›' }).click();
  await study.getByRole('button', { name: 'ごはんを1個あげる' }).click();
  await study.getByText('おいしそうに食べている。 なかよし度 +4', { exact: true }).waitFor();
  assert.equal((await readCare(study)).friendship, 4);
  await study.getByRole('button', { name: '戻る', exact: true }).click();
  await study.getByText('ごはんを1個獲得！', { exact: true }).waitFor();
  assert.equal((await readCare(study)).food, 0, 'reopening results cannot claim again');

  // A new review record also earns food; the same question is eligible repeatedly.
  await study.getByRole('button', { name: '間違えた1問を解く' }).click();
  await study.locator('.quiz-choice').filter({ has: study.locator('.quiz-choice__text', { hasText: /^正解$/ }) }).click();
  await study.getByRole('button', { name: '解答する', exact: true }).click();
  await study.getByRole('button', { name: '結果へ', exact: true }).click();
  await study.getByText('次のごはんへ、一歩前進', { exact: true }).waitFor();
  assert.equal((await readCare(study)).answerRemainder, 1);
  const retained = await readCare(study);
  await study.evaluate(async () => (await import('/quiz/src/utils/studyCompanion.ts')).setStudyCompanionEnabled(false));
  await study.locator('.companion-reward').waitFor({ state: 'hidden' });
  assert.deepEqual(await readCare(study), retained, 'disabling the character hides rewards without deleting progress');

  const care = await page(160);
  await care.getByRole('button', { name: 'パピィのお世話をする' }).click();
  await care.getByRole('button', { name: 'ごはんを1個あげる' }).waitFor();
  for (const width of [320, 390, 768]) {
    await care.setViewportSize({ width, height: 844 });
    assert.equal(await care.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await care.screenshot({ path: `${screenshotDirectory}/care-feed-${width}.png` });
  }
  await care.setViewportSize({ width: 390, height: 844 });
  await care.getByRole('tab', { name: 'なでる' }).click();
  for (let i = 0; i < 4; i++) {
    const action = care.getByRole('button', { name: 'やさしくなでる' });
    await action.click();
    await action.waitFor({ state: 'visible' });
    await care.waitForFunction(() => !document.querySelector('.companion-care__primary')?.disabled);
  }
  assert.equal((await readCare(care)).friendship, 1.5); assert.equal((await readCare(care)).rewardedPets, 3);
  await care.getByRole('tab', { name: '芸' }).click();
  assert.equal(await care.getByRole('button', { name: /くるりんを教える/ }).isEnabled(), true);
  await care.getByRole('button', { name: /おやすみ.*なかよし度/ }).click();
  assert.equal(await care.getByRole('button', { name: 'なかよし度 58で教えられるよ' }).isEnabled(), false);
  await care.getByRole('button', { name: /くるりん.*0 \/ 5回/ }).click();
  for (let i = 0; i < 5; i++) {
    await care.getByRole('button', { name: /くるりんを教える/ }).click();
    await care.waitForFunction(() => !document.querySelector('.companion-care__primary')?.disabled);
  }
  const learned = await readCare(care);
  assert.equal(learned.tricks.spin, 5); assert.equal(learned.food, 3);
  await care.screenshot({ path: `${screenshotDirectory}/care-tricks-390.png` });
  await care.getByRole('button', { name: 'くるりんをお願い（ごはん不要）' }).click();
  await care.waitForFunction(() => !document.querySelector('.companion-care__primary')?.disabled);
  assert.equal((await readCare(care)).food, 3);
  await care.getByRole('button', { name: 'キャラの名前を変更' }).click();
  await care.getByRole('textbox', { name: 'キャラの名前' }).fill('ぽん');
  await care.getByRole('button', { name: '保存', exact: true }).click();
  await care.reload();
  await care.getByRole('button', { name: 'ぽんのお世話をする' }).click();
  assert.equal((await readCare(care)).tricks.spin, 5); assert.equal((await readCare(care)).food, 3);
  assert.deepEqual(errors, []);
  console.log('Companion browser passed: full App navigation, incorrect/repeated answers, automatic reward/reopen, feed, daily pet cap, trick unlock/practice/free requests, reload, character display preference, 320/390/768px layout. Screenshots: ' + screenshotDirectory);
} finally { await browser.close(); }
