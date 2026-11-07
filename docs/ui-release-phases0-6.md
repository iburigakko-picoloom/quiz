# UI・機能改善 統合リリース

対象: `iburigakko-picoloom/quiz`。main基準 `9e8f7f3`。個別Phaseの変更をmerge commitで統合し、履歴とレビュー単位を保持する。

## 変更範囲

| Phase | 実装 | 詳細 |
| --- | --- | --- |
| 0/1 | 現行調査、4タブ、概要初期表示、教材進捗詳細、取り込みとの分離、一括集計 | `group-ui-phase0-phase1.md` |
| 2 | 明示同意のセッション活動、アカウント別再送、失効・重複防止 | `group-timeline-phase2.md` |
| 3 | 作成/とりこみ、AI方式の段階表示、既存下位機能保持 | `creation-phase3.md` |
| 4 | 左資料一覧、登録資料/PDF検索、関連問題、参照ページ往復 | `materials-phase4.md` |
| 5 | 端末ごとのmain/sub、編集保護、同期受信・復旧保持 | `device-roles-phase5.md` |
| 6 | LINEプロフィール統一、回答数を共用するご飯/おやつ | `account-companion-phase6.md` |

変更ファイルは各PhaseのPRのFiles changedと上記資料に記録。元の作業ディレクトリにある未コミット変更は含めず、分離したcloneで実装した。

## DBと配信

1. `20261107150053_group_material_progress.sql`: 教材ごとの一括進捗読み取りRPC。
2. `20261107150102_group_session_timeline.sql`: private活動/同意テーブル、4種類の公開RPC、失効trigger、既存コピー記録RPCのグループ教材認可。
3. 権限と動作を確認後、アプリをGitHub Pagesへ配信。

本番アプリの接続先と既存schemaを照合する。Quizと同居する別アプリのテーブル・Auth設定・キーは変更しない。新規テーブルはRLS有効・直接アクセス不可。公開RPCは認証済み利用者のみで、内部処理が現在のグループ所属・同意・教材公開版を確認する。

PDF・画像は今回も同期対象として保持する。削減だけを先行すると参照・削除履歴・復旧を壊すため、除外は行わない。端末の役割は操作設定で、全端末の中で唯一のメインを強制するものではない。

## 検証記録

最終結果は末尾の検証記録と統合PRに記載。

## 確認範囲と制限

- 自動テストとChromeの隔離fixtureで確認。実Android/iOSのハードウェアとLINE本番OAuthログインは未確認。
- Androidと共通の戻る処理、実Appのhistory/popstateによる元タブへの復帰はブラウザで確認済み。
- 画像PDFのOCRは対象外。抽出不能と検索結果なしを区別する。
- 終了処理前にブラウザを強制終了した活動は投稿されない場合がある。保存済み回答は保持する。
- 育成v4への移行前に獲得済みのアイテムは別在庫として保持。移行後に解いた問題数はご飯50問分・おやつ25問分の共通残高となる。
- 育成v4を読み込めない旧アプリへ単純に巻き戻さない。利用する全端末を更新し、復旧は新しい版のバックアップ・競合復旧画面から行う。

## 最終検証・本番DB記録（2026-11-08 JST）

- 全`npm test`: 877件成功、失敗0。
- `npm run build`: 成功。既存のchunkサイズ・dynamic import警告あり。
- 配信対象の追加復旧テスト: 7ファイル24件成功。Windowsの改行による既存SQLテストの不一致は、テスト読み込みのみLF正規化して解消。
- 実Chrome: グループ/活動保存/端末役割/作成/資料検索/資料管理/プロフィール/育成の8本成功。スマホ320/390px、タブレット768px、資料画面1280pxを確認。
- 2端末Chrome+PGlite: 500MiB PDF保持、10回答受信、応答喪失後の11件目再送、重複0、13分割の途中から再開、役割変更後データ不変。
- 本番DBへ上記2migrationを適用。ファイル名は本番が発行したversionへ整合し、SQL本文は変更していない。
- 本番SQL確認: RLS有効、anon/authenticatedとも新規テーブルの直接操作不可。公開6RPCはsecurity invoker、anon実行不可・authenticated実行可。グループ外の合成IDで進捗/活動読み取りが拒否されることをrollbackトランザクションで確認。
- セキュリティadvisory: 新規WARN/ERRORなし。privateテーブル2件の「RLS有効・policyなし」は、直接アクセスを剥奪し認可RPC経由に限定する設計上のINFO。既存の共有backendの警告は今回の対象外として維持。

GitHub Pagesの配信結果・commit・公開確認は[統合PR #31](https://github.com/iburigakko-picoloom/quiz/pull/31)へ記録する。

## レビュー単位と主な変更ファイル

| Phase | 主な変更ファイルと役割 | PR |
| --- | --- | --- |
| 0/1 | CommunityScreen、GroupWorkspace、GroupProgress、SharedSetDetail、GroupLearningUi、groupLearningService、screenBack、一括RPC | [#24](https://github.com/iburigakko-picoloom/quiz/pull/24) |
| 2 | GroupTimeline、groupActivity/outbox/service、App、QuizRunner、QuizScreen、cloudService、活動migration | [#28](https://github.com/iburigakko-picoloom/quiz/pull/28) |
| 3 | CreateProblemSetScreen、作成画面CSS、AI手順と既存取り込み導線 | [#26](https://github.com/iburigakko-picoloom/quiz/pull/26) |
| 4 | MaterialsPanel/Drawer、MaterialNavigator、materialSearch、NoteListScreen | [#27](https://github.com/iburigakko-picoloom/quiz/pull/27) |
| 5 | deviceRole/runtime、useDeviceRole、App、AccountSyncScreen、保存guard、Home/Folder/ProblemSetDetail/QuizRunner、navigation | [#29](https://github.com/iburigakko-picoloom/quiz/pull/29) |
| 6 | accountProfile、cloudService、SettingsScreen、AccountSyncScreen、GroupLearningUi | [#25](https://github.com/iburigakko-picoloom/quiz/pull/25) |
| 6育成 | companionCare/storage、CompanionCareScreen、ResultScreen、CompanionBudgetRecovery、deltaSync、wholeSyncEngine、backupPayload、RecordConflictRecovery | [#30](https://github.com/iburigakko-picoloom/quiz/pull/30) |

全ファイル・テスト差分は[統合PRのFiles changed](https://github.com/iburigakko-picoloom/quiz/pull/31/files)を参照。Phase 0〜6の実装は完了。未実施の実機・本番LINE認証は上記制限のとおりで、確認済みとは扱わない。
`RLS有効・policyなし` の説明: [Supabase database linter](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)。新規privateテーブルへの直接権限は付与しない。
