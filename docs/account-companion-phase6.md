# Phase 6: アカウント・育成

基準: Phase 1 b58ae49。既存データの変換やDB migrationはない。

## 名前・アイコン

`accountProfile.resolveAccountProfile`に表示の優先順位を集約した。

1. `quiz_profiles.display_name`の既存設定（既定文字列であっても上書きしない）。
2. 設定が空の場合のみ、設定済みLINE providerのidentity_dataのname/display_name/full_name。
3. 従来のemail先頭部分、取得できなければ「Quiz Make ユーザー」。

`cloudService.getCloudAccountProfile`はSupabase `auth.getUser()`で現利用者を確認し、本人のプロフィール行を取得、完了時にsessionの利用者も再確認する。auth listener内のSDK lockを避けるため取得開始を次のタスクへ延期する。表示metadataは権限判断には使わない。

設定画面と同期画面は共通の名前と既存`AccountAvatar`を使用。設定画面で「LINEの名前を使う」を押すと編集欄だけを更新し、既存の「表示名を保存」で確定する。LINEプロフィール変更による保存名の自動上書きはない。保存後はイベントで同期画面を更新する。自分のグループ内アバターにもAccountAvatarを使用する。他メンバーの私有LINE identityは取得・公開しない。

アイコンはLINE identityのpicture/avatar_urlのHTTPS値のみ。値なし、認証失敗、不正URL、画像読込失敗時は既定アイコンを維持。独自アイコンのユーザー設定は現行アプリにないため新たな保存形式は作らない。

公式資料:
- https://developers.line.biz/en/docs/line-login/verify-id-token/ （name/picture、profile scope、サーバーでのID token検証）
- https://supabase.com/docs/reference/javascript/auth-getuser （サーバーによるuser取得）
- 既存のOIDC custom:line/custom:quizmake-line、openid profile scopeを維持。実LINE OAuthアカウントのログインは未実施。署名検証をクライアントに作り直していない。

## 育成の診断

確認できた名称の問題は、`tricks`タブが「おやつ」と呼ばれ、同じ画面に資源名「おやつ」と芸の練習が表示されること。「芸」に変更し、機能の名前と資源名を分離した。

- 表示重複: 同時に2枚のキャラ/おやつを描画する症状は再現していない。
- 名称重複: 上記を修正。
- 機能重複: ごはんはなかよし度、おやつは芸の練習で消費する別資源。統合・削除していない。
- 報酬の二重付与: 既存のanswer IDによる重複除外を保持。報酬・所持数・育成進捗のコードを変更していない。

別の「おかしが被っている」表示を指していた場合、その症状は未特定である。名称修正をその不具合全体の解消とは扱わない。

## 検証

- 関連52テスト成功: プロフィール優先順位/未設定/別provider/画像不正、LINE連携、育成報酬/消費/保存など。
- `npm run build`成功。全体回帰の件数はPRに記録。
- `account-profile-validation.mjs`: 実SettingsScreen/AccountSyncScreenに隔離RPCを接続。既存名優先、LINE名の明示採用と保存、表示名の一致、画像404時のfallback、390px横はみ出しなしを確認。
- `companion-care-validation.mjs`: 実Appで49→50問の報酬、誤答/再解答、二重獲得防止、ごはん消費、なでる上限、芸の解放/練習/無料再実行、再読込、320/390/768pxを確認。名称変更に合わせ既存animation/spinテストのタブ指定も更新。
- ブラウザスクリーンショットを目視確認。実LINE providerの本番認証は未検証。

本番反映は統合作業側で実施。本ブランチからmainへマージ/デプロイしていない。
