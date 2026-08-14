# RRoom-Scraper

楽天ROOMに楽天ランキング商品を自動投稿するツール。

## 構成

```
RRoom-Scraper/
├── index.js              # Windows版（手動実行）
├── rakuten.bat           # Windows版の起動スクリプト
├── account1.bat          # アカウント1用Chrome起動
├── account2.bat          # アカウント2用Chrome起動
├── account3.bat          # アカウント3用Chrome起動
├── github-actions/
│   ├── index.js          # GitHub Actions版（ヘッドレス・自動ログイン）
│   └── package.json
└── .github/
    └── workflows/
        └── rakuten.yml   # スケジュール実行設定
```

---

## Windows版（手動実行）

### 前提
- 各アカウントの `.bat` ファイルで Chrome を起動して手動ログイン済みであること

### 実行
`rakuten.bat` をダブルクリック

### ログ
`log.txt` に出力（コマンドプロンプトにも同時表示）

---

## 環境変数（.env）

`.env` はGitに含まれない（`.gitignore`で除外済み）。
ローカル実行時は `.env` ファイルをプロジェクトルートに配置する。

```
# アカウント1
RAKUTEN_USER_ID=       # 楽天IDまたはメールアドレス
RAKUTEN_PASSWORD=      # 楽天パスワード
RAKUTEN_APP_ID=        # 楽天APIアプリID（後述）

# アカウント2
RAKUTEN_USER_ID2=
RAKUTEN_PASSWORD2=
RAKUTEN_APP_ID2=

# アカウント3
RAKUTEN_USER_ID3=
RAKUTEN_PASSWORD3=
RAKUTEN_APP_ID3=

# 楽天APIアクセストークン
ACCESS_TOKEN=

# OpenAI（省略可）
OPENAI_API_KEY=
USE_OPENAI=false       # true にするとOpenAI APIで投稿文を生成
```

### RAKUTEN_APP_ID について

- `RAKUTEN_APP_ID` は楽天ランキングAPI（商品データ取得用）のアプリID
- 取得元: https://webservice.rakuten.co.jp/
- **ローカル（Windows版）でのみ必要。GitHub Actionsでは現在アカウント1のIDを全アカウントで使い回している**
- 楽天ROOMへの投稿はアカウントごとのブラウザセッションで行うため、APIのアプリIDが違っても投稿先アフィリエイトIDは各アカウントのものになる
- アプリIDはランキングデータ取得だけに使うため、1つを複数アカウントで共有しても問題ない（1日・1か月の上限は呼び出し数による）

---

## 新しいアカウントを追加する手順

アカウントN（例: アカウント4, ポート9225）を追加する場合：

### 1. `.env` に認証情報を追加

```
RAKUTEN_USER_ID4=メールアドレス
RAKUTEN_PASSWORD4=パスワード
RAKUTEN_APP_ID4=既存のAPP_IDを流用でOK
```

### 2. `.bat` ファイルを作成（`account4.bat`）

```bat
@echo off
chcp 65001 >nul
echo Starting Chrome for Account 4 (Port 9225)
start chrome.exe --remote-debugging-port=9225 --user-data-dir="%USERPROFILE%\chrome-rakuten-account4" https://room.rakuten.co.jp/
echo Chrome for Account 4 has started.
echo Please login with Account 4 in this Chrome window.
timeout /t 2 /nobreak >nul
```

- `--remote-debugging-port` は各アカウントで異なるポートを使う（9222, 9223, 9224, 9225...）
- `--user-data-dir` も各アカウントで異なるフォルダを使う（ログイン状態が分離される）

### 3. `index.js` にアカウントを追加

```js
await processAccount("アカウント4", process.env.RAKUTEN_APP_ID4, 9225);
```

### 4. Chrome を起動してログイン

`account4.bat` を実行し、開いた Chrome ウィンドウで楽天ROOMにログインする。
一度ログインすれば `--user-data-dir` に保存されるため、以降は bat を実行するだけでよい。

### 5. Windowsスタートアップへの登録（任意）

`account4.bat` のショートカットを `shell:startup`（スタートアップフォルダ）に追加すると、PC起動時に自動でChromeが立ち上がる。

---

## GitHub Actions版（自動実行）

### セットアップ

#### 1. GitHub Secretsの登録
リポジトリの **Settings → Secrets and variables → Actions** で以下を登録：

| Secret名 | 説明 |
|---|---|
| `RAKUTEN_USER_ID` | アカウント1のユーザーID |
| `RAKUTEN_PASSWORD` | アカウント1のパスワード |
| `RAKUTEN_APP_ID` | アプリID（アカウント1/2共用） |
| `RAKUTEN_USER_ID2` | アカウント2のユーザーID |
| `RAKUTEN_PASSWORD2` | アカウント2のパスワード |
| `RAKUTEN_APP_ID2` | アプリID（RAKUTEN_APP_IDと同値でOK） |
| `ACCESS_TOKEN` | 楽天APIアクセストークン |
| `OPENAI_API_KEY` | OpenAI APIキー（USE_OPENAI=trueの場合） |

#### 2. Rakuten API IP制限の解除
GitHub ActionsのIPは毎回変わるため、楽天APIの開発者ポータルでIPアドレス制限を「全許可」にする必要がある。

#### 3. 手動実行でテスト
**Actions → 楽天ROOM自動投稿 → Run workflow**

### ログ確認
Actions の各実行ページでログを確認できる。
