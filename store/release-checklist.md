# QuizMake ストア公開チェックリスト

## 完了済み（リポジトリ）

- CapacitorによるiOS・Androidプロジェクト
- Bundle ID / Application ID: `io.github.manatocookietwitterlang.quizmake`
- バージョン: `1.0` / build `1`
- Android target SDK 36、min SDK 24
- iOS deployment target 15.4
- iOS / Androidアイコン・スプラッシュ
- iOS Privacy Manifest（Filesystem: `C617.1`）
- ネイティブのバックアップ保存・共有
- ネイティブのクリップボード読み書き
- アプリ内プライバシーポリシー
- 公開プライバシーポリシーとサポートページ
- クラウドデータ削除機能
- 審査用サンプル問題
- ストア説明文・プライバシー申告案・審査メモ
- スマートフォン掲載用スクリーンショット（1290 x 2796）
- Supabase本番マイグレーション適用済み
- Web版とネイティブ版のAuth Redirect URL登録済み

## 現在の公開ブロッカー

- App Store Connect / Play Consoleの開発者登録、本人確認、契約・支払い情報
- iOSはMac・Xcode 26以降・iOS 26 SDK以降で署名とArchive、AndroidはAndroid Studio・Java 21・Android SDK 36で署名付きAABを生成する
- AndroidテストAPKはGitHub Actionsから生成可能。ストア署名・実機検証は別途必要
- PWAからの既存データ移行、LINEログインのアプリ復帰、ネイティブ共有受け取りを実機確認する
- Magic Linkを本番利用する前に、独自SMTPを設定して実メール送受信を確認する

## 本人による外部手続き

### Apple

1. Apple Developer Programへ加入
2. Macへ最新対応Xcodeをインストール
3. App Store ConnectでBundle IDとアプリ「QuizMake」を作成
4. XcodeのSigning & CapabilitiesでTeamを選択
5. 実機とTestFlightでバックアップ、貼り付け、同期、オフライン動作を確認
6. App Privacy、年齢区分、カテゴリ、説明、スクリーンショット、サポートURLを入力
7. ArchiveからApp Store Connectへアップロードし審査提出

### Google Play

1. Play Consoleデベロッパー登録と本人確認
2. アプリ「QuizMake」を作成し、Application IDを登録
3. Play App Signingを有効化してアップロード鍵を安全に保管
4. Android Studioで署名付きAABを作成
5. Data safety、対象年齢、広告の有無、コンテンツレーティング、説明、画像を入力
6. 内部テストで実機確認後、必要なクローズドテストを実施
7. 本番リリースへ提出

## 提出直前に置換・確認する項目

- ストア上の開発者名とプライバシーポリシーの運営者表記が一致していること
- GitHub Issuesを正式な問い合わせ窓口として使うか、専用メールアドレスへ置換すること
- Supabaseの最新マイグレーションとAuth Redirect URLが本番へ適用済みであること
- 各ストアが要求する最新OS・SDK・Xcode要件
- スクリーンショットが提出するビルドの画面と一致していること
