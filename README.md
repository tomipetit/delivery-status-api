# delivery-status-api

ヤマト運輸・佐川急便・日本郵便の配送停止／制限情報を定期取得し、正規化してAPIで提供するCloudflare Workersプロジェクトです。

## Stack

- Cloudflare Workers
- Cron Triggers
- D1
- OpenAI Responses API（AI抽出・PDF添付）
- TypeScript

## Architecture

配送会社ごとに公式情報の取得方法を分けています。

- ヤマト運輸: 公式の配送状況ページをWorkersから直接取得し、停止セクションの内容が前回から変わった場合だけAIで正規化
- 佐川急便: 公式サイトが配信している重要なお知らせのXML（`sagawa_xml/importance/importance_list.xml`と記事ごとの`importance_detail_<番号>.xml`）をWorkersから直接取得。掲載中の全記事が対象になるため、新しい`information/detail/<番号>/`にも自動で追従し、新規・更新記事の本文だけをAIで正規化
- 日本郵便: 公式`unkou.pdf`を直接取得してSHA-256を比較し、PDFが変わった場合だけ取得済みのPDFそのものをResponses APIに添付してAIで抽出（Web検索は使用しません）

取得元のSHA-256または現行記事集合の安定した指紋、参照URL、最終確認日時・最終変更日時をD1の`carrier_source_states`へ保存します。佐川急便はさらに`carrier_source_articles`へ記事ごとの指紋と正規化結果を保存します。佐川急便の記事指紋は公式XMLのURL・タイトル・公開日から作るため、内容が変わらない限り実行ごとに変化しません。同じ日本時間の日に手動同期を繰り返した場合は外部取得自体を省略します。別の日でもヤマト運輸の停止セクションまたは日本郵便のPDFが同一ならAI抽出を省略します。佐川急便の記事集合が変化しても、指紋が変わらない現行記事は保存済み結果を再利用し、新規・更新記事だけをAI抽出します。掲載から消えた記事の結果は統合対象から除外します。保存・公開する佐川急便の出典URLは利用者が閲覧できる一覧ページと記事ページで、XMLエンドポイントは内部実装として保存しません。Cloudflare Browser Renderingのbindingは使用しません。

日本郵便のPDF抽出結果は次のいずれかとして判定されます。

- `active_restrictions_found`: PDFから現在有効な停止地域を確認し、取得結果でD1を更新
- `no_active_restrictions`: PDF全体を読んだうえで現在有効な停止地域がないことを確認し、該当会社の既存データを空に更新
- `unreadable`: PDFを読み取れないため同期失敗とし、該当会社の既存データを保持

判定と件数が矛盾する応答（例: `active_restrictions_found`なのに0件）、HTTP/APIエラー、不完全・不正な応答も同期失敗として扱い、既存データを保持します。出典URLはWorkersが自ら取得した公式PDFのURLで固定するため、モデルが返したURLは使用しません。

佐川急便も同様にWeb検索を使わず、公式XMLの取得・解析・AI抽出のいずれかが失敗した場合は同期失敗として既存データを保持します。公式一覧XMLから記事を1件も解析できなかった場合も、レイアウト変更を「掲載なし」と誤認して既存データを消さないよう失敗として扱います。一方で、解析できた全記事を読んだ結果として停止情報が0件だった場合は確定的な結果としてそのまま保存します。

## Endpoints

認証は`Authorization: Bearer <キー>`で行います。キーには2種類あります。

| 種類 | 保管場所 | `GET /api/v1/restrictions` | `POST /api/v1/sync` |
| --- | --- | --- | --- |
| 管理キー（`API_KEY`） | Workers secret | 可 | 可 |
| クライアントキー | D1の`api_keys` | 可 | 403 Forbidden |

`POST /api/v1/sync`は管理キー専用です。同期はOpenAI APIの費用が発生し、各社の公式サイトへも接続するため、利用者へ渡すキーから実行できないようにしています。認証に失敗した場合（未知のキー・失効済みのキー・ヘッダーなし・形式不正）はすべて401を返します。キー照合中にD1がエラーになった場合も認可せず401とします。

`API_KEY`は管理キーとして残します。クライアントキーが1本もない場合や、すべて失効させた場合の復旧経路になります。

### Health check

認証不要です。

```http
GET /health
```

### 配送停止情報

```http
GET /api/v1/restrictions
Authorization: Bearer <管理キーまたはクライアントキー>
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
Authorization: Bearer <管理キー>
```

クライアントキーで呼び出した場合は403を返します。

```json
{ "error": "Forbidden" }
```

通常はCron Triggerから1日1回自動実行します。手動同期にも同じ差分キャッシュが適用されます。

成功時は会社ごとの保存件数を返します。

```json
{
  "ok": true,
  "counts": {
    "yamato": 4,
    "sagawa": 2,
    "japan_post": 0
  }
}
```

一部の会社で同期に失敗した場合はHTTP 502と`failures`を返します。成功した会社の更新は保存され、失敗した会社の既存データは保持されます。

## Setup

```bash
npm install
```

D1データベースを作成します。

```bash
npx wrangler d1 create delivery-status
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

`wrangler.jsonc`では、ヤマト運輸・佐川急便の取得済み本文の正規化と、日本郵便の公式PDFからの抽出に使うモデルを`OPENAI_MODEL`に設定します。既定値は`gpt-5.6-terra`です。Responses APIで`input_file`によるPDF入力を扱えるモデルIDを指定してください。

本番環境のsecretはWranglerから登録します。

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put API_KEY
```

## APIキーの管理

利用者ごとのクライアントキーはD1の`api_keys`テーブルで管理し、CLIから発行・一覧・失効します。HTTPの管理用エンドポイントは用意していません。

本番でクライアントキーを使う前に、マイグレーション`0003_api_keys.sql`を適用してください。適用前は`api_keys`が存在せず、クライアントキーでの認証は行えません（管理キーは従来どおり利用できます）。

```bash
npm run db:migrate:remote
```

### 発行

```bash
npm run key:issue -- --name "shop-a"
npm run key:issue -- --name "shop-a" --remote
```

`dsa_live_`で始まるキーを生成し、平文はこのときだけ表示します。接頭辞はログやシークレットスキャナーで識別しやすくするためのものです。

```text
target: LOCAL database "delivery-status"

issued API key for "shop-a" (id 1)
target: LOCAL database "delivery-status"

dsa_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

D1にはSHA-256ハッシュだけを保存します。平文は保存も記録もしないため、後から取り出すことはできません。**紛失した場合は復旧ではなく、失効させて再発行します。**

### 一覧

```bash
npm run key:list
npm run key:list -- --remote
```

`id`・`name`・`created_at`・`revoked_at`・`last_used_at`を表示します。ハッシュしか保存していないため、キー本体が表示されることはありません。`last_used_at`は日本時間の日付単位で更新するため、同じ日に何度呼び出されても書き込みは1回です。

### 失効

```bash
npm run key:revoke -- --id 1
npm run key:revoke -- --name "shop-a" --remote
```

`revoked_at`を設定します。失効済みのキーや存在しないキーを指定した場合はエラーとして報告し、何も変更しません。失効後のキーでのリクエストは401になります（403ではありません）。

`--remote`を付けない限り、すべてローカルDBが対象です。実行時は対象DB（`LOCAL` / `REMOTE (production)`）を必ず出力します。

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
curl -X POST \
  -H 'Authorization: Bearer change-me' \
  http://localhost:8787/api/v1/sync

curl \
  -H 'Authorization: Bearer change-me' \
  http://localhost:8787/api/v1/restrictions
```

会社別の結果は`carrier`クエリで確認できます。

```bash
curl \
  -H 'Authorization: Bearer change-me' \
  'http://localhost:8787/api/v1/restrictions?carrier=sagawa'
```

## Deploy

```bash
npm run deploy
```

初期設定では毎日09:00（日本時間）に同期します。

```text
0 0 * * *
```

Cloudflare Cron TriggersはUTC基準です。

## Structure

```text
src/
├── ai/
│   └── terra.ts
├── scrapers/
│   ├── html.ts
│   ├── sagawa.ts
│   └── yamato.ts
├── source-fingerprint.ts
├── storage/
│   ├── api-keys.ts
│   ├── restrictions.ts
│   ├── source-articles.ts
│   └── source-states.ts
├── types/
│   └── restriction.ts
├── index.ts
├── sync.ts
└── tokyo-day.ts

scripts/
├── api-key.mjs
└── run-tests.mjs
```

`tokyo-day.ts`は日本時間のカレンダー日判定を提供し、同期の「今日は確認済みか」とAPIキーの`last_used_at`更新の両方で共有します。

## Known limitations

- 佐川急便は1日1回、公式の重要なお知らせXMLを取得します。Web検索は使わず、新規記事または公式XMLのタイトル・公開日が変わった記事の本文だけをAIで正規化します。日本郵便はPDFが変わった場合だけ、そのPDFを添付した抽出を1回実行します。検索ツールは使わないため、検索ツールの利用料は発生しません。
- 日本郵便は公式PDFのURLを直接取得して読むため、検索インデックスへの登録状況には依存しません。ただしPDFのURLや形式が変わった場合は同期失敗として既存データを保持します。佐川急便は公式XMLの構造に依存するため、配信形式が変わった場合は同期失敗として既存データを保持します。
- ヤマト運輸でAI抽出結果が0件になった場合は、「停止地域なし」を直接証明できないため既存データを保持します。
- 郵便番号の付与、D1の変更履歴、同期失敗通知、APIのレート制限は未実装です。ただしクライアントキーの導入でリクエストの発行元を特定できるようになったため、キー単位のレート制限は実装可能になりました（本リポジトリでは未実装）。
- クライアントキーはSHA-256ハッシュのみを保存します。平文を復元する手段はないため、紛失時は失効・再発行で対応します。
