# 資料機能

## 操作

- 問題セットの「資料」からPDF（50MB以下、500ページ以下）を登録。白紙だけの資料も作成可能。
- 上部は資料選択・ページ送り・「•••」・閉じるの1列。「•••」でPDF追加、白紙の前後挿入、ページの移動。
- 下部はペン、消しゴム、元に戻す、薄い黄色／緑／青のマーカー。マーカーは1ストロークをまとめて描き、途中が不自然に濃くなるのを防ぐ。
- ペン／マウスで書き込み、指で移動・ピンチ。倍率は100〜250%。範囲外は抵抗をつけて戻す。
- 「資料から作る」で登録済み資料を選択して依頼文をコピーし、同じPDFをAIに添付する。JSON取込後、演習画面の「参照資料」で対象ページを開く。
- 768px以上は問題と資料を左右表示。それ未満は資料と問題を切替。旧手書きノートはデータを変換・削除せず、そのまま開く。

## データ

AppData.version は1のまま。Question / ImportedQuestion / BulkQuestionDraft に任意の `materialReferences: { materialId: string; pageId: string }[]` を追加。従来の sourcePage は維持。

既存のノート用IndexedDBと保存・バックアップ・同期の保護処理を再利用する。端末・JSONバックアップはPDF本体を含む従来形式を維持。

|キー（quizMake:notes:SET_ID: 以下）|内容|
|---|---|
|`__materials_v1`|kind=quiz-material-index、version=1、資料ID、タイトル、順序付きページ配列|
|`__material_pdf_MATERIAL_ID`|kind=quiz-material-file、PDF本体のdata URL|
|`__material_ink_MATERIAL_ID_PAGE_ID`|既存の手書きノート形式、透明PNGの書き込みだけ|

ページは `{ id, kind: 'pdf' | 'blank', pdfPage?: number }`。pdfPageは元PDF内の1始まりページ番号で、並べ替えでは変更しない。IDは挿入・移動で再生成しない。PDFを手書き画像に焼き込まない。将来の疾患MAPからも問題ID／資料ID／ページIDを参照できる。

クラウド送信時だけPDFレコードを `kind: quiz-material-remote-file, version: 1, materialId, updatedAt, bucket, path, sha256, size` に変換する。非公開バケット `quiz-material-pdfs` の `USER_ID/SHA256.pdf` にTUS分割アップロードし、同一内容は再送しない。すべてのPDFの保存後、従来の競合・端末更新チェックを通して同期JSONを保存。受信時は所有者・サイズ・SHA-256を検証してPDF本体を復元し、全件成功した場合のみ既存の保護付き取込へ渡す。旧インラインPDF形式も読める。変更のないPDFは再送しないが、受信時は完全性の確認のため取得する。

参照は同じ端末の別セットに登録された資料にも解決する。資料を所有する元セットを削除すると、その資料を参照する別セットからも開けなくなる。見つからない参照は別ページへ推測移動せずエラーを表示する。

## 変更ファイル

- 画面: `src/App.tsx`, `src/screens/NoteListScreen.tsx`, `NoteOverviewScreen.tsx`, `ProblemSetDetailScreen.tsx`, `QuizRunner.tsx`, `CreateProblemSetScreen.tsx`
- コンポーネント: `src/components/MaterialsPanel.tsx`, `MaterialsPanel.css`, `MaterialsDrawer.tsx`, `CategoryNoteDrawer.tsx`, `CategoryNoteDrawer.css`
- 保存・形式: `src/types.ts`, `src/utils/materialModel.ts`, `materialStorage.ts`, `materialCloud.ts`, `syncService.ts`, `cloudService.ts`, `pdfReader.ts`, `noteStorage.ts`, `appDataValidation.ts`, `bulkQuestionParser.ts`, `importValidator.ts`
- 非公開ストレージ: `supabase/migrations/20260919153531_quiz_private_material_pdfs.sql`（本番の適用済みバージョンと一致）。既存の同期テーブル・保存データは変更しない。
- ビルド: `package.json`, `package-lock.json`, `tsconfig.app.json`, `vite.config.ts`
- 関連テスト: `tests/note-exit-flush.test.mjs`, `tests/problem-set-creation.test.mjs`, `tests/sync-rpc.test.mjs`, `tests/usability-ui.test.mjs`（今回の768px境界変更だけ）
- 説明: `docs/materials.md`, `src/screens/PrivacyScreen.tsx`

## 確認と制限

- 問題JSONの参照取込・不正ID拒否、白紙挿入／移動による参照維持を既存テストに追加。
- ローカルの独立ブラウザでPDF描画、透明手書き保存・再読込、参照ジャンプ、2ペイン、スマホ切替、回答パネルの幅維持を確認。
- PDF.jsのworker・CMap・標準フォント・画像デコーダーを同梱。PDFを外部の変換サービスには送らない。
- 問題・手書き・設定などの同期JSONは8MBまで。PDFはその枠外、1ファイル50MBまで。現在のSupabase組織はFreeで、Storage無料枠は組織全体1GB（他アプリ・他ユーザーと共有）。有料プラン変更なし。
- PDFは端末では互換性のためbase64保存。端末空き容量とメモリに依存する。PDF全ページの一括画像化は行わず、表示中のPDFだけを再利用する。
- 古い同期情報の参照切れを避け、未参照PDFの自動削除はしない。アプリのアカウント削除時にStorage APIで削除する。容量表示・未使用原本の個別整理UIは今後の課題。
- 7MBのPDFデータ分離・復元・再送抑止・所有者違い・破損拒否をテスト。5MBのPDFを独立ブラウザで登録し、マーカーの保存・再表示、白紙挿入、320/390/768/1024pxの上部1列・横切れなしを確認。実ユーザーのクラウドデータを使う同期実験は行っていない。
- 本番バケットで所有者の読取と他ユーザーの読取／書込拒否をSQLトランザクションで確認（ロールバック済み）。Supabaseスキルに沿ってRLSを所有者限定・上書き不可とし、セキュリティ診断も実行。既存の共用プロジェクト側にsearch_path・公開RPCなどの警告があり、他アプリの権限は変更していない。[診断の説明](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)。
- 公開／グループ共有にはPDF本体を含めない。質問JSONには参照情報を持てるが、JSONだけを別端末へ移してもPDF本体は復元されない。
- パスワード付きPDF、PDFへの書き込みを統合した書出し、PDF以外の資料登録、指1本での描画、実機iPad/Pencilでの検証は未対応／未実施。
- 既存依存関係のnpm audit指摘（開発用のxmldom等）は本変更で一括更新していない。追加したPDF.jsへの指摘はなかった。
