# pi-antigravity-ls-provider

pi-coding-agent のプロバイダー拡張。Google Antigravity の Language Server（LS）を
`antigravity-client` 経由で直接 ConnectRPC で駆動し、Antigravity モデルを pi の
`/model` から選んで使えるようにする。agy / ACP は使用しない。

## 特徴

- **ビルトインツール全無効化**: Antigravity の `runCommand` / `write_file` 等は
  一切使わず、ツール実行は全て pi のツールループ経由（pi-rewind-cp が追跡可能）
- **pi 全ツールを MCP で公開**: builtin（read / write / edit / bash 等）と拡張機能の
  ツールを、pi 内の Streamable HTTP MCP サーバー経由で Antigravity に提供
- **システムプロンプト排除**: Antigravity ビルトインのプロンプト 11 セクションを
  削除し、pi のシステムプロンプトのみを注入
- **履歴の巻き戻し対応**: pi のツリーナビゲーション / rewind 拡張で履歴を戻すと、
  `revertToCascadeStep` で Antigravity 側の会話も巻き戻る
- **モデル動的取得 / トークン usage**: `getAvailableModels()` でモデル一覧を取得し、
  ターンごとのトークン使用量を pi に反映

## インストール

```bash
pi install /path/to/pi-antigravity-ls-provider
# または npm install して settings.json の packages に index.ts を追加
```

依存の `antigravity-client` は GitHub から取得される（`.npmrc` の `allow-git=all` と
`package.json` の `allowScripts` により自動ビルドされる）。上流は一切改変しない。
更新は `package.json` の commit ハッシュを差し替えて `npm install` するだけ。

## 使い方

```
/model ag-ls/Gemini_4_Argon_Medium
```

以降は pi の通常のチャットとして使える。`/agls doctor` で接続状態を確認できる。

## 既知の制約

- bash ツール経由のファイル変更は pi-rewind-cp の設計上チェックポイントされない
- LS は Antigravity アプリの認証（state.vscdb）を必要とする

## License

MIT
