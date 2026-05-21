# RRoom-Scraper

楽天ROOMに楽天ランキング商品を自動投稿するツール。

## 構成

```
RRoom-Scraper/
├── index.js              # Windows版（手動実行）
├── rakuten.bat           # Windows版の起動スクリプト
├── github-actions/
│   ├── index.js          # GitHub Actions版（ヘッドレス・自動ログイン）
│   └── package.json
└── .github/
    └── workflows/
        └── rakuten.yml   # スケジュール実行設定（1日4回）
```

## Windows版（手動実行）

### 前提
- Chrome を `account1.bat` / `account2.bat` で起動して手動ログイン済みであること

### 実行
`rakuten.bat` をダブルクリック

### ログ
`log.txt` に出力（コマンドプロンプトにも同時表示）

---

## GitHub Actions版（自動実行）

### セットアップ

#### 1. GitHub Secretsの登録
リポジトリの **Settings → Secrets and variables → Actions** で以下を登録：

| Secret名 | 説明 |
|---|---|
| `RAKUTEN_USER_ID` | アカウント1のユーザーID |
| `RAKUTEN_PASSWORD` | アカウント1のパスワード |
| `RAKUTEN_APP_ID` | アカウント1のアプリID |
| `RAKUTEN_USER_ID2` | アカウント2のユーザーID |
| `RAKUTEN_PASSWORD2` | アカウント2のパスワード |
| `RAKUTEN_APP_ID2` | アカウント2のアプリID |
| `ACCESS_TOKEN` | アクセストークン |

#### 2. 手動実行でテスト
**Actions → 楽天ROOM自動投稿 → Run workflow**

### スケジュール
日本時間 8時 / 12時 / 18時 / 23時（1日4回）

### ログ確認
Actions の各実行ページでログを確認できる。

## 環境変数（.env）

`.env` はGitに含まれない（`.gitignore`で除外済み）。
ローカル実行時は `.env` ファイルをプロジェクトルートに配置する。

```
RAKUTEN_USER_ID=
RAKUTEN_PASSWORD=
RAKUTEN_APP_ID=
ACCESS_TOKEN=
RAKUTEN_USER_ID2=
RAKUTEN_PASSWORD2=
RAKUTEN_APP_ID2=
```
