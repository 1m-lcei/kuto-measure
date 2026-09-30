# 開発・検証・公開

Bun 1.4.2、Svelte 5、TypeScript、Viteを使用します。SvelteKitは使用しません。
実行時の追加依存はSvelteだけです。型検査には公式の `svelte-check` を使います。
現在の `svelte-check` がTypeScript 7単体に対応していないため、対応版のTypeScript 6を使用します。

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

UIと状態別の文言は `src/*.svelte` で編集します。`index.html` は起動用の最小HTMLです。
`App.svelte` が編集セッションと操作を管理し、`Panels.svelte`、`Header.svelte`、`Dialog.svelte`、`Annotations.svelte` がパネル・メニュー・ネイティブダイアログ・SVGを描画します。既存の `style.css` は共通で使用します。

履歴と画像は `$state.raw` で保持し、ドメインの不変データを深いProxyへ変換しません。パネルは確定済み文書、SVGはドラッグ中のプレビューを参照します。ポインター移動・ホイール・ピンチの表示更新は `requestAnimationFrame` にまとめ、pointerupでは最終座標を処理して1回だけ履歴へ確定します。
`viewport.svelte.ts` の倍率と表示位置は個別に追跡します。パン・選択・ホバーで投影やラベル配置を再計算せず、倍率・文書・投影が変わったときだけ必要な計算を実行します。SVGと一覧にはキー付きのSvelteループを使い、要素の全置換とフォーカス復元処理を廃止しています。

計測・画像読み込み・Undo/Redo・JSONの検証と保存形式は従来のTypeScriptモジュールを使います。`annotations.ts` の座標・円・ラベル配置計算を画面とPNGで共有し、`render.ts` の文字列SVGはPNG出力専用です。DOM参照はフォーカス、ネイティブダイアログ、ポインター捕捉、SVGの当たり判定などのブラウザAPIに限定します。

性能計測はビルド後に `bun run test:performance` で実行します。生成画像・24ピン・8測距線を使用し、画像を外部送信しません。測定条件、移行前後の結果と残る制約は [Svelte移行の検証記録](svelte-migration.md) を参照してください。

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
