# ADR 0012: 子セッションは llama.cpp 拡張を常に読み込み、親の agentDir を使う

- 状態: 採用
- 日付: 2026-10-12
- 対象: `createChildChannel` の拡張の読み込みと、子の認証情報の参照先

## 背景

- llama.cpp は API キーを使わず、`auth.json` の `LLAMA_BASE_URL` で接続先を決める。モデルの登録と認証は CLI の内蔵拡張 `builtin:llama.cpp` が行う。
- SDK の `createAgentSession` は内蔵拡張を読み込まない。子は llama.cpp の provider を持たず、llama.cpp のモデルを指定すると `No API key found for llama.cpp.` で失敗した。
- `createAgentSession` に `agentDir` を渡していなかったため、子は既定の agent dir の認証情報を読んでいた。親と違う環境を参照する潜在的な不一致もあった。
- ADR 0011 は、`extensions: true` の子に内蔵拡張の一部を与えると決めた。llama.cpp は `extensions` の値によらず親のモデルを子で使えるべきで、0011 の対象外である。

## 決定

1. 子の `DefaultResourceLoader` は、`extensions` の値によらず `builtin:llama.cpp` の拡張ファイルを `additionalExtensionPaths` で読み込む。`noExtensions: true` でも、名前で指定された拡張は読み込まれる。
2. `createAgentSession` に親と同じ `agentDir` を渡す。

ADR 0011 の決定は変えない。`extensions: true` の子に与える内蔵拡張の集合（`codemode` / `tool_search` / MCP）も変えない。

## 理由

- 拡張ファイルは SDK の公開 API（`additionalExtensionPaths`）で指定でき、CLI と同じ provider 登録が得られる。`import.meta.resolve` で SDK 内の実パスを解決するため、SDK の内部実装には依存しない。
- 実測で、この読み込みを入れると子の `llama.cpp` が認証済みになり、`prompt` が llama.cpp サーバーに届いて応答を返した（`pong`）。入れない場合は同じ呼び出しが `No API key found` で失敗した。
- `agentDir` の欠落は、子が親と違う認証情報を読む原因になる。親と同じ値を渡すのが親子の一貫性に必要。

## 帰結

- `extensions: false` の子でも、llama.cpp の provider が登録される。他の内蔵拡張（`codemode` / `tool_search` / MCP）は引き続き `extensions: true` のときだけ与える。
- 子の固定費は、llama 拡張が登録するツール分だけ増える可能性がある。実測の追加ツールは子の `activeTools` に依存する。
- llama 拡張は SDK の内蔵拡張であり、SDK を上げるとファイルパスが変わりうる。`import.meta.resolve` が失敗した場合は起動時に例外になる。テスト `test/integration/child-llama-auth.test.ts` が検出する。

## 代替案

| 代替 | 却下理由 |
|---|---|
| 子を `createAgentSessionServices` と `createAgentSessionFromServices` の CLI 経路に切り替える | 内蔵拡張の扱いを CLI と揃えられるが、`bindExtensions` の前提（ADR 0011）と子の起動経路を全面的に変える。今回の不具合の範囲を超える |
| 親の `ModelRuntime` を `modelRuntime` として子に渡す | 親と同じ provider を共有できるが、現在の `ExtensionContext` は `ModelRuntime` を公開しておらず、private フィールドに頼ることになる |
| `extensions: true` の子だけに llama 拡張を与える | llama 拡張を読まない子は親のモデルを使えず、`spawn_agents` の `model` 指定が既定の子で失敗する。拡張の有無で model の使用可否が変わるのは利用者に分かりにくい |
