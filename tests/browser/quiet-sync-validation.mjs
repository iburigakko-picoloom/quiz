// Runs after delta-bootstrap-validation has mounted the real App in a disposable
// account. All network requests go to its local PostgreSQL fixture.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function validateQuietSync(page, pg, connection, requests) {
  async function waitForState(predicate) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await page.evaluate(predicate)) return;
      await page.waitForTimeout(100);
    }
    throw new Error('Timed out waiting for persisted quiet-sync state');
  }
  const settled = async () => {
    const storage = await import('/quiz/src/storage.ts');
    const {readRecordSyncStatus} = await import('/quiz/src/utils/recordSyncStatus.ts');
    const status = await readRecordSyncStatus(await storage.openAppDb(), window.quietConnection);
    return status.phase === 'done' && !status.pending && !status.staged && !status.migrationError;
  };
  await page.evaluate(connection => { window.quietConnection = connection; }, connection);
  await waitForState(settled);
  await page.getByRole('button', {name: '設定', exact: true}).click();
  await page.getByRole('button', {name: '同期', exact: true}).click();
  await page.getByRole('heading', {name: '学習データ同期済み', exact: true}).waitFor();
  await page.evaluate(() => {
    window.quietObservations = {overlays: 0, unfinished: 0, summaries: []};
    const inspect = () => {
      const result = window.quietObservations;
      if (document.querySelector('.quiz-sync-applying')) result.overlays++;
      if (document.querySelector('.sync-progress [aria-valuenow]:not([aria-valuenow="100"])')) result.unfinished++;
      const summary = document.querySelector('.sync-status-card h2')?.textContent;
      if (summary && result.summaries.at(-1) !== summary) result.summaries.push(summary);
    };
    window.quietObserver = new MutationObserver(inspect);
    window.quietObserver.observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true});
    inspect();
  });
  const pushesBefore = requests.filter(action => action === 'push').length;
  await page.waitForTimeout(11500);
  const idle = await page.evaluate(() => window.quietObservations);
  assert.equal(requests.filter(action => action === 'push').length, pushesBefore, 'idle polling must not send data');
  assert.equal(idle.overlays, 0); assert.equal(idle.unfinished, 0);
  assert.deepEqual(idle.summaries, ['学習データ同期済み']);

  // Use the same durable save and event as user settings; let AutoSyncController
  // schedule and complete the send without manually requesting synchronization.
  await page.evaluate(async () => {
    const {withCoordinatedDataMutation} = await import('/quiz/src/utils/dataCoordination.ts');
    const {saveSyncedLocalStorage} = await import('/quiz/src/utils/localStorageRecords.ts');
    const {advanceLocalDataRevision} = await import('/quiz/src/utils/localDataRevision.ts');
    await withCoordinatedDataMutation(['app'], () => saveSyncedLocalStorage({'quizMake:quiet-sync-fixture': 'changed'}, advanceLocalDataRevision));
  });
  await waitForState(async () => {
    const db = await(await import('/quiz/src/storage.ts')).openAppDb();
    const {idbResult} = await import('/quiz/src/utils/blobVault.ts');
    const tx = db.transaction('appRecords');
    const row = await idbResult(tx.objectStore('appRecords').get('["localStorage","quizMake:quiet-sync-fixture"]'));
    return row?.serverRevision > 0 && row.raw === 'changed';
  });
  await waitForState(settled);
  assert.equal(requests.filter(action => action === 'push').length, pushesBefore + 1);
  const sent = await page.evaluate(() => window.quietObservations);
  assert.equal(sent.overlays, 0); assert.equal(sent.unfinished, 0);

  const folder = await page.evaluate(async () => (await(await import('/quiz/src/storage.ts')).loadAppDataAsync()).folders[0]);
  const payload = JSON.stringify([{operationId: randomUUID(),key: '["folders","f"]',collection: 'folders',id: 'f',
    raw: JSON.stringify({...folder, name: 'Changed on another device'}),position: 0,localRevision: 1,baseRevision: 0}]);
  const reply = (await pg.query('select public.quiz_delta_sync($1,$2,$3) result', [connection.syncId,'push',JSON.stringify({
    operationId: randomUUID(),deviceId: randomUUID(),sequence: 1,digest: createHash('sha256').update(payload).digest('hex'),parts: 1,part: 0,payload,
  })])).rows[0].result;
  assert.equal(reply.state, 'committed');
  await waitForState(async () => (await(await import('/quiz/src/storage.ts')).loadAppDataAsync()).folders[0].name === 'Changed on another device');
  await waitForState(settled);
  const applied = await page.evaluate(() => window.quietObservations.overlays);
  assert.ok(applied > 0, 'real cloud changes still use the protected apply UI');
  await page.waitForTimeout(6000);
  assert.equal(await page.evaluate(() => window.quietObservations.overlays), applied, 'finished imports must not loop');
  assert.equal(requests.filter(action => action === 'push').length, pushesBefore + 1, 'remote imports must not echo back as edits');
  await page.evaluate(() => window.quietObserver.disconnect());
  console.log(JSON.stringify({quietSync: true, idlePushes: 0, automaticPushes: 1, automaticOverlays: 0, remoteUpdateApplied: true}));
}
