# 2026-10-09 本番反映

利用者の「本番への適用、公開を行って」という承認に基づく反映。

- リポジトリ：`iburigakko-picoloom/quiz`、開始時 main：`4aaf913119b717c1a89dd64f5dd9ee2cc3f31676`。
- 配信先：<https://iburigakko-picoloom.github.io/quiz/>。既存の GitHub Pages workflow を利用する。
- DB：`xqknwsjbvczyexfxlgar`。公開中のJSから接続先を照合済み。他アプリのDB・Auth・Storage設定は変更しない。
- 対象：見つける4画面、公開処理、既存グループUI、同じ作業ツリーで検証済みの全体同期修正。既存の端末データ・クラウド原本の復旧操作は行わない。

## DB適用履歴

| 本番version | name | 元SQL |
| --- | --- | --- |
| 20261009000746 | quiz_group_folders_and_invite_preview | 20260907021448_quiz_group_folders_and_invite_preview.sql |
| 20261009000802 | group_learning_ui | 20261008142626_group_learning_ui.sql |
| 20261008151820 | resumable_publication | 20261008151820_resumable_publication.sql |
| 20261009001053 | public_discovery | 20261008172607_public_discovery.sql |
| 20261009001541 | public_discovery_reader_authorization | 同名の20261009001541マイグレーション |

長い分割公開SQLのMCP適用が requestState エラーで未適用だったため、実際のDBと履歴を照合してから認証済みCLIへ切り替えた。分割公開SQLと読み取り認可の追補SQLを、履歴の記録も含めて単一トランザクションで適用した。追補SQLは、公開フォルダ経由の閲覧認可と実取り込み人数を確実に維持する。

DDLは5秒のロック待ち上限、30秒のstatement上限を設けた。現在のmigrationフォルダを無条件に db push しない。MCPが発行したversionと元ファイル名の差分はこの表と `supabase/applied/` に記録する。

## データ保護と確認

- 反映前後とも11セット・3,506問。セット全体（追加したバイト数カラムを除く）と全問題の内容ハッシュは一致。
- グループ1件・メンバー1件・コピー履歴0件・従来同期行10件の件数を維持。
- 既存の全体公開セットから2フォルダ・11関連付けを作成。元セットの単独公開状態は維持。
- 実際の匿名REST APIで検索200、フォルダ詳細200、セット詳細200を確認。267問の既存セットを読み取り、件数一致を確認。匿名の自分の公開管理APIは拒否。
- 本番の問題本文、認証トークン、PDF、ノート本文、署名付きURLは検証ログに出していない。
- 本番のテスト公開、ユーザー作成、学習データ初期化、Storage削除、同期の強制上書きは実施しない。

## 配信確認

配信前の全テストは662件成功。隔離DBで前提SQL＋新SQLの適用順、実際の順序を再現した補正、フォルダ経由の匿名閲覧を検証した。本番と同じ `VITE_WHOLE_SYNC_ENABLED=true` 設定でビルド成功。

Webの公開はmainへのpush後、既存Actionsが npm test・build・Pages deploy を実行する。確定した配信commitは [build-info.json](https://iburigakko-picoloom.github.io/quiz/build-info.json) と [Actions](https://github.com/iburigakko-picoloom/quiz/actions/workflows/deploy.yml) で確認する。

Android/iOSストアへの提出・既存ネイティブアプリの更新は今回のWeb公開とは別。実機のキーボード・システムバー・本番アカウントでの公開／取り込み操作は引き続き確認が必要。既知の全体同期の資料参照不整合は、コード公開だけでクラウド原本を自動修復しない。
