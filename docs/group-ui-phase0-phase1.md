# Quiz Make: Phase 0 調査・Phase 1 実装

基準: `iburigakko-picoloom/quiz` main `9e8f7f3dce480b5e255ad0d2e7d8791275ec0bfb`（2026-11-07取得）。
元の作業ディレクトリは別originかつ多数の未コミット変更があったため、`phase1-work`に独立cloneして実装した。元の変更は編集していない。

## 状態

| Phase | 状態 |
| --- | --- |
| 0 | 指定画面、関連する保存処理・hooks・RPC・migration・testsの調査を実施。以下はコードから確認した内容であり、本番データの監査ではない。 |
| 1 | 実装・ローカルビルド・自動回帰検証済み。本番migration適用、実ユーザー間の検証、Android実機確認は未実施。 |
| 2 | 未実装。4タブの枠と共通詳細への入口のみ。活動投稿は準備中と明示。 |
| 3–6 | 未実装。依存関係と後続作業を整理。 |

## Phase 0: 現状と再利用

- `CommunityScreen.tsx`: グループ一覧、参加、設定、招待、権限、教材公開・解除、取り込み確認、フォルダ一括取り込みを保持。既存の`directSet`取得と`LibraryPane`を共通詳細の遷移に使用。
- `GroupWorkspace.tsx`: 従来は概要・フォルダ・メンバーの3タブ。概要にグループ合計とランキングがあった。フォルダツリーは`buildGroupLibrary`、フォルダ単位取り込みは`groupFolderSets`をそのまま使用。
- `SharedSetDetail.tsx`: 説明、添付PDF情報、問題プレビュー、取り込み、共有元を開く、報告を再利用。進捗用の任意ReactNodeを廃止し、役割を分離。
- `GroupProgress.tsx`: consent generation、公開版、選択したローカルコピーに紐づく既存RPCを再利用。従来は閲覧時に同意を作成していた。公開処理の`usePublicationQueue`にも自動同意があったため、両方とも新規同意は作らず明示ON操作に統一。既存のON/OFFは書き換えない。
- `groupStudySource` / `groupLearning` / `groupProgress`: immutable publication manifest、質問revision、logical IDで集計対象を照合。取り込み後の編集、削除、重複、公開版の違いを検出する既存実装を再利用。回答率はユニークな回答済み問題数÷公開版問題数。今日・今週は延べ解答回数で、日本時間・月曜開始。正答率・復習対象数はグループ集計に含まれないので追加表示しない。
- `GroupLearningUi.tsx`: Level 0–3、アバター、反映日時、空状態を再利用。新しいデザイン体系は導入しない。
- `useGroupLearning`: 日付切替、更新イベント、アカウント別の応答破棄を再利用。グループ基本情報と教材別一括集計を2 RPCで取得。教材ごとのRPCループは実装しない。
- `CreateProblemSetScreen.tsx`: 現状はAI、メモ、手入力、まとめ貼り付け、JSON、追加解説を列挙。AIのsimple/material/past-exam、依頼文とJSONの2段階、保存前確認、編集・複数正解処理がある。Phase 3では入口を整理し、この保存経路を維持できる。
- `MaterialsPanel.tsx` / `MaterialsDrawer.tsx`: materialId/pageId、PDFページ番号、背景プレビュー、隣接ページ読み込み、ページ移動前の手書きflush、参照ダイアログを保持。Phase 4は一覧/検索/関連問題をこの安定したIDと保存境界に接続する。画像PDFとテキストPDFを区別する検索索引は別途必要。
- `AccountSyncScreen.tsx` / `SyncScreen.tsx`: アカウント保存先確認、旧保存先の復旧、同期保護、競合比較、バックアップへの導線がある。delta/record/whole syncとblob保存・参照整合性が関係するため、Phase 5でUIだけ端末役割を追加しない。
- LINE: `cloudService`はカスタムOIDC providerとopenid/profile scopeを使用。`lineAvatar`はidentity_dataのpicture/avatar_urlのHTTPS URLを確認し、欠落時は既存アイコンへ戻す。表示名は`quiz_profiles.display_name`を別取得。`AccountSyncScreen`はemailか一般表示、`GroupLearningUi`は既定アバターであり、プロフィールの統一はまだされていない。実LINEアカウントでの属性取得・優先順位検証はPhase 6。
- `CompanionCareScreen.tsx`: feed/pet/tricks、学習後の報酬、芸の練習でのおやつ消費、アニメーション連鎖がある。所持数は`companionCare`/storageの管理下。「おかしが被っている」の再現・原因は未特定。報酬や所持数を推測で変更していない。

## Phase 1: 変更内容

1. タイムライン → フォルダ → メンバー → 概要の4タブ。初期表示は概要。キーボード左右/Home/Endにも対応。
2. 概要に教材カード、自分の回答済み数・回答率・Level、共有中人数、全体回答率・Level、自分の反映状態を表示。
3. 全体集計は共有中かつ現在の公開版に一致するメンバーのみ。未共有者の学習統計はメンバー画面から除外し、管理者のメンバー管理は残す。
4. 共通進捗詳細は教材名・所属グループ、対象切替、回答率、Level、今日/今週、メンバー、共有設定の順。取り込みボタンを置かない。
5. フォルダの詳細は取り込み専用で、進捗RPCや共有同意を発生させない。
6. 概要/タイムラインのタブ状態を保持して戻る。`screenBack`をアプリ既存のブラウザ戻る/ネイティブ戻る経路に組み込み、ダイアログを先に閉じる順序を維持。フォルダ階層も1段ずつ戻る。
7. 読み取り失敗時は古い共有集計を破棄。公開版不一致は開き直しを案内。巨大な共有元でローカルmanifestを保持していない場合、概要で数値を捏造せず詳細の単一取得で正確に計算する。

## DB・公開手順

追加: `20261107150053_group_material_progress.sql`

- `quiz_private.group_material_progress(uuid)`: private集計表を読むため既存方式のsecurity definerを使用。空search_path、auth.uidと現メンバー確認、現グループ教材relation、同意enabled、generation、version、現メンバーの照合を必須とする。
- `public.quiz_group_material_progress(uuid)`: security invokerの公開ラッパー。PUBLIC/anonの実行権限を剥奪、authenticatedのみに許可。
- 新しいテーブル、カラム、保存形式、破壊的変更はない。既存private表のRLS・直接アクセス禁止を変更しない。group_id先頭の既存複合主キーを利用。
- 一括集計は教材単位。メンバーID一覧を返さず、自分の同意状態だけ返す。日/週が古い行を0扱いせず、不完全な期間集計はnull。

デプロイはDB migration → RPCの認証/同意/退出テスト → アプリの順。今回、本番には適用していない。新アプリを旧DBに先行配信すると集計取得エラーになる。既存アプリは追加RPCを使わないため互換性を維持する。ロールバックはアプリを前版へ戻し、追加RPCを残してよい。保存データの変換・再取り込みは不要。

既に保存されている同意は維持する。過去に自動で作られたONと明示ONを判別する履歴はないため、既存ONを一括解除していない。Phase 2の活動共有は進捗同意を転用せず別の明示同意が必要。

## 検証

- `npm ci --no-audit --no-fund`: lockfileに従って独立cloneに導入。
- `npm run build`: 成功（初回はcloneの依存関係不足でPDF asset読込失敗。npm ci後に解消）。
- `npm test`: 847件成功、失敗0件。
- `tests/group-learning-rls.test.mjs`: PGliteで実SQL実行。匿名/グループ外の拒否、共有OFF、同意generation、古い公開版、日/週の古さ、退出、教材解除、保存済み集計の非変更を検証。
- `tests/browser/group-phase1-validation.mjs`: 実CommunityScreenと隔離RPCを使用。4タブ、初期概要、一定RPC回数、詳細の分離、未同意OFF、非共有者非表示、両入口への戻り、アプリ共通戻るハンドラ、390/768px幅を検証。スクリーンショットを目視確認。
- `tests/browser/group-community-validation.mjs`: 既存シナリオを新導線へ更新。アイコン/空フォルダ/配置、一括取り込み、公開再送/中断復帰、共有元から明示ON/OFF、フォルダ管理と権限、320/390/768px幅、Full Appで学習保存後の反映を検証。
- ブラウザテストはモックRPCであり本番Supabase/LINEを使わない。PGliteはPostgreSQL互換テストで、本番の性能試験・advisorsの代替ではない。Android実機のOS戻るは未実施。

## Phase 2以降の依存関係

- Phase 2: 本PRの共通詳細と戻り先を再利用。活動セッションID、永続outbox、再送用一意キー、最小payload（問題内容なし）、別同意、退出/公開解除/同意OFF時の失効をDB/RLSと同時設計。既存の累積progress summaryを活動投稿に変換しない。実データでグループ間隔離と重複防止を検証後にタイムラインの準備中表示を置換。
- Phase 3: Phase 2のDBとは独立して作業可能。MethodChooserと下位メニュー、AI条件の段階表示を変更。保存前確認・編集・メモ・一括貼付け・コピーの回帰を維持。PDF登録は取り込み後の資料管理と分離。
- Phase 4: Phase 3とMaterialsの同一ファイル編集を分ける。資料一覧、関連問題索引、PDFテキスト抽出/画像判定を追加し、ページ移動/リンク追従時のflush失敗、手書き保持、ページID整合性を検証。
- Phase 5: blob/参照/backupの仕様調査を先行。サブ端末が持たないファイルと本当の削除を区別し、メイン変更、競合、全量復旧、バックアップを含むテスト後にUIへ反映する。
- Phase 6: LINEプロフィール統合はアカウント保存先/既存ユーザー設定を上書きしない優先順位の決定が必要。キャラクターは重複の再現例を確認して表示/名称/機能を分けて診断。保存処理への変更は原因が特定された場合に限定。
