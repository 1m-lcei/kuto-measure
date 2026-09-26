# 開発ルール

- gpt-6-astra を前提とし、一般的な開発手順の説明は省く。
- 既存実装と標準APIを優先し、必要最小限の変更にする。
- 画像・解析データはブラウザ内で処理し、外部送信しない。
- `.codegraph/` がある場合は、コード調査で検索・読み取りより先に CodeGraph を使う。なければ索引は作成しない。
- 検証は `bun run typecheck`、`bun run lint`、`bun run test`、`bun run build`。UI変更時はビルド後に `bun run test:browser` も実行し、実行できない検証は報告する。
- コミットは Conventional Commits 形式（例: `feat: add relative measurements`）にする。
- このファイルはプロジェクト固有の継続的な指示だけに限定する。作業履歴・一般論・重複説明を追加せず、詳細は README や docs に置き、必要以上に肥大化させない。
