# 開発・検証・公開

Bun 1.4.4、Svelte 5、TypeScript 6、Viteを使用します。実行時の依存はSvelteだけです。
型検査は `svelte-check` と `tsc`、TypeScriptの指定範囲は `^6.0.3` です。`svelte-check` の対応範囲に合わせ、TypeScriptは6系を使用します。
依存更新には `bun update --latest '!typescript'` を使用します。TypeScriptは互換性を確認してから個別に更新します。

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

`bun run test:browser` はビルド後、生成した`dist`を`/nested/`配下で配信し、Chromium・Firefox・WebKitで検証します。
Linuxではブラウザ準備に`--with-deps`を追加してください。
整形・安全なlint修正は`bun run format`で実行できます。

Windowsのパッケージ化アプリ内でFirefoxが `spawn UNKNOWN` やサイドバイサイド構成エラーにより起動できない場合は、AppDataの仮想化を避けるため、ブラウザをAppData外へ配置します。リポジトリがAppData外にある場合、PowerShellで次を実行してください。インストールとテストの両方に同じ環境変数が必要です。

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location).Path 'test-results\playwright-browsers'
bun x playwright install chromium firefox webkit
bun run test:browser
```

## 構成

`main.ts` が `App.svelte` を起動します。UIと状態別の文言は `src/*.svelte`、共通スタイルは `style.css` にあります。
`App.svelte` が編集セッションと操作を管理し、`Panels.svelte`、`Header.svelte`、`Dialog.svelte`、`Annotations.svelte` がパネル・メニュー・ネイティブダイアログ・SVGを描画します。

履歴と画像は `$state.raw` で保持し、ドメインの不変データを深いProxyへ変換しません。パネルは確定済み文書、SVGはドラッグ中のプレビューを参照します。ポインター移動・ホイール・ピンチの表示更新は `requestAnimationFrame` にまとめ、pointerupでは最終座標を処理して1回だけ履歴へ確定します。
`viewport.svelte.ts` の倍率と表示位置は個別に追跡します。パン・選択・ホバーで投影やラベル配置を再計算せず、倍率・文書・投影が変わったときだけ必要な計算を実行します。SVGと一覧はキー付きのSvelteループでノードとフォーカスを保持します。

計測・画像読み込み・Undo/Redo・JSONの検証と保存はTypeScriptモジュールが担当します。`annotations.ts` の座標・円・ラベル配置計算を画面とPNGで共有し、`render.ts` の文字列SVGはPNG出力専用です。DOM参照はフォーカス、ネイティブダイアログ、ポインター捕捉、SVGの当たり判定などのブラウザAPIに限定します。

## 保存と表示

localStorageにはテーマ設定、平行スナップの設定、明示的に保存した基準1件を別キーで保持します。平行スナップ設定は `kuto-measure.parallel-snap` に保存します。
基準は `kuto-measure.reference-preset` のversion 1で、基準円（地面座標の中心・地面半径・ゲーム内半径）とカメラ設定だけを含みます。
読み込み時に構造・数値を検証し、新画像の描画領域に適用できるか確認します。画像や編集全体は永続化しません。
別タブでの基準の保存変更は保存欄だけへ反映し、開いている画像には再適用しません。

ラベル配置は `src/labels.ts` の純粋関数で画面・PNG共通です。標準Canvasで文字寸法を計測し、画像座標を変えずCSSピクセルの矩形衝突を避けます。
小規模な注釈向けの逐次配置で、初期位置と最大256候補を採点します。配置しきれない場合は警告し、一覧での操作を維持します。
描画線との交差判定は `src/label-score.ts` と約1KBの同梱Wasmで共有します。線分方向・長さを配置ごとに計算し、`f64x2` SIMDで2線分ずつ判定します。候補順・採点式・早期打ち切りを保ち、画面とPNGで同じ結果を使います。
起動時にWasmを非同期で読み込み、準備前・取得失敗・非対応・メモリ確保失敗時はJavaScript実装を使います。画像や編集データを外部に送信しません。

ホバーとピンツールの薄表示はUI状態で、PNGや編集履歴に含めません。
ピンツールでは描画された図形・ラベルとカーソルが重なる対象をすべて薄くします。透明な選択用領域や円の塗りのない内部は対象外です。
`src/hover.ts` はSVG座標変換を1回求め、外接矩形と線幅の余白で候補を絞ります。図形は `isPointInFill` / `isPointInStroke`、文字は画面上の外接矩形で判定します。
子要素はSVGの共通変換を使い、線幅は最大4 CSS px（キーボードフォーカス時は4 SVG単位）、miter limitは4です。候補の余白は8 × max(1, SVG倍率) px、走査はO(N)です。

PNG保存はクリックのユーザー操作権限を保ったまま `showSaveFilePicker` を呼び、書き込み完了後に成功を表示します。非対応ブラウザでは通常のダウンロードを使います。ネイティブダイアログのキャンセル・失敗時にはダウンロードしません。
`tests/interactions.ts` はブラウザ検証から実行し、保存の分離、ラベル選択、PNGの命名・表示独立性を確認します。

## 性能計測

円の自動検出は専用Workerで処理します。SIMDモジュールは `wabt`（開発依存）で生成し、dev・test・buildから自動実行します。判定条件と制約は[円検出](circle-detection.md)を参照してください。

ビルド後に `bun run test:performance` で生成画像・24ピン・8距離線を測定します。ピン配置時のホバー判定は `bun tests/hover-performance.ts` で測定します。画像は外部送信しません。
測定条件と結果は [Svelte移行の検証記録](svelte-migration.md)、[ホバー判定の検証記録](hover-performance.md) を参照してください。
ラベル配置は `bun run build:wasm` 後に `bun tests/label-performance.ts` で旧実装・JavaScript改善版・SIMD版を比較できます。条件と結果は[ラベル配置の検証記録](label-performance.md)を参照してください。

## 公開

Aboutの版は `package.json` の `version` を唯一の取得元とします。`vite.config.ts` がビルド時にGitのHEADの短縮SHAも取得し、版とともに生成物へ埋め込みます。SHAは追跡ソースに固定せず、dirty表示も付けません。Gitコマンドやコミット情報を取得できない環境では版のみを表示します。

公開用のビルドはコミット後に行ってください。未コミットの変更を含むプレビューには、直前のHEADのSHAが表示されます。表示値はビルド時点で固定され、閲覧時にGitへアクセスすることはありません。

GitHubのリポジトリを接続し、Settings → Pages → Sourceを「GitHub Actions」に設定します。
PRとmainへのpushで検証し、mainで検証に成功した同一ビルドをPagesへ配信します。
Viteの相対baseを使うため、project siteのサブディレクトリにも対応します。
GitHubでの実配信はリポジトリ接続後に確認してください。

## 関連文書

目的別の参照先は[ドキュメント索引](README.md)から選んでください。
