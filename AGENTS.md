# 開発ルール

- 既存実装と標準APIを優先し、必要最小限の変更にする
- 画像・編集データはブラウザ内で処理し、外部送信しない
- README は概要と基本的な使い方に絞り、機能追加・改修のたびに更新しない。概要や基本操作に変更がある場合に更新し、細かな仕様は docs に記載する
- `.codegraph/` がある場合は、コード調査で検索・読み取りより先に CodeGraph を使う。なければ索引は作成しない
- 検証は `bun run typecheck`、`bun run lint`、`bun run test`、`bun run build`。UI変更時はビルド後に `bun run test:browser` も実行し、実行できない検証は報告する
- コミットは Conventional Commits 形式（例: `feat: add relative measurements`）にする
- push は自動デプロイを伴うため、対象の変更に対するユーザーの明示的な許可を得てから実行する。過去の push 許可を別の変更に引き継いだり、修正依頼から push 許可を推定したりしない
- このファイルはプロジェクト固有の継続的な指示だけに限定する。作業履歴・一般論・重複説明を追加せず、詳細は README や docs に置き、必要以上に肥大化させない
