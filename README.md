# delivery-status-api

ヤマト運輸・佐川急便・日本郵便の配送停止／制限情報を定期取得し、正規化してAPIで提供するCloudflare Workersプロジェクトです。

## Stack

- Cloudflare Workers
- Cron Triggers
- D1
- Browser Rendering（佐川急便向け）
- OpenAI API / Terra
- TypeScript

## Endpoints

### Health check

```http
GET /health
```

### 配送停止情報

```http
GET /api/v1/restrictions
Authorization: Bearer <API_KEY>
```

配送会社で絞り込みできます。

```http
GET /api/v1/restrictions?carrier=yamato
GET /api/v1/restrictions?carrier=sagawa
GET /api/v1/restrictions?carrier=japan_post
```

### 手動同期

```http
POST /api/v1/sync
Authorization: Bearer <API_KEY>
```

通常はCron Triggerから自動実行します。

## Setup

```bash
npm install
```

D1データベースを作成します。

```bash
npx wrangler d1 create delivery-status-db
```

返された `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` に設定してください。

マイグレーションを実行します。

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

ローカル開発用のsecretを作成します。

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` に以下を設定します。

```env
OPENAI_API_KEY=sk-...
API_KEY=change-me
```

`wrangler.jsonc` の `OPENAI_MODEL` には利用するTerraのAPIモデルIDを設定してください。

本番環境のsecretはWranglerから登録します。

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put API_KEY
```

## Development

```bash
npm run dev
```

Cron Triggerのローカルテストも有効になります。

```bash
curl http://localhost:8787/__scheduled
```

API確認例:

```bash
curl \
  -H 'Authorization: Bearer change-me' \
  http://localhost:8787/api/v1/restrictions
```

## Deploy

```bash
npm run deploy
```

初期設定では6時間ごとに同期します。

```text
0 */6 * * *
```

Cloudflare Cron TriggersはUTC基準です。

## Structure

```text
src/
├── ai/
│   └── terra.ts
├── scrapers/
│   ├── japan-post.ts
│   ├── sagawa.ts
│   └── yamato.ts
├── storage/
│   └── restrictions.ts
├── types/
│   └── restriction.ts
├── index.ts
└── sync.ts
```

## Notes

現在は初期実装です。特に以下は本番投入前に追加・調整する予定です。

- 各社ページから必要部分だけを抽出してAI入力tokenを削減
- 佐川急便のお知らせ一覧から配送影響記事だけを追跡
- 前回取得内容のhash比較によるTerra呼び出し抑制
- OpenAI Structured OutputsによるJSON schema固定
- D1更新時の差分管理・履歴保存
- APIのレート制限
- 取得失敗時のログ・通知
