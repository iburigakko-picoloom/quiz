# LINEと簡単な問題集作成（2026-09-08）

## LINE
- ブラウザ/PWAの設定・同期の未ログイン画面から `custom:line` でログイン。
- チャネルシークレットはSupabase管理画面のみに入力。ソースやVITE環境変数へ入れない。
- LINEのコールバックはSupabase管理画面に表示されたURLを登録。
- クライアントIDとシークレットは必ず同じチャネルのものを使用。
- 管理画面の旧Client IDは2011442315、新チャネルは2011510017。更新はまだ未確定。既存利用者のID・データが引き継がれるか確認してから切り替える。
- 既存メールログインとの自動データ統合はしない。別アカウント扱いになることがある。
- ネイティブアプリのLINE SDK連携は未実装。メールログインを維持。
- LINE実ログイン、キャンセル、ログイン後の同期を実機確認するまで導入完了とはしない。

## 問題作成
「JSONを貼り付ける」の「作りたい問題集」へ短い依頼を入力 → 依頼文をコピー → ChatGPT等で生成 → JSONを貼り付けて読み取り・保存。APIによる自動生成ではない。

追加フィールドは `distractors?: string[]` と `shuffleChoices?: boolean`。既存JSONは互換維持。
- 誤答候補最大50個。既存choicesの誤答と合わせて重複・正解一致を除き、必要数を抽選する。
- 正解はすべて保持。表示数は元の4択/5択を維持。
- セッションの問題表示時に一度抽選し、再描画・解説操作では並びを変えない。
- 採点は表示用の正解indexで行い、結果画面は同じ問題スナップショットを使う。
- answerLogs.presentedChoicesに当時の表示順を保存。
- 保存・編集・端末間同期・バックアップで候補を維持。既存問題は明示設定がなければ変更しない。
- 公開/グループ共有のDB形式は未拡張。候補を黙って捨てないため、ランダム問題の公開共有は明示エラーで止める。

確認: `npm run test:choices`, `npm test`, `npm run build`。

資料: https://supabase.com/docs/guides/auth/custom-oauth-providers 、https://developers.line.biz/en/docs/line-login/integrate-line-login/
