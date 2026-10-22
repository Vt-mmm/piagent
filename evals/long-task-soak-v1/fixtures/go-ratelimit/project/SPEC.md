# ratelimit 仕様 v1

パッケージ `ratelimit`（モジュール `example.com/ratelimit`、Go 1.26、標準ライブラリのみ）。
時刻はすべて `Clock` インターフェース経由で取得します（`clock.go`、実装済み）。
テストでは `NewFakeClock` と `Advance` を使い、決して sleep しません。
すべてのリミッターと `Keyed` は並行に呼ばれても安全でなければなりません。

判定結果は `Decision{Allowed, Limit, Remaining, RetryAfter}`（`limiter.go`、実装済み）:

- `Limit`: リミッターの設定上限（バケット容量、またはウィンドウあたりの件数）。
- `Remaining`: このリクエストを処理した後、今すぐ許可できる残り件数。拒否時は 0。
- `RetryAfter`: 拒否時、次にリクエストが許可されるまでの時間。許可時は 0。

## 1. トークンバケット（`bucket.go`、既存・不具合あり）

`NewTokenBucket(capacity int, ratePerSecond float64, clock Clock)`。容量いっぱいの状態で始まり、
毎秒 `ratePerSecond` トークンずつ**連続的に**（端数も含めて）補充され、容量を超えません。
1 リクエストで 1 トークン消費します。

- 許可時: `Remaining` = 消費後のトークン数の切り捨て（`floor`）。
- 拒否時: `RetryAfter` = トークンが 1 に達するまでの時間
  `ceil((1 − tokens) / rate 秒)`（ナノ秒単位で切り上げ）。
- `Tokens() float64` は現時点の（補充後の）トークン数を端数込みで返します。

**既知の不具合（修正すること）**: 現在の実装は補充量を整数に切り捨てたうえで最終補充時刻を
進めてしまうため、短い間隔でリクエストが続くと補充の端数が毎回失われます。例えば
容量 2・毎秒 4 トークンのバケットを空にした後、125ms ごとにリクエストすると、本来は
2 回に 1 回許可されるはずが、一度も許可されません。`Tokens()` も端数を返しません。

## 2. スライディングウィンドウ（`window.go`、未実装）

`NewSlidingWindow(limit int, window time.Duration, clock Clock)`。許可したリクエストの時刻を記録し、
現在時刻 `now` に対して `now − t < window` を満たす記録（つまりちょうど `window` 前の記録は
期限切れ）だけを数えます。

- 数えた件数 `< limit` なら許可して `now` を記録。`Remaining = limit − 記録件数`。
- そうでなければ拒否（拒否したリクエストは記録しない）。
  `RetryAfter = 最も古い有効な記録 + window − now`。
- `limit < 1` または `window <= 0` なら panic。

## 3. クライアント単位の管理（`keyed.go`、未実装）

`NewKeyed(newLimiter func() Limiter, clock Clock, idleTTL time.Duration) *Keyed`。

- `Allow(key string) Decision`: キーごとのリミッターを（なければ `newLimiter()` で作って）使い、
  そのキーの最終利用時刻を `now` にします。キー同士は互いに影響しません。
- `Len() int`: 現在保持しているキーの数。
- `Sweep() int`: 最終利用から `idleTTL` 以上経過したキーを削除し、削除した数を返します。
  `idleTTL <= 0` の場合は何も削除しません。削除されたキーが再び来たら新しいリミッターで始まります。

## 4. ミドルウェア（`middleware.go`、未実装）

`Middleware(opts Options) func(http.Handler) http.Handler`。`Options`:

- `Store *Keyed`（必須。nil なら `Middleware` が panic）
- `KeyFunc func(*http.Request) string`（nil なら `ClientIP(r, opts.TrustProxy)`）
- `TrustProxy bool`
- `Exempt func(*http.Request) bool`（true を返したリクエストは制限もカウントもせず、
  ヘッダーも付けずにそのまま次のハンドラへ）

制限対象のリクエストごとに `Store.Allow(key)` を 1 回呼び:

- 常にレスポンスヘッダー `X-RateLimit-Limit`（`Limit`）と `X-RateLimit-Remaining`（`Remaining`）を付けます。
- 許可: 次のハンドラを呼びます（ヘッダーはハンドラが書き込む前に設定済み）。
- 拒否: 次のハンドラは呼ばず、ステータス `429`、`Retry-After` ヘッダー =
  `RetryAfter` を秒に切り上げた整数（最小 1）、`Content-Type: application/json`、
  本文は JSON `{"error":"rate_limited","retry_after":<同じ秒数>}`。

## 5. クライアント IP（`middleware.go`、未実装）

`ClientIP(r *http.Request, trustProxy bool) string`:

- `trustProxy` が true で `X-Forwarded-For` が空でなければ、カンマ区切りの最初の要素を
  前後の空白を除いて返します。
- それ以外は `r.RemoteAddr` からポートを除いたホスト部分（`"[::1]:8080"` → `"::1"`）。
  `RemoteAddr` にポートがなく分解できない場合はそのまま返します。

## 6. テスト

各節にテストを書き、README のコマンドで `go test ./...` と `go vet ./...` が通ること。
