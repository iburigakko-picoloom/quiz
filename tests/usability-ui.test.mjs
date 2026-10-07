import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const syncSource = readSource('../src/screens/SyncScreen.tsx');

test('manual sync preserves backups and checks the remote revision before replacement', () => {
  const comparisonSource = readSource('../src/components/SyncComparison.tsx');
  assert.match(syncSource, /<SyncComparison/);
  assert.match(comparisonSource, /saveBackupPayload\(local,'before-sync'\)/);
  assert.match(comparisonSource, /saveBackupPayload\(remote.value.payload,'before-sync', 'クラウド'\)/);
  assert.match(comparisonSource, /remote.value\?\.updatedAt !== pending.remote\?\.updatedAt/);
  assert.match(syncSource, /setStoredSyncId\(''\)/);
  assert.match(syncSource, /getPendingLegacySyncUpgrade\(\)/);
  assert.match(syncSource, /resumePendingLegacySyncUpgrade\(\)/);
});

test('sync id edits stay as a draft until the user explicitly connects', () => {
  const draftHandler = syncSource.match(/const updateSyncIdDraft = \(value: string\) => \{([\s\S]*?)\n  \};/);
  assert.ok(draftHandler, 'draft handler should exist');
  assert.match(draftHandler[1], /setSyncId\(value\)/);
  assert.doesNotMatch(draftHandler[1], /setStoredSyncId/);
  assert.match(syncSource, /const applyConnectedSyncId[\s\S]*?setStoredSyncId\(normalizedNextId\)/);
  assert.match(syncSource, /if \(!autoEnabled && \(!configured \|\| !syncIdConnected\)\)/);
  assert.match(syncSource, /disabled=\{!autoEnabled && \(!configured \|\| !authenticated \|\| !syncIdConnected \|\| wholeSyncMigrationNeeded\)\}/);
  assert.match(syncSource, /sendMagicLink\(normalizedEmail, \{ name: 'sync' \}\)/);
});

test('legacy upgrade reconciliation never overwrites a connection changed by another tab', () => {
  const legacyHandler = syncSource.match(/const handleUpgradeLegacySyncId = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(legacyHandler, 'legacy upgrade handler should exist');
  assert.match(legacyHandler[1], /getStoredSyncId\(\)\.trim\(\) !== result\.value\.syncId/);
  assert.match(legacyHandler[1], /setLastSyncStateForConnection\(result\.value\.syncId/);
  assert.doesNotMatch(legacyHandler[1], /setStoredSyncId\(result\.value\.syncId\)/);
});
