# RRoom-Scraper

楽天ランキングの商品を楽天ROOMに投稿するツール。Windows版はルートの `index.js` と既存のbat、クラウド版は `github-actions/` を使います。

クラウド版はGitHub ActionsのLinux上でヘッドレスChromiumを起動します。Windows PCの常時起動は不要です。実アカウントでの確認状況は「確認した範囲」を参照してください。

## 維持する機能

- 3アカウントを順番に処理。ブラウザのCookie・ストレージはアカウントごとに分離。
- 各アカウントで最大20件フォロー、最大20件いいね、その後ランキング1ページの商品を投稿。
- Windows版と同じランキング条件（`sex=1`、20/30/40代から抽選、1〜34ページから抽選）。通常は最大30商品、商品ごとに5秒待機。
- コレ済み商品をスキップ。通常は既存の定型文、`USE_OPENAI=true` のときだけ既存のOpenAI生成文を使用。
- 日本時間の毎日 **7・9・11・13・15・17・19・21・23時**に起動。GitHub側の混雑による遅延・欠落はあり、定刻の実行保証はありません。

## 今回直した箇所

以前のActions版には、アカウント3・フォロー・いいねがなく、ランキング条件もWindows版と異なっていました。OpenAIを無条件に初期化し、Secrets未設定で起動に失敗する構成でもありました。処理エラーを捕捉したまま正常終了するため、GitHubの緑の成功表示だけでは投稿できたか判断できませんでした。

新しい版はセッションを暗号化して次回に復元し、有効なセッションがなければ自動ログインします。API取得・認証・フォロー・いいね・投稿のどこで止まったかをSummaryに記録し、失敗時は終了コード1になります。投稿後は同じ商品を開き直し、ROOMの「すでにコレしている商品です」を確認してから投稿数を加算します。結果不明の送信は自動再送しません。

フォロー・いいねの件数は従来と同じクリック操作数です。サーバーに保存された件数を保証するものではありません。候補不足の場合は20件に届かず終了します。一覧の読み込みを最大30秒待ち、操作ボタン自体が見つからない場合は SOCIAL_NOT_READY として記録します。その場合も投稿処理は試みますが、ジョブ全体は partial / 失敗になります。初回は実画面でも確認してください。

## クラウド運用開始まで

### 1. GitHubにこの変更を反映

`.github/workflows/` を含む変更をリポジトリのデフォルトブランチ（このリポジトリでは `master`）に反映します。Actionsの `Cloud runner tests` が成功することを確認します。テストは楽天への実投稿を行いません。

### 2. Secretsを登録

[Settings → Secrets and variables → Actions](https://github.com/kmaezmac/RRoom-Scraper/settings/secrets/actions) の **Secrets** に登録します。`.env` をGitHubにコミットしてはいけません。

| Secret | 内容 |
|---|---|
| `RAKUTEN_APP_ID` | 楽天ランキングAPIのアプリID（全アカウントの既定値） |
| `ACCESS_TOKEN` | 楽天APIの **accessKey**。以前の環境変数名を維持しています |
| `SESSION_ENCRYPTION_KEY` | セッション暗号化用の64桁16進数 |
| `RAKUTEN_USER_ID` / `RAKUTEN_PASSWORD` | アカウント1の楽天ID・パスワード |
| `RAKUTEN_USER_ID2` / `RAKUTEN_PASSWORD2` | アカウント2の楽天ID・パスワード |
| `RAKUTEN_USER_ID3` / `RAKUTEN_PASSWORD3` | アカウント3の楽天ID・パスワード |
| `RAKUTEN_APP_ID2` / `RAKUTEN_APP_ID3` | 任意。アカウント別のAPIアプリID |
| `RAKUTEN_SESSION` / `RAKUTEN_SESSION2` / `RAKUTEN_SESSION3` | 任意。後述の暗号化済みログイン状態 |
| `OPENAI_API_KEY` | 任意。生成文を使う場合のみ |

暗号鍵は手元で生成します。表示された値を `SESSION_ENCRYPTION_KEY` に登録します。

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

楽天APIの許可IP・許可URL設定は開発者ポータルで確認してください。GitHubの標準ランナーは固定IPではありません。現在の契約・登録設定でクラウドからのAPI呼び出しが許可されるか、次の診断で確かめます。「IP制限を全許可すれば必ず使える」とは限りません。

### 3. 投稿しない診断を実行

[Actions → 楽天ROOM自動投稿](https://github.com/kmaezmac/RRoom-Scraper/actions/workflows/rakuten.yml) → **Run workflow**:

- `account`: 最初は `account1`
- `mode`: **diagnose**
- `max_items`: `1`

ランキングAPI取得 → ログイン → 商品名の読み込み確認 → 投稿文の入力と送信ボタンの有効化確認 → フォロー・いいね一覧の読み込み確認 → セッション保存までを行います。送信ボタンやフォロー・いいねボタンは押さず、OpenAIも呼び出しません。コレ済み商品では入力・送信ボタンを確認できないため partial として記録します。アカウント2・3も個別に診断してください。account1の成功は他のアカウントの認証成功を意味しません。

### 4. 少量の実投稿を確認

同じ画面で `account1` / `run` / `max_items=1` を選択します。**1商品の投稿と、通常のフォロー最大20件・いいね最大20件が実行されます。** ROOM上の投稿・アカウント・文章とActionsのSummaryを確認してください。各アカウントで確認後、`all` / `run` / `30` が通常運転です。

### 5. 定時実行を有効化

Windows側のタスクスケジューラを停止して二重実行を避け、GitHubの同じ設定画面の **Variables** に `ENABLE_SCHEDULE=true` を登録します。次の対象時刻から3アカウントの通常運転が始まります。`false` に戻すと定時ジョブはスキップします。

`USE_OPENAI=true` もVariablesに設定できます。未設定なら定型文です。OpenAI APIの利用料金はActionsの無料枠とは別です。

## 自動ログインで止まる場合

楽天側がCAPTCHA・SMS等の追加認証やクラウドIP制限を要求する場合、パスワードだけの完全無人ログインはできません。認証を回避する処理はありません。既存のWindowsでログイン済みの状態を一度持ち込む方法を用意しています。

1. Windowsにこの変更を反映して `npm ci --prefix github-actions` を実行。
2. Windowsのルート `.env` に、GitHubと同じ `SESSION_ENCRYPTION_KEY` を設定。
3. 従来の `account1.bat` でChromeを起動し、対象アカウントで楽天ROOMにログイン。
4. 次のコマンドを実行（2・3も同様）。

```sh
node github-actions/export-session.js 1
node github-actions/export-session.js 2
node github-actions/export-session.js 3
```

5. 作成された `github-actions/.state/account1.enc` の**ファイル内容**をSecret `RAKUTEN_SESSION` に登録。2・3は `RAKUTEN_SESSION2` / `RAKUTEN_SESSION3`。
6. Variablesの `SESSION_VERSION` を以前と異なる値（例: `2`）に設定して古いキャッシュを使わないようにし、再び `diagnose` を実行。

有効なセッションがあればID・パスワードなしでも実行できます。その場合、失効時に自動ログインで復旧することはできません。通常運転中は更新されたCookie等を暗号化して保存しますが、キャッシュの退避・失効・楽天側の再認証で再登録が必要になることがあります。ログイン状態の持ち込みでもクラウドIPを拒否される場合、この方式だけでは解決できません。

公開リポジトリのキャッシュは秘密の保管庫ではありません。このため **AES-256-GCMで暗号化した `.enc` だけ**をキャッシュし、暗号鍵をSecretsに保存します。アカウントを変えたり鍵を更新したりする際はセッションを再出力し、`SESSION_VERSION` も更新してください。生Cookie、HTML、スクリーンショット、トレースはログやartifactに保存しません。

## ログの見方と制約

Actions実行ページの **Summary** に段階・投稿確認数・コレ済み数・操作数・エラー分類が表示されます。機密情報を含めない `summary.json` も7日間保存します。失敗時は操作名（例: `collect.fill`）と入力欄・ボタンの表示件数、画面種別だけを追加記録します。楽天ID、個人ROOM URL、入力値、ページ本文、生の例外メッセージは出力しません。ブラウザの起動前などに失敗するとSummaryがない場合があるので、失敗したStepも確認してください。

| エラー | 意味・対応 |
|---|---|
| `CONFIG` | 必須Secrets、実行アカウント、件数等を確認 |
| `RANKING_API` | HTTP 400はパラメータ等、401/403はキー・許可IP/URL等、429は利用上限等を確認 |
| `RANKING_EMPTY` | 抽選されたランキングが空、またはAPI応答形式が違う |
| `AUTH_REQUIRED` | 有効なログイン状態もID/パスワードもない |
| `AUTH_USER_STEP` | ユーザーID送信後にパスワード画面へ進めない |
| `AUTH_RETURN` | ログイン送信後にROOMへ戻れない。UI件数と追加認証の有無を確認 |
| `AUTH_FAILED` | ID/パスワード誤り、画面変更、追加認証、クラウド接続拒否等。自動判別できないケースを含む |
| `AUTH_CHALLENGE` | 追加認証を検出。手動ログインしてセッションを登録 |
| `ACCESS_BLOCKED` | 楽天側のアクセス拒否を検出。クラウドからの利用可否を確認 |
| `SESSION_DECRYPT` | 暗号鍵・アカウント・キャッシュ世代の不一致等 |
| `ROOM_MODAL` | コレ済み以外のメッセージ。ROOMで内容を確認 |
| `POST_UNCONFIRMED` | 送信後の保存確認ができず停止。投稿済みの可能性があるため、再実行前にROOMで確認 |
| `POST_R145` / `POST_R106` | 楽天ROOMが投稿文の文字列・文字・記号を拒否。本文はログに出さない |
| `POST_R122` | 楽天ROOMの投稿数上限。ROOM上で既存投稿を確認 |
| `POST_R119` / `POST_R120` / `POST_R143` | 楽天側で商品が削除されている |
| `POST_HTTP` / `POST_REJECTED` | 送信先がエラー応答を返した。HTTPステータスや固定分類のみ記録 |
| `NAVIGATION_CONNECT` | ページ本体への接続が失敗・時間切れ。クラウド側の接続を確認 |
| `NAVIGATION_DOM` | ページ本体は応答したが、スクリプト等の読み込みが時間切れ |
| `NAVIGATION_HTTP` | ページ本体がHTTPエラーを返した |
| `LOCATOR_AMBIGUOUS` / `COLLECT_FIELD_COUNT` | 操作対象の重複または欠落。公開ログのUI件数で確認 |
| `COLLECT_ITEM_NOT_READY` | 投稿対象の商品情報が未読込。入力欄が表示されていても送信しない |
| `COLLECT_BUTTON_NOT_READY` | 送信ボタンの欠落・重複・無効状態 |
| `SOCIAL_NOT_READY` | フォロー・いいね一覧が未読込、未ログイン、または画面構造が変わった |
| `PAGE_NAVIGATING` | 画面遷移で読み取りが中断。読み取りのみ短時間再試行し、投稿ボタンは再送しない |
| `TIMEOUT` | ページ読み込み・画面要素の待機が時間切れ。画面変更や接続拒否の場合もある |

失敗したアカウントの後も残りのアカウントを処理し、最後にジョブ全体を失敗にします。GitHubのActions失敗通知を有効にしておくと停止に気づけます。自動再試行は読み取り専用のランキングAPIだけで、投稿を無条件に再送しません。GitHub側で強制終了された直前の投稿は結果不明になり得ます。

定期実行・手動実行は同じconcurrencyグループで直列化します。Windows版や別リポジトリでの同時実行は防げません。GitHubの待機ジョブは新しい実行に置き換わることがあり、全ての予定回数が必ず実行される保証はありません。

## 無料サービスの選定

2026-10-14確認。今回のようなブラウザ付きの定期バッチは、既存のNode.jsをそのまま動かせるGitHub Actionsを採用しています。

| 候補 | このアプリでの制約 |
|---|---|
| GitHub Actions | 公開リポジトリの標準ランナーは実行時間無料。非公開のGitHub Freeは月2,000分。公開リポジトリの定期実行は60日間リポジトリ活動がないと自動停止。固定IP・定刻実行の保証なし |
| Vercel Hobby | 各cronの最小間隔は1日で時刻精度は時間単位。Functionsの実行時間制限もあり、この長いブラウザバッチをそのまま移す用途には不向き |
| Cloudflare Browser Run | 無料プランはブラウザ合計10分/日。3アカウント×9回/日と既存の待機時間を維持する運用では足りない |

3アカウント×30商品×5秒×9回 = **商品間の待機だけで67.5分/日**。ここにブラウザ起動、API、ページ読み込み、フォロー・いいねが加わります。非公開リポジトリでは待機だけでも30日で2,025分となり、無料枠内を保証できません。現在の公開設定を維持する場合もストレージ上限やサービス側の制限は別にあります。

- [GitHub Actions料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub定期実行の遅延・60日停止](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Vercel cron制約](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Cloudflare Browser Run料金](https://developers.cloudflare.com/browser-run/pricing/)
- [楽天ランキングAPI仕様](https://webservice.rakuten.co.jp/documentation/ichiba-item-ranking)

## 実際に確認した範囲（2026-10-14）

GitHub ActionsのUbuntu 24.04 / Node.js 24上で、自動テスト25項目と楽天ROOM公開ページのHTTP 200応答を確認しました（[テスト実行](https://github.com/kmaezmac/RRoom-Scraper/actions/runs/38537570311)）。

実アカウントの診断ではaccount1・3でAPI取得、認証、投稿文入力、有効な送信ボタン、フォロー・いいね一覧の確認まで通過しました（[3アカウントの診断](https://github.com/kmaezmac/RRoom-Scraper/actions/runs/38534250188)）。account2もSecrets更新後に同じ診断を通過しました（[account2の再診断](https://github.com/kmaezmac/RRoom-Scraper/actions/runs/38535943529)）。診断では投稿・フォロー・いいねを実行しません。

account1ではフォロー2件・いいね20件の操作を実施しました。商品コードの修正後は投稿1件がHTTP 200で受け付けられ、商品を開き直した際の「コレ済み」表示まで確認できました（[実投稿成功の検証](https://github.com/kmaezmac/RRoom-Scraper/actions/runs/38537570426)）。投稿の再検証ではフォロー・いいねを繰り返していません。account2・3の実投稿と、3アカウント×30件の連続運転は未検証なので、マージ後はまず `account=all` / `mode=run` / `max_items=1` で確認してください。

HTTP 400の調査では、投稿リクエストの商品コード・商品名が空になっていました。ROOMの該当画面はクエリ文字列をURLデコードせず読むため、移植時に `:` を `%3A` へ変換した商品コードが原因でした。Windows版と同じく `:` を保持し、商品名の読み込み完了を待ってから入力・送信するよう修正しました。入力欄や有効なボタンだけでは商品情報の読み込み完了とは判定しません。

最初のクラウド接続テストは30秒でタイムアウトしました。再診断ではブラウザでページ本体の応答に約9秒、DOMの読み込み完了までさらに約21秒かかりました。実行環境からの読み込み遅延で従来の30秒を超える場合があるため、本番処理も「接続30秒」と「読み込み30秒」を別々に待つ方式に修正しました。アクセス拒否や追加認証はアカウントごとに確認が必要です。

## ローカルでの確認

Node.js 22以上（Actionsは24）を使用します。既存のWindows起動用 `index.js` は変更していません。

```sh
npm ci --prefix github-actions
cd github-actions
npx playwright install chromium --only-shell
npm test
npm run test:browser
npm run probe
```

`probe` は認証情報なしで公開ROOMページへの接続を確認します。認証や投稿の成功を意味しません。`test:browser` はテスト用ページを使った実Chromiumテストです。

ルートの `.env` を `github-actions/.env.example` に沿って設定し、`RUN_ACCOUNT=account1` / `RUN_MODE=diagnose` で `npm start --prefix github-actions` を実行すると、手元でも同じ診断ができます。通常処理には `RUN_MODE=run` を明示します。既存の `USE_PLAYWRIGHT` はクラウド版では使いません。
