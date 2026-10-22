# ratelimit

HTTP API 用のレート制限ミドルウェア（Go 標準ライブラリのみ）。
トークンバケットとスライディングウィンドウの 2 種類のリミッター、クライアント単位の
リミッター管理、`net/http` のミドルウェアを提供します。仕様は `SPEC.md` を参照してください。

## テストの実行

このマシンには Go をインストールしていません。テストは Docker で実行します
（イメージ `golang:1.26.3-alpine3.23` は取得済み）:

```bash
docker run --rm -v "$PWD":/src -w /src golang:1.26.3-alpine3.23 go test ./...
docker run --rm -v "$PWD":/src -w /src golang:1.26.3-alpine3.23 go vet ./...
```

外部モジュールは使いません（標準ライブラリのみ、ネットワーク不要）。
テストは `FakeClock` を使い、`time.Sleep` に頼らないこと。
