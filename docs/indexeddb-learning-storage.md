# IndexedDB learning storage

Plans, fixed daily goals, creation notes and explanation requests use the existing
account-scoped IndexedDB `appData` store. Their verified read view, canonical
`appRecords` and `appOutbox` intent commit in one transaction. Screens use a
synchronous in-memory view hydrated before mounting; large native localStorage
copies are no longer required. Question snapshots, revisions, answer IDs and
daily goal values are unchanged. Cloud and backup wire keys remain compatible.

Migration retains each exact native original in `appDataBackups`, verifies its
readback and SHA-256, and compares both account ownership and the captured native
value before removing that individual copy. Unknown differences or corruption
stop migration while retaining both sides. A cleanup marker permits restart and
retry when native removal fails. A failed small projection cannot block an
unrelated learning save. Existing questions, answers, images, category notes and
protected work remain in their established IndexedDB stores; leftover main-data
and note fallbacks are archived before verified cleanup.

Saved legacy backups move one at a time to the existing account backup database,
including their exact serialized originals. Conflicting IDs preserve both copies;
unrecognized or damaged copies remain untouched. Unknown old temporary backup
formats are retained rather than automatically discarded. Display preferences,
Auth SDK values, sync IDs and cross-window coordination keys remain small native
values.

A local projection compatibility fence makes older record clients stop before
interpreting absent native learning values as deletions. The existing plan guard
also rejects Snapshot processing by the published older plan-aware client. Neither
guard is shared as user data. After migration, loss of IndexedDB access fails
closed, including after restart. A fresh legacy installation without IndexedDB
retains its previous explicit native fallback behavior.

Rollback must retain this IndexedDB reader and the compatibility fences. Do not
deploy a historical client that requires native plan copies or remove the account
mapping/streams as part of a frontend rollback. Original records, migration
journals, backups and unsent operations remain available for recovery. Tests cover
quota, interruptions, restart, retransmission, concurrent edits, account fencing,
large frozen targets, fixed days, backup import and published-client rejection.
