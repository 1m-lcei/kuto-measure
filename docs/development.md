# 開発・検証・公開

Bun 1.4.2を使用します。ブラウザ実行時の依存ライブラリはありません。

```sh
bun install --frozen-lockfile
bun run dev
```

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun x playwright install chromium firefox webkit
bun run test:browser
```

ブラウザテストは実際の`dist`を`/nested/`配下で配信し、Chromium・Firefox・WebKitで検証します。
Linuxではブラウザ準備に`--with-deps`を追加してください。
整形・安全なlint修正は`bun run format`で実行できます。

## 公開

GitHubのリポジトリを接続し、Settings → Pages → Sourceを「GitHub Actions」に設定します。
PRとmainへのpushで検証し、mainで検証に成功した同一ビルドをPagesへ配信します。
Viteの相対baseを使うため、project siteのサブディレクトリにも対応します。
GitHubでの実配信はリポジトリ接続後に確認してください。

数学的前提と状態境界は[幾何モデル](geometry.md)を参照してください。
測距の考え方、画像の比較結果、誤差の切り分けは[測距の仕組み](measurement.md)を参照してください。
採用した校正値、画像との比較、表示領域の前提は[校正の記録](calibration/README.md)に保存しています。

テーマ設定のみをlocalStorageに保存します。画像と解析内容は永続化しません。
