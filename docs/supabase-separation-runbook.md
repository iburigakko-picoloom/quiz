# QuizMake専用Supabaseへの分離

更新：2026-09-13。**分離の準備中。本番切り替え・新プロジェクト作成・課金・データ移送は未実施。**

利用者は専用基盤へ分ける方針と、追加費用がかからない組織の追加を承認済み。無料組織だけ作成した。有料化、既存アプリのデータ削除・共通Authの無効化は承認に含めない。

## 現在地

- 移行元：`xqknwsjbvczyexfxlgar`（`manatocookie-poker.friend`、Mumbai）。他アプリとAuth／DBが共用。
- 新組織：[QuizMake](https://supabase.com/dashboard/org/mnzfinzzggrahvqeitmr)（`mnzfinzzggrahvqeitmr`）を **Free・月額0ドル** で作成済み。プロジェクトは0件。
- 新プロジェクト画面に「所有者／管理者の無料プロジェクト上限2件に到達」と表示。組織追加では無料枠は増えない。既存2環境は停止・削除・移動していない。
- 移行先：未作成。候補名 `quizmake`、日本向け利用を踏まえてTokyoを推奨。
- 他アプリ `xlnynzqhiqmmyrbkxhat` と、移行元のポーカー用テーブル／Edge Function `game` は変更・移送しない。
- GitHub Secrets、LINEのコールバック、利用中アプリのURLはまだ変更しない。

## 1. 読み取りで確認した実データの規模

`ops/supabase-separation/preflight.sql` を移行元で実行。2026-09-13 13:24 UTCのスナップショットであり、切り替え時の確定値ではない。

| 対象 | 件数 | 判断 |
| --- | ---: | --- |
| Auth利用者／Quizプロフィール | 各12 | プロフィールは全Auth登録で自動作成される。12人全員の移行根拠にしない |
| Quiz固有の利用実績がある利用者 | 1 | グループ、公開、同期所有者、Quiz用LINE identity等で集計 |
| グループ／所属／グループ共有リンク | 各1 | UUIDと役割を維持 |
| 招待 | 4 | 有効期限・取り消し・利用回数を維持。期限を延長しない |
| 公開セット／公開問題 | 4／1,138 | フォルダパス、公開先、問題順、共有トークンを維持 |
| 同期レコード | 8 | 所有者照合できるもの2、所有者未登録の旧方式6 |
| 同期ペイロード合計 | 8,822,626 bytes | 合計値。1件当たり上限と混同しない |
| 未照合の非NULL同期所有者 | 0 | 0以外になった場合は移送を止めて対応関係を調査 |
| コピー履歴／通報 | 各0 | 切り替え直前に再確認 |
| Storageバケット／オブジェクト | 各0 | 画像は同期JSON等に含まれるため、画像なしを意味しない |
| ペアリングコード／削除履歴／旧ID移行記録 | 各0 | 切り替え直前に再確認。増えた場合は下記の扱いを再検討 |

この点検はメール、ユーザーUUID、メモ本文、画像、同期ID、秘密キーを出力しない。Quiz対象15テーブルのRLSは有効で、点検対象RPCは存在する。ただし、RLSがあることだけで権限設計全体の安全性を保証しない。

## 2. 移送するもの・しないもの

### Quizデータの明示的な対象リスト

`public.quiz_profiles`（承認済み利用者のみ）、`quiz_groups`、`quiz_group_members`、`quiz_group_invites`、`quiz_group_problem_sets`、`shared_problem_sets`、`shared_questions`、`problem_set_copies`、`problem_reports`、`quiz_sync_data`。

セット／問題／グループのIDと、公開フォルダの `folder_path`、複数公開先を保持する。学習履歴・メモ・詳細解説・画像・AI依頼の対応IDは同期ペイロードを通して保持する。公開問題だけの移送を「全データ移行」と呼ばない。端末だけにある未同期データはサーバーから移せない。

### AuthはQuiz利用者に限定

1. `preflight.sql` の利用実績条件で候補を作り、外部キーで参照される作成者・招待者・投稿者も含めて承認リストを確定する。
2. `quiz_profiles` の存在、表示名、メール一致だけで他アプリの全利用者を移さない。実績のない11件も「Quiz未利用」と断定できない。端末のみ利用する人の確認／後日の本人確認付き引き継ぎ経路を決めるまで、移行元を消さない。
3. 承認済みユーザーのUUIDを保持した `auth.users` と必要な `auth.identities` の移送を、新旧Authスキーマの列・制約の比較後にリハーサルする。Supabaseの自動生成カラムやAuthの内部管理テーブルを想像で埋めない。
4. 現行アプリは `custom:quizmake-line` と `custom:line` に対応する。**実際に配布中の `VITE_LINE_AUTH_PROVIDER` とLINEチャネルを確認し、使っているQuiz用identityだけを移す。** ポーカー用LINE identityを丸ごと複製しない。新しいLINEチャネルを作って既存のLINEユーザーIDが同じになると仮定しない。
5. パスワード認証がある利用者のハッシュは公式手順に従って保つ。メール確認状態を勝手にtrueにしない。Quizに不要な `app_metadata` 権限や他アプリ専用情報はコピーしない。
6. 新プロジェクトの署名鍵・APIキーを使用。旧JWT署名鍵、セッション、refresh token、ログイン途中のOAuth状態・ワンタイムトークンは移さない。移行後は再ログインする。旧アプリ側で全セッションを破棄しない。

### 同期の署名を新環境で作り直す

同期所有者は `private.quiz_sync_hash('user:' || UUID)` という専用HMACで保存されている。UUIDを維持しても、新環境の `fingerprint_key` は異なるため、`creator_hash` の単純コピーは不可。

- 移行元で `creator_hash` とAuth UUIDの対応を、安全な移送処理内だけで照合する。
- 移行先では同じUUIDに対し**新環境のキーで** `creator_hash` を再計算する。秘密の `fingerprint_key` は複製しない。
- 所有者照合不能な非NULL行が1つでもあれば停止。NULLにして回避しない。
- 所有者が元からNULLの旧方式6件は、特定利用者のものと推測して割り当てない。旧同期IDとペイロードを守り、認証＋既存ID所持を確認する既存の引き継ぎ経路を新環境で検証する。弱い旧IDの更新期限（現行SQLは2027-08-15 UTC）も維持する。
- 同期ID、`updated_at`、ペイロード内容は維持して照合する。新環境にある既存行をforceで上書きしない。試行ごとの移送台帳とハッシュを使い、同一データの再実行以外は停止する。
- `quiz_sync_pairing_codes` は短期コードなので再発行する。レート制限記録も新規にする。
- `quiz_sync_tombstones`／`quiz_sync_legacy_migrations` に有効な行が発生した場合、元IDを復元できないHMACを新キーで再計算できるとは仮定しない。期限待ち／旧環境での救済／移行保留を決める。古い削除済み同期データを復活させない。

### 除外するもの

- `public.profiles`、ポーカーのゲーム・コミュニティ・ログ等11テーブル、ポーカー用Authトリガー `on_auth_user_created`、Edge Function `game`。
- プロジェクト全体のバックアップ復元、全 `auth`／全 `public` の無条件コピー。
- 旧プロジェクトのJWT署名鍵、サービスキー、全体のAuth／RLS設定変更。

## 3. スキーマの作成順と差分

**今の `supabase/migrations` をそのまま `db push` しない。** 別プロジェクト用の新規作業ディレクトリを用い、書き込み直前に移行先refが移行元・他アプリrefのいずれでもないことを確認する。

Quiz用の再構築候補（まだ実行済みではない）：

1. `20260625_create_quiz_sync_data.sql`
2. `20260729_secure_quiz_sync_rpc.sql`
3. `20260805_add_quiz_sync_delete_rpc.sql`
4. `20260806_create_collaboration_mvp.sql`
5. `20260807_add_group_member_management.sql`
6. `20260808_add_account_deletion.sql`
7. `20260809_expand_report_reasons.sql`
8. `20260814163631_secure_collaboration_rpc_only.sql`（下記注意）
9. `20260823172155_harden_account_owned_sync_and_add_pairing_codes.sql`
10. `20260823180238_delete_account_owned_sync_data.sql`
11. `20260909105403_publish_random_choices.sql`
12. `20260909105552_shared_read_fail_closed.sql`
13. `20260909115328_shared_folder_paths.sql`
14. `20260909135603_move_published_set_folder.sql`
15. `20260909144728_multi_destination_publishing.sql`

除外：`0001_remote_placeholder.sql`／`0002_remote_placeholder.sql` はポーカー側履歴の代替であり、Quizの初期化ではない。未追跡の `20260907021448_quiz_group_folders_and_invite_preview.sql` は今回取り込まない。

`20260814163631` はローカルにはあるが本番のmigration履歴にない。本番には同ファイル由来とみられるRPCもあるため、手動適用／履歴外差分の有無を定義・権限ごとに照合する。ファイルの存在だけで本番同一と判断しない。このファイルにはコピー履歴の整理もあるため、空の移行先スキーマ作成段階で検証し、データ移送後に再実行しない。

新しいMigrationファイルが必要なときは、Supabase CLIの `--help` を確認して `supabase migration new` で採番する。本番に未確認DDLを直接流さない。

## 4. 実行手順と停止条件

### A. 作成前

- [x] 追加費用なしの組織追加を利用者が承認し、無料組織「QuizMake」を作成。
- [ ] 無料プロジェクト上限を解決する方針を別途承認。現状は作成不可。有料化や既存アプリ停止で勝手に回避しない。
- [ ] その組織について `get_cost` で料金を確認し、金額・周期・Free枠の上限を説明して承認を得る。Freeプランという表示だけで追加料金0円としない。
- [ ] 承認後に専用プロジェクトを作成。まだGitHub Secretsを変更しない。

### B. リハーサル

- [ ] 移行先のref・URL・リージョンを記録。旧refと異なることを確認。
- [ ] スキーマだけ再構築し、RLS、明示的GRANT、SECURITY DEFINERの認証／所有者チェック、search_path、削除FKを確認。新しいData APIの初期GRANTを仮定しない。
- [ ] AuthトリガーはQuiz用のみ。他アプリ用テーブル・関数・トリガーがないことを確認。
- [ ] Auth／ユーザーデータの書き込み前にリストと対応関係を確定。機微な移送ファイルは暗号化・アクセス制限した場所で扱い、Git・チャット・CIログへ出さない。保存期限を決める。
- [ ] 旧端末のバックアップを確認。直近のメモ同期修正を含む最新版に各端末を更新する。旧版は新しいメモキーを解釈できない可能性があるため、旧版で新バックアップを取り込まない。
- [ ] 新環境へ限定移送し、件数に加えて承認済みUUID・データの正規化ハッシュ・画像数・ID関連を照合。Authハッシュ／ペイロード本文そのものは照合ログへ出さない。
- [ ] `preflight.sql` を新環境で実行。`non_quiz_tables=[]`、Quiz用以外のAuthトリガーなし、RLS欠落なし、未照合同期所有者0、RPC引数一致を確認。
- [ ] 公式advisorsを実行。警告を分類し、公開トークン読取等の意図した権限と、本当の権限漏れを区別して修正・再検証する。
- [ ] 専用のテスト利用者2人で、他人の同期／非公開問題が読めない・書けない、グループowner制限、匿名公開読取、共有リンク、フォルダ、招待、正解／画像／メモの保持を確認。
- [ ] 新環境の使い捨てテストアカウントで削除範囲と削除後トークンを検証。旧本番アカウントで削除テストしない。

### C. LINEと接続先の切り替え

- [ ] 新環境に、実際のQuiz用LINE provider名・同じチャネル・必要scope・安全なredirect allowlistを設定。シークレットをチャットに貼らない。
- [ ] LINE側に新しいSupabase callbackを追加できる構成か確認。旧callbackを先に消さない。プロジェクト丸ごとのAuth無効化をしない。
- [ ] メール、LINE、Androidブラウザ/PWA、iOS/iPadOSの実機から新環境で同じQuiz UUIDへ戻ることを確認。Native LINEは現状アプリ側で無効のため、PWA成功をNative対応済みとしない。
- [ ] フロント側の同期設定は現在、主に同期IDで区別している。接続先変更後に前のCAS状態を無条件で信用しない。再ログイン後、新旧クラウド照合と端末側の新しい編集の扱いを確認して自動同期を再開する導線／ガードを実装・検証する。未実装のまま一斉切り替えしない。
- [ ] 旧版も含むQuizの書き込みだけを止める手順を作り、停止期間を案内する。旧プロジェクト全体の停止はポーカーに影響するので不可。RPCだけでなく直接テーブル更新、Auth起点のQuizトリガーも対象を整理する。
- [ ] 停止後に差分を取り直して最終照合。移行中に新規の所有者／一時データが現れたら、初回点検値を信じて続行しない。
- [ ] 同一オリジン・同一PWA scopeを維持してWebを配布する。検証用の別オリジンへ本番利用者を誘導して端末内データが見えなくならないようにする。
- [ ] 検証済みの新URL／公開キー／LINE providerと `QUIZMAKE_EXPECTED_SUPABASE_PROJECT_REF` をGitHub設定にそろえる。変更前の値は機密管理で保持する。
- [ ] `scripts/check-client-env.mjs` とCIで誤配布を防止。JWT anonキーはURL内refとの一致も確認する。publishableキーはrefを含まないため、オフライン検査だけで接続確認済みにはしない。
- [ ] 新環境の最初の読み取り・保存・再読み取りを実データを消さない範囲で確認し、自動同期を段階的に再開する。

### D. ロールバック

- 新環境で実ユーザーの書き込みを受ける前：旧環境への接続を戻せるが、ローカル編集は保持し、必要な再ログインを案内する。
- 新環境で書き込みを受けた後：**Secretsを戻すだけでは不可。** 新環境の書き込みを止め、差分を退避し、ID／更新時刻／本文ハッシュで競合を確認してから戻す。新しいメモ・公開・グループを捨てない。
- 両方のクラウドを同時に書き込み可にして自動双方向マージしない。どちらを正とするか切り替え台帳で明示する。
- 旧Quizデータをすぐ削除しない。検証・復旧期間とデータ保管方針を運営者が確定し、別の削除承認を得てから整理する。ポーカーの共通AuthユーザーはQuizの移行を理由に削除しない。

## 5. 今回できたこと／まだできていないこと

できたこと：利用実績・同期所有者・トリガー・RPCの読み取り点検、再実行できる非破壊の点検SQL、Web/Android共通の公開キー検査と承認済みref照合、移送・検証・戻し方の整理。

追加でできたこと：無料組織「QuizMake」の作成とFreeプランの確認。費用のかかる契約変更はしていない。

まだできていないこと：無料枠上限を解決する方針の承認、新プロジェクトの作成、Authとデータの選択移送スクリプトの実環境検証、旧Quizだけの書き込み停止機構、接続先変更時の端末同期ガード、LINE callback設定と実機確認、最終移行・配布。**これらを完了するまでは分離済みと扱わない。**

## 公式参照

- [Supabase内の移行](https://supabase.com/docs/guides/platform/migrating-within-supabase)：全体復元の手順は参考にするが、今回の共有環境を丸ごと復元する用途では使わない。
- [Authユーザーの移行](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects)：認証データの移送と、新しい署名鍵なら再ログインが必要な点。
- [Data APIの保護](https://supabase.com/docs/guides/api/securing-your-api)：GRANTとRLSは別に確認する。
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)：最小権限、所有者制約、UPDATEに必要なSELECT。
