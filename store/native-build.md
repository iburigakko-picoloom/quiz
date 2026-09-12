# QuizMake ネイティブ提出ビルド

## 共通準備

1. `npm ci`
2. `.env.native.local` に次を設定（値はWeb版と同じSupabaseプロジェクト）

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=PUBLIC_ANON_KEY
```

3. `npm run mobile:sync`
4. アプリID `io.github.manatocookietwitterlang.quizmake` がストア登録値と一致することを確認

`mobile:sync` はネイティブ用に相対パスでWeb資産を作り、Android/iOSへコピーします。Windowsで生成されるSwift Packageのパス区切りも自動補正します。

## Android / Google Play

このプロジェクトはJava 21・Android SDK 36を使用します。Android Studio 2025.2.1以降に付属するJDKを使用できます。JDK 17では生成済みのJava 21設定をコンパイルできません。

### PCにAndroid環境がない場合

GitHubのActionsで **Build Android test APK → Run workflow** を実行します。成功後、Artifactsから `QuizMake-Android-test-*` をダウンロードし、ZIP内の `app-debug.apk` をAndroid端末に入れて確認できます。Web公開で使用している既存の公開クライアント設定を引き継ぎ、秘密鍵の混入・設定漏れはビルド前に止めます。

これは実機確認用のデバッグ版で、ストア提出用ではありません。実行ごとにデバッグ署名が変わる場合があるため、継続利用・配布には固定の署名鍵が必要です。既存ネイティブ版を削除して入れ直す前に必ずデータを書き出してください。PWAの端末内データも自動では移行しません。元のPWAを消さず、バックアップまたは同期で移行して確認してください。

APKの生成成功は、ログイン・同期・画像共有の実機動作を保証しません。現在 `cloudService.ts` はネイティブ版のLINEログイン・連携を明示的に無効化しています。メールログインと学習・保存を先に実機確認し、LINEは外部ブラウザ認証とアプリ復帰の追加実装後に確認してください。ネイティブの共有受け取りもWebのShare Targetと別実装のため、提出前に追加実装が必要です。

1. Android Studioで `android` フォルダを開く
2. 実機またはエミュレーターでデバッグ版を確認
3. **Build > Generate Signed Bundle / APK > Android App Bundle** を選ぶ
4. 新しいアップロード鍵はリポジトリ外へ作り、安全にバックアップする
5. release版AABを作成し、Play Consoleの内部テストへアップロード
6. `store/privacy-declarations.md` を基にData safetyを入力して実機確認後に本番提出

## iOS / App Store

2026年9月確認：提出にはXcode 26以降とiOS 26 SDK以降が必要です。Windows単体では署名済みIPAを作れません。

1. Macへリポジトリを取得し、共通準備を実行
2. `npm run mobile:ios` でXcodeを開く
3. Signing & Capabilitiesで開発者Teamを選ぶ
4. 実機でクリップボード、JSON共有、同期、オフライン起動、詳細解説の表を確認
5. Generic iOS Deviceを選び、**Product > Archive** を実行
6. OrganizerからApp Store Connectへアップロードし、TestFlightで最終確認

## バージョン更新

- Android: `android/app/build.gradle` の `versionCode` を毎回増やし、`versionName` を更新
- iOS: Xcodeの `CURRENT_PROJECT_VERSION` を毎回増やし、`MARKETING_VERSION` を更新
- JavaScript側: `package.json` の `version` も同じ公開バージョンへ合わせる
