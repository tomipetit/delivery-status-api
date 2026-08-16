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

#### 対象範囲（宛先地域のみ）

このAPIが返すのは**宛先地域（お届け先）に対する制限だけ**です。利用者の用途は「この住所へ送れるか」の判定であるため、地域を発地と着地で区別している情報源では、制限がかかっているのが着地側の行だけを返し、記録する地域も着地側の地域です。

- `全国 ⇒ 熊本県 下益城郡美里町、八代市…`（着地が制限対象）は返します。
- `熊本県 下益城郡美里町、八代市… ⇒ 全国`（発地が制限対象）は返しません。**ある地域「発」の荷物が全国どこ宛てでも止まる、という差出側だけの制限は対象外です。**
- ヤマト運輸の「左記地域を発着とするお荷物」は発地・着地の両方を含むため返します。`配達地`列も着地です。
- 佐川急便の「全国から上記地域へのお荷物のお預かり（荷受け）は停止」は着地の制限なので返します。ある地域からの発送だけを止める記事は返しません。

#### 地域の粒度（`prefecture` / `city` / `area`）

| `city` | `area` | 意味 |
| --- | --- | --- |
| `null` | `null` | その都道府県の全域 |
| `null` | 地域名 | その都道府県内の、市区町村ではない地域（島・諸島・地方名など）。例: `prefecture=鹿児島県, city=null, area=喜界島` |
| 市区町村名 | `null` | その市区町村の全域 |
| 市区町村名 | 地域名 | その市区町村の一部。例: `city=輪島市, area=門前町西円山・別所谷町` |

#### 郵便番号（`postalCodes` / `postalCodeLevel`）

各レコードには日本郵便の公式データ（KEN_ALL / 郵便番号データ）から引いた7桁の郵便番号を付けます。**郵便番号はAIに出力させません。**郵便番号は決定的なデータであり、モデルに尋ねると実在しないもっともらしい番号を返すためです。抽出後・保存前に、Workers自身がD1の`postal_codes`テーブルを引いて付与します。

| `postalCodeLevel` | `postalCodes` | 意味 |
| --- | --- | --- |
| `town` | 該当町域の郵便番号 | 情報源が示した町域名がKEN_ALLの町域と一致した |
| `city` | 市区町村全域の郵便番号 | 町域が示されていない、町域名が一致しない、または島名から市町村単位で解決した |
| `prefecture` | `[]`（空） | 都道府県全域。番号は列挙しません |
| `null` | `[]`（空） | 参照そのものに失敗した（マイグレーション0004適用前の既存行を含む） |

`prefecture`レベルで空配列を返すのは意図的です。都道府県全域の番号を列挙しても`prefecture`フィールドが持つ情報以上のものはなく、沖縄県だけで約800件、大きな県では数千件になります。`town`・`city`は全件を列挙します。

町域の照合は、まず`area`から括弧書き（例: `宝立町（大町泥木・大町・二艘丹）`）を除去し、`・`・`,`・`、`で分割したうえで、KEN_ALLの町域名と**前方一致を双方向**で判定します（情報源側が短い`門前町西円山` ⇔ KEN_ALL側が長い`門前町西円山ハ`、その逆も同じ場所を指すため）。

喜界島・徳之島・沖永良部島・与論島・奄美大島はKEN_ALLに町域として存在しないため、島を構成する市町村（例: 喜界島 → 大島郡喜界町）を経由して解決し、レベルは`city`になります。この対応表は`src/postal/islands.ts`に手作業で管理する定数として置いています。沖永良部島と与論島は8919で始まる番号を共有するため、番号の接頭辞では分離できません。

郵便番号の付与はあくまで付加情報です。参照に失敗しても配送停止情報そのものは失われず、同期も失敗しません（`postalCodes`が空、`postalCodeLevel`が`null`になるだけです）。

`area`は必ずしも`city`を伴いません。喜界島・徳之島・奄美大島のように市区町村ではない地域が制限対象になる場合、島名などを`area`に入れ`city`は`null`にします。情報源が示していない市区町村名（例: 喜界島 → 大島郡喜界町）へ変換することはありません。逆に、市区町村の下位として示された町名は必ずその市区町村を`city`に伴います。

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
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...
```

`wrangler.jsonc`では、ヤマト運輸・佐川急便の取得済み本文の正規化と、日本郵便の公式PDFからの抽出に使うモデルを`OPENAI_MODEL`に設定します。既定値は`gpt-5.6-terra`です。Responses APIで`input_file`によるPDF入力を扱えるモデルIDを指定してください。

本番環境のsecretはWranglerから登録します。

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put API_KEY
npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
```

## トークン使用量の日次レポート

日次同期のあと、前日（JST）のトークン使用量をGoogle Chatに投稿します。使用量は呼び出しごとに`token_usage`テーブルへ記録されるため、Workers Logsの保持期間に依存しません。手動同期（`POST /api/v1/sync`）の分も同じように記録され、翌朝のレポートに含まれます。

対象を「前日」にしているのは、その日が閉じているからです。当日を対象にすると、レポート送信後に走った手動同期の課金がどのレポートにも現れません。

Google Chatの対象スペースで **アプリと統合 → Webhook** から Incoming Webhook を作成し、URLをsecretとして登録します。URLは`key`と`token`をクエリに含む認証情報なので、`wrangler.jsonc`には置きません。

```bash
npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL
```

未設定の場合はレポートを送らずログに警告を出すだけで、同期には影響しません。

### 推定コスト

レポートにはトークン数から算出した推定コストが入ります。単価は`wrangler.jsonc`の`vars`で設定し、レポート本文にも使用した単価が印字されるので、値が古くなった場合に本文から気づけます。

```jsonc
"OPENAI_PRICE_INPUT_USD_PER_MTOK": "2",
"OPENAI_PRICE_CACHED_INPUT_USD_PER_MTOK": "0.2",
"OPENAI_PRICE_OUTPUT_USD_PER_MTOK": "12"
```

Responses APIの`usage`は入れ子の内訳を親に含めます。`cached_tokens`は`input_tokens`の一部、`reasoning_tokens`は`output_tokens`の一部です。したがって計算は「(input − cached) × input単価 + cached × cached単価 + output × output単価」で、reasoningを別途加算しません（加算すると推論分を二重に計上します）。

長文脈ティア（入力272Kトークン超で単価が変動）は計算に入れていません。抽出の入力は`EXTRACTION_INPUT_CHARACTER_LIMIT`で大きく下回るためです。あくまで推定であり、正確な請求額はOpenAIの明細が正です。

レポートは使用量が0の日も投稿します。全ソースが無変更ならモデルは呼ばれず0トークンになるのが正常で、その場合は「モデル呼び出しはありませんでした」と明記されます。投稿が来ないこと自体がcron停止のシグナルになります。同期が失敗した日は見出しに`⚠️ 同期失敗`が付き、失敗したキャリアと理由が並びます。

## 郵便番号データの取り込み

郵便番号の付与には日本郵便の公式データ（KEN_ALL, UTF-8版・約124,500行）が必要です。マイグレーション`0004_postal_codes.sql`を適用したうえで、一度だけ取り込みます。

```bash
npm run postal:import
npm run postal:import -- --remote
npm run postal:import -- --dry-run
```

ZIPをダウンロードして展開し、`postal_codes`テーブルを丸ごと入れ替えます。追加の依存パッケージや`unzip`コマンドは使わず、ZIPのヘッダーを自前で解析して`zlib`で展開します。1文には収まらないため、SQLファイルを分割して`wrangler d1 execute --file`で順に流し、進捗を表示します。途中で失敗した場合はテーブルが不完全な状態になりますが、この処理は全件置き換えなので、そのまま再実行すれば復旧します。`--dry-run`はダウンロードと解析だけを行い、DBには一切書き込みません。

`--remote`を付けない限りローカルDBが対象で、実行時は対象DB（`LOCAL` / `REMOTE (production)`）を必ず出力します。

取り込み後の更新はWorkersが行います。毎月1日18:00 UTC（日本時間2日03:00）のCron Triggerで、その月の差分ファイル`utf_add_YYMM.zip`・`utf_del_YYMM.zip`を取得し、削除→追加の順に適用します（毎月4〜6行程度）。差分ファイルの展開にはWorkersの`DecompressionStream("deflate-raw")`を使い、こちらも依存パッケージを増やしていません。その月のファイルがまだ公開されていない場合（404）は正常な「何もしない」として扱います。この月次ジョブは全体をtry/catchで囲んであり、失敗しても日次の配送情報同期には影響しません。

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

Cron Triggerは2本あります。

```text
0 0 * * *    配送情報の同期（毎日09:00 日本時間）
0 18 1 * *   郵便番号データの月次更新（毎月2日03:00 日本時間）
```

`scheduled`ハンドラーは`controller.cron`で処理を振り分けるため、日次の同期と月次の郵便番号更新が同じ実行に混ざることはありません。Cloudflare Cron TriggersはUTC基準です。

## Structure

```text
src/
├── ai/
│   └── terra.ts
├── notify/
│   └── usage-report.ts
├── postal/
│   ├── islands.ts
│   ├── ken-all.ts
│   ├── lookup.ts
│   ├── refresh.ts
│   └── zip.ts
├── scrapers/
│   ├── html.ts
│   ├── sagawa.ts
│   └── yamato.ts
├── source-fingerprint.ts
├── storage/
│   ├── api-keys.ts
│   ├── restrictions.ts
│   ├── source-articles.ts
│   ├── source-states.ts
│   └── token-usage.ts
├── types/
│   └── restriction.ts
├── index.ts
├── sync.ts
└── tokyo-day.ts

scripts/
├── api-key.mjs
├── postal-codes.mjs
└── run-tests.mjs
```

`src/postal/`は郵便番号の付与だけを担当します。`lookup.ts`が町域・市区町村・島・都道府県の順に解決し、`islands.ts`が島と市町村の対応表、`ken-all.ts`がCSVの解析、`zip.ts`がWorkers側のZIP読み取り、`refresh.ts`が月次差分の適用です。ZIPヘッダーの解析は`scripts/postal-codes.mjs`にも同じ内容があります（Node側は`zlib`、Workers側は`DecompressionStream`を使うため）。

`tokyo-day.ts`は日本時間のカレンダー日判定を提供し、同期の「今日は確認済みか」、APIキーの`last_used_at`更新、使用量レポートの対象日の決定で共有します。

`src/notify/usage-report.ts`は日次レポートの組み立てと投稿だけを担当します。`src/ai/terra.ts`は課金された呼び出しごとに`TokenUsageSink`へ実績を渡し、`syncAll`がそれをまとめて`token_usage`へ書きます。terra側にストレージ依存を持たせないのは、cronと手動同期が同じisolateで同時に走った場合にモジュールレベルの集計だと両者が混ざるためです。

## Known limitations

- 佐川急便は1日1回、公式の重要なお知らせXMLを取得します。Web検索は使わず、新規記事または公式XMLのタイトル・公開日が変わった記事の本文だけをAIで正規化します。日本郵便はPDFが変わった場合だけ、そのPDFを添付した抽出を1回実行します。検索ツールは使わないため、検索ツールの利用料は発生しません。
- 日本郵便は公式PDFのURLを直接取得して読むため、検索インデックスへの登録状況には依存しません。ただしPDFのURLや形式が変わった場合は同期失敗として既存データを保持します。佐川急便は公式XMLの構造に依存するため、配信形式が変わった場合は同期失敗として既存データを保持します。
- ヤマト運輸でAI抽出結果が0件になった場合は、「停止地域なし」を直接証明できないため既存データを保持します。
- 郵便番号は情報源が示した地域名の粒度までしか特定できません。町域名がKEN_ALLと一致しない場合は市区町村全域、都道府県のみの情報は`prefecture`レベル（空配列）になります。番地単位の除外や「一部地域」といった記述は郵便番号では表現できません。
- 月次更新はその月の差分ファイルだけを取得します。公開前にジョブが動いた月は取り込まれないため、長期運用では`npm run postal:import`での再取り込みを定期的に行うのが確実です。
- D1の変更履歴、同期失敗通知、APIのレート制限は未実装です。ただしクライアントキーの導入でリクエストの発行元を特定できるようになったため、キー単位のレート制限は実装可能になりました（本リポジトリでは未実装）。
- クライアントキーはSHA-256ハッシュのみを保存します。平文を復元する手段はないため、紛失時は失効・再発行で対応します。
