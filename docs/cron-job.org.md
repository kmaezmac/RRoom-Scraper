# cron-job.orgから楽天ROOMのActionsを起動する

時刻・曜日・回数はcron-job.orgで管理し、投稿処理はGitHub Actionsで実行します。GitHubの `schedule` は削除済みです。外部サーバーやWindows PCの常時起動は不要です。

## 切り替え前の確認

1. この変更を `master` にマージします。
2. Windowsのタスクスケジューラは停止したままにします。
3. Actionsで、旧 `schedule` による実行中・待機中のジョブが残っていないか確認します。ワークフローを変更しても、すでに作成された旧実行は消えません。実行中の投稿を不用意に中断せず、終了を待ってから外部cronを有効にします。

既存の楽天ID・パスワード・APIキー・暗号鍵のSecretsはそのまま使います。`ENABLE_SCHEDULE` はもう参照しないので削除できます。以後、この変数を `false` にしても外部からの起動は止まりません。

## 1. GitHubで起動用トークンを作る

GitHubの **Settings → Developer settings → Personal access tokens → Fine-grained tokens** から専用トークンを作成します。

- Resource owner: `kmaezmac`
- Repository access: **Only select repositories → RRoom-Scraper**
- Repository permissions: **Actions → Read and write**（Metadataの読み取りは自動付与）
- 有効期限: 運用できる期間を設定し、期限前にcron-job.orgのヘッダーを更新します。

このトークンはcron-job.orgのAuthorizationヘッダーだけに登録します。チャット、リポジトリ、URL、Request bodyには書きません。cron-job.orgに楽天の認証情報を渡す必要はありません。

## 2. cron-job.orgにジョブを作る

初めは無効の状態で作成し、診断を確認してから有効にします。

| 項目 | 設定値 |
|---|---|
| タイトル | 楽天ROOM自動投稿 |
| URL | `https://api.github.com/repos/kmaezmac/RRoom-Scraper/actions/workflows/rakuten.yml/dispatches` |
| HTTP method | `POST` |
| Timezone | `Asia/Tokyo` |
| 時刻 | 毎日 `07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00, 23:00` |
| cron式で入力する場合 | `0 7,9,11,13,15,17,19,21,23 * * *`（TimezoneをAsia/Tokyoに設定した場合） |
| 通知 | 起動リクエストの失敗・失敗からの復旧・連続失敗による自動無効化の通知を有効にする |

カスタムヘッダーは次の4つです。`Authorization` の値だけ自分のトークンに置き換えます。

```text
Authorization: Bearer <作成したFine-grained token>
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2026-03-10
```

**最初のテスト用Request body**（投稿・フォロー・いいねをしない診断）:

```json
{
  "ref": "master",
  "inputs": {
    "source": "cron-job.org",
    "account": "account1",
    "mode": "diagnose",
    "max_items": "1",
    "max_posts": "1"
  }
}
```

cron-job.orgのテスト実行でAPIが2xxを返し、GitHub Actionsに `楽天ROOM / cron-job.org` が作成されることを確認します。現在指定しているAPIバージョンの正常応答はHTTP 200と実行ID・URLです。APIバージョンによっては204が返る場合もあります。GitHub側で診断のSummaryまで確認してください。コレ済み商品の診断は未確認項目ありとして失敗することがあり、APIからの起動失敗とは区別します。

## 3. 通常運転に切り替える

Request bodyを次の内容に変更して保存し、cron-job.orgのジョブを有効にします。コピー用ファイルは [`github-actions/cron-job.request.json`](../github-actions/cron-job.request.json) です。

```json
{
  "ref": "master",
  "inputs": {
    "source": "cron-job.org",
    "account": "all",
    "mode": "run",
    "max_items": "30",
    "max_posts": "30"
  }
}
```

これで1日9回、3アカウントの通常処理を起動する設定になります。1回ごとに各アカウント最大30商品の投稿処理と、最大20件ずつのフォロー・いいねを行います。時刻・曜日・回数を変えるときはcron-job.orgだけを変更します。

**通常運転のbodyでテスト実行すると、その場で実投稿が始まります。** 同じ設定のcronジョブを複数作らないでください。手動実行も1回分として扱われます。

## 待機・実行回数・停止について

- 投稿・認証セッションの競合を防ぐため、手動実行と外部cronは共通の `rakuten-room` グループで直列実行します。
- `queue: max` により最大100件の待機要求を保持します。以前の「実行中1件＋待機1件、新しい要求で待機分を置換」の設定から変更しています。
- 前の回が終わっていなければ、次の要求は待機します。古い要求も順次実行するため、深夜や翌日にずれ込むことがあります。100件を超える待機要求、GitHub側の障害・制限等までは保証できません。
- **cron-job.orgの成功はGitHubへの起動依頼が成功した意味です。投稿成功ではありません。** cron-job.orgはAPI応答だけを待つので、約30秒のHTTP待機制限内で利用できます。投稿処理自体はActionsで続きます。
- 毎日、cron-job.orgの9回分の履歴とActionsの `楽天ROOM / cron-job.org` の実行IDを照合できます。待機中・失敗・成功はActionsで確認します。通常runの「警告あり」はジョブ成功なので、アカウント別の結果はSummaryで確認します。
- API送信のタイムアウト時は、GitHubが受理済みの可能性があります。Actionsに該当する実行がないか確認してから再依頼します。GitHubのdispatch APIにはこの構成での重複排除がなく、再依頼すると別の実行になります。
- 今回は未実行枠の自動補完や、投稿エラー後の自動再実行は追加していません。予定回数の起動依頼と、受理した要求の待機保持を改善する構成です。
- 停止するにはcron-job.orgのジョブを無効にします。すでに受け付けた待機要求は残るため、停止させたい待機分はActions側でキャンセルします。実行中の強制キャンセルは投稿結果が不明になる可能性があります。

## エラーの見分け方

| 症状 | 確認すること |
|---|---|
| HTTP 401 | トークンの誤り・期限切れ・失効 |
| HTTP 403 | Actionsの書き込み権限・組織の承認・API利用制限 |
| HTTP 404 | リポジトリへのアクセス権、URL、マージ済みか |
| HTTP 422 | `master`、JSON、入力名・値、workflow_dispatchの設定 |
| APIは2xx、Actionsはqueued/pending | 受理済み。前の実行やランナーを待っています |
| APIは2xx、Actionsが失敗 | 起動後の問題。Summaryまたは失敗Stepを確認 |
| cron-job.orgが無効になった | 連続失敗による停止やトークン期限切れを確認して再有効化 |

## 仕様の出典

- [GitHub workflow_dispatch API・必要権限](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub concurrencyのqueue: max・100件の上限](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [cron-job.orgのHTTPメソッド・ヘッダー・実行履歴・タイムアウト・定刻保証の制約](https://cron-job.org/en/faq/)
