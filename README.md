# QuizMake

問題セットを作成・整理し、4択クイズと復習を行う学習アプリです。Web/PWAに加え、Capacitorを使ったAndroid・iOSビルドに対応しています。

## 主な機能

- フォルダと問題セットの作成・編集・並べ替え
- JSONまたは貼り付けによる問題の一括取り込み
- ChatGPT向け問題作成テンプレートのコピー
- Markdownと表に対応した詳細解説
- 正解・不正解・曖昧を記録する4択クイズ
- 問題セット単位の復習と学習状況表示
- カテゴリ別の手書きノート
- 端末内JSONバックアップ
- 任意のSupabase同期（8文字の一時接続コード対応）
- スマートフォン、タブレット、PCに対応した明るいレスポンシブUI

## 技術構成

- React / TypeScript / Vite
- IndexedDB・localStorage
- Supabase（任意のクラウド同期・共同利用機能）
- Capacitor（Android / iOS）
- GitHub Pages / PWA

## セットアップ

```bash
npm ci
```

ローカルで起動します。

```bash
npm run dev
```

同じWi-Fiのスマートフォンから確認する場合は、次のコマンドで起動し、表示された `Network` のURLを開きます。

```bash
npm run dev -- --host 0.0.0.0
```

## 検証とビルド

```bash
npm test
npm run build
npm run build:native
```

通常の修正では関係するテストファイルだけを実行し、配布前には `npm test` を実行します。保存・復元・同期競合・認証／権限・取り込みの互換性を優先し、文言・CSSクラス・固定ピクセル値だけのテストは追加しません。見た目、スクロール、スワイプは変更した画面をスマホ幅で確認します。削除したテストと理由は [テスト整理記録](tests/AUDIT.md) にあります。

ネイティブプロジェクトへ最新のWeb資産を反映する場合は、次を実行します。

```bash
npm run mobile:sync
```

ストア提出手順と確認項目は、[store/release-checklist.md](store/release-checklist.md) と [store/native-build.md](store/native-build.md) にまとめています。

## クラウド同期

Supabase同期を有効にする場合は、ビルド時に次の環境変数を設定します。

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

未設定でも、端末内での問題作成・学習・JSONバックアップは利用できます。データベース変更は `supabase/migrations`、回帰検証用SQLは `supabase/tests` にあります。

Web/Androidの配布CIでは公開キーの検査を行います。リポジトリ変数 `QUIZMAKE_EXPECTED_SUPABASE_PROJECT_REF` を設定すると接続先も固定検査します。これはアプリへ埋め込む環境変数ではありません。キーの権限・URLとの不一致は配布前に停止しますが、ログインの実機検証は別に必要です。

専用Supabaseへの移行準備は [分離手順](docs/supabase-separation-runbook.md) を参照してください。現在のmigrationフォルダを新環境へ一括適用しないでください。

## GitHub Pages

`.github/workflows/deploy.yml` が `main` の更新をビルドして公開します。リポジトリの `Settings > Pages > Source` は `GitHub Actions` を選択してください。
