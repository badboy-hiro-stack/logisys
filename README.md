# logisys(市場入出荷検品システム)

要件定義書に基づくNext.js + Supabaseのプロジェクト雛形です。

## セットアップ手順

### 1. 依存パッケージをインストール

```bash
npm install
```

### 2. Supabaseにテーブルを作成

1. Supabaseのプロジェクト画面を開く
2. 左メニューの「SQL Editor」を開く
3. このリポジトリの `supabase/schema.sql` の中身を全部コピーして貼り付け、実行する
4. 実行が成功すると、マスタテーブル(仕入先・店舗・拠点)に初期データが入った状態でテーブル一式ができる

### 3. 環境変数を設定

1. `.env.local.example` をコピーして `.env.local` を作る
2. Supabaseのプロジェクト画面 → Settings → API Keys から、Project URL・publishable key・secret key を確認してそれぞれ貼り付ける
3. OCR機能を使う場合は、Anthropic ConsoleでAPIキーを発行し `ANTHROPIC_API_KEY` に設定する

### 4. ユーザーを作成

今はまだ管理画面からユーザーを追加する機能を作っていないので、最初の管理者アカウントは手動で作成します。

1. Supabaseのプロジェクト画面 → Authentication → Users → 「Add user」でユーザーを作成(例:メールアドレス `saito@logisys.local`、パスワードを設定)
2. SQL Editorで、作成したユーザーに対応する `m_users` の行を追加する

```sql
insert into m_users (user_id, user_name, role, location_id, is_active)
values (
  '(Authenticationの画面に表示されているUser UID)',
  '斉藤 一郎',
  '管理者',
  1,
  true
);
```

3. ログイン画面では、ログインIDの欄に `saito`(`@logisys.local` より前の部分)を入力すればログインできる

### 5. ローカルで起動して確認

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開き、ログイン画面が表示されることを確認してください。

### 6. GitHubにpush、Vercelへデプロイ

```bash
git add .
git commit -m "Initial scaffold"
git push
```

Vercelのプロジェクト画面で、このGitHubリポジトリをインポートし、`.env.local` と同じ環境変数をVercelの Settings → Environment Variables にも設定してください(Supabase公式のVercel連携を使えば、Supabase側の変数は自動で同期されます)。

## 現在の状態

- ログイン画面:実装済み(Supabase Authでログイン、拠点選択あり)
- ナビゲーション(サイドバー):実装済み
- 本日の進捗/入荷・ラベル発行/出荷検品/当日変更・欠品 報告/マスタ管理:仮ページ(次の開発ステップで実装)

## ディレクトリ構成

```
app/
  login/              ログイン画面
  (dashboard)/        ログイン後の画面(共通レイアウト付き)
    progress/         本日の進捗
    inbound/          入荷・ラベル発行
    outbound/         出荷検品
    reports/          当日変更・欠品 報告
    master/           マスタ管理
lib/supabase/         Supabase接続まわり(クライアント/サーバー/ミドルウェア)
supabase/schema.sql   データベーススキーマ(Supabase SQL Editorで実行する)
```
