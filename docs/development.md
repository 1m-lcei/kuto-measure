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

localStorageにはテーマ設定と、明示的に保存した基準1件を別キーで保持します。
基準は `kuto-measure.reference-preset` のversion 1で、基準円（地面座標の中心・地面半径・ゲーム内半径）とカメラ設定だけを含みます。
読み込み時に構造・数値を検証し、新画像の描画領域に適用できるか確認します。画像やピン等の編集全体は永続化しません。
別タブの保存変更は保存欄だけへ反映し、開いている画像には再適用しません。

ラベル配置は `src/labels.ts` の純粋関数で画面・PNG共通です。文字寸法は標準Canvasで計測します。
画像座標を変えず、CSSピクセルでの矩形の衝突を避けてラベルを配置します。
小規模な注釈向けの逐次配置で、1ラベル最大256候補です。配置しきれない場合は警告し、一覧での操作を維持します。
ホバーとピンツールの薄表示はUI状態で、PNGや編集履歴に含めません。
ピンツールでは描画された図形・ラベルとカーソルが重なる対象だけを薄くします。選択用の透明な当たり判定や円の内部は対象外です。
PNG保存はクリックのユーザー操作権限を保ったまま `showSaveFilePicker` を呼び、書き込み完了後に成功を表示します。非対応ブラウザでは独自ダイアログを出さず通常のダウンロードを使い、ネイティブダイアログのキャンセル・失敗時にはダウンロードへ移行しません。
`tests/interactions.ts` は既存のブラウザ検証から実行し、保存の分離、ラベル選択、PNGの命名・表示独立性を確認します。
