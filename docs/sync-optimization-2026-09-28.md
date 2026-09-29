# QuizMake 同期基盤の実装・検証記録

更新: 2026-09-30。DB移行とWeb公開の状態は末尾に記載する。

## 実装

- P0/P1: 保存 Revision と Dirty 判定、変更なし時の Export・Digest 省略、Immutable Payload の Digest 再利用、PDF SHA-256 と Upload の内容キャッシュ、RPC の小さい成功応答、処理回数・時間・バイト数の計測。
- P2: IndexedDB v7 の問題・問題集・フォルダ・進捗・回答履歴をレコード保存。変更レコードと Revision・直前値・Tombstone・Outbox を同一 Transaction で確定。旧 AppData JSON は復旧用に保持。ノートと同期対象 localStorage も同じ DB の Outbox に記録し、失敗後の投影を再実行可能にした。
- P3: `20260929223301_quiz_sync_record_protocol.sql` に V2 Head/Record/Operation/Change、アカウント境界、レコード CAS、Operation ID による重複排除、Push/Pull Cursor、Snapshot 相互運用を実装。端末は送信内容を凍結して応答喪失後も同じ ID で再送し、Pull は全ページ受信後に変更行と Cursor を確定する。
- P4: レコード競合を両版保存し、明示的な選択のみ CAS で適用する UI を追加。PDF は独立 Storage に先行 Upload し、端末に元本を保持する。問題画像は既存 DB を残したまま Blob と小さな同期記述子へ移行し、独立バケットへハッシュ照合後に送る。受信画像は検証済み Blob を段階保存し、レコード・画像・Pull Cursor を原子的に確定。画像の所有者パスと参照を検査する。
- P5: 回答 Pull の既存スナップショット・正規化済み AppData を commit ID で再利用し、変更した進捗と履歴だけを検証。未変更の問題一覧の JSON 解析・全体正規化を省略した。Outbox は対象キーだけを読み、画像・ノートなどの Store は対象変更がある時だけ開く。未 Upload の画像・inline PDF を含む凍結バッチは送信を停止する。Pull の読込・準備・確定時間を個別に記録する。回答の送受信は各 2 レコード・送信要求 806 文字。圧縮、Realtime、Web Worker は実測上の通常 Pull には不要と判断し、依存追加していない。

## 計測・テスト

- Node/Vite SSR、MemoryStorage、合成 1 万件: 初回 Export+Digest 241.37 ms。以後 100 回の未変更検査 6.63 ms、追加 Export/Digest/Hash は 0 回。
- fake-indexeddb、合成 1 万問: 1 回答は進捗と履歴の 2 レコード・395 文字を書き込み。実行ごとの保存時間は約 32–111 ms。実ブラウザ・実通信時間を含まない。
- 25 MiB PDF の同期準備 2 回で SHA-256 計算 1 回、Upload 1 回。HEAD 検査は毎回行う。
- 2 端末 + PGlite の結合テスト: 1 回答の Upload/Download 各 2 レコード、Push 要求 806 文字。
- 実ブラウザ IndexedDB、合成 1 万問/5 万問、回答 1 件（進捗と履歴の 2 行）の Pull: 最終測定 108.3/342.1 ms。最初の測定は 173.8/808.1 ms。最終測定の読込 4.1/5.1 ms、準備 5.9/27.4 ms、IndexedDB 確定 97.5/309.6 ms。PerformanceObserver の 50 ms 超 Long Task は最終測定で 0 件（最初の測定は 93/557 ms を各 1 件）。初期レコード投入は 6.8/29.4 秒で、継続評価が必要。端末性能・保存状態で変動する単発測定。
- `npm test`: 279 件成功。旧形式SnapshotのV2非起動、移行失敗、容量不足、強制終了、応答消失、通信断、同時書込、競合、画像欠落時の Cursor 停止、認証境界、回答の破損・Tombstone を含む。`npm run build` と `git diff --check` 成功。公開候補だけを含む分離コピーでも291件とビルドが成功。

## 配布・未検証

- 共用 Supabase `xqknwsjbvczyexfxlgar` にQuiz専用のMigration `20260929223301_quiz_sync_record_protocol` と `20260929223355_quiz_question_images` を適用。既存Snapshot8件は維持され、V2 Headは未作成。新規4テーブルのRLSとRPCの匿名実行不可、非公開画像バケットと所有者ポリシーを確認。対応するローカルSQLファイル名を実際のMigration履歴に合わせた。
- 認証済みテストアカウントが利用できず、実 Supabase のHTTP経由双方向・ストレージ検証は未実施。実在ユーザーIDを模擬JWTに使う検証は自動承認審査で拒否されたため再試行しない。GitHub Pages への配布は、認証済み検証が終わるまで保留。実ブラウザの複数タブ・容量不足・強制終了、実端末の移行検証、初回巨大Snapshot、長期Operation/Change履歴の容量管理は追加評価が必要。
