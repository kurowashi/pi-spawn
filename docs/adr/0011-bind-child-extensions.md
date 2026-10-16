# ADR 0011: 子セッションの拡張を bind して、CLI 内蔵拡張を子にも与える

- 状態: 採用（決定 2 の対象は `extensions: true` の子のみ。llama.cpp 拡張は別の決定として ADR 0012 で扱う）
- 日付: 2026-10-12
- 対象: `createChildChannel` の拡張の読み込みと `session_start` の発火

## 背景

- `createAgentSession` は `session_start` を発火しない。SDK がイベントを保持し、`session.bindExtensions(bindings)` を呼ぶまで保留する。発火元は `bindExtensions` と `/reload` だけである。
- pi-spawn は子セッションを `bindExtensions` せずに作成していた。そのため子のどの拡張フックも実行されず、拡張が登録したツールがすべて active のまま残った。
- 害はエラーではなく静かな税である。ツールのスキーマが run の毎リクエストで再送される。pi-exa を読み込んだ子では exa 13本(5,534 トークン/リクエスト)で、設計の core グループ 1本(314 トークン)に比べ 3.44 倍になる。
- 抜けているのは `session_start` のハンドラだけである。`before_agent_start` と `context_with_system` はリクエスト時に出るため、pi-switch は preamble を削りながらツールの無効化だけを飛ばす。「セクションは効くがツールの無効化が効かない」という非対称な症状になる。
- 0.87.1 には `bindExtensions` がある。ただし `createMcpExtension` / `createToolSearchExtension` / `createCodemodeExtension` も `mcp.json` の処理も無く、SDK セッションから MCP サーバーを接続できない。AGENTS.md の手動確認項目 2(MCP ツールを子から呼べる)は構造的に成立していなかった。

## 決定

1. `createAgentSession` の直後に `await session.bindExtensions({})` を呼ぶ。
2. `extensions: true` の子には、CLI と同じ内蔵拡張(`codemode` / `tool_search` / MCP)を `extensionFactories` で与える。
3. pi-spawn の開発依存の SDK を 0.87.1 から 1.0.3 上げる。

## 理由

- 拡張系の既定は「登録したフックが走る」ことである。`bindExtensions` の呼び忘れは静かな逸脱であり、利用側が SDK の版ごとに臨補に満たすべき契約ではない。
- CLI が常に持つ内蔵拡張を子に与えないと、`extensions: true` の意味があいまいになる。定義は「親と同じ環境で使う」ことを求めている。
- 0.87.1 では 2 ができない。1 だけでは子里の MCP が得られないため、合わせて上げる。

## 帰結

- 子セッションのツール面が親と同じになる。実測で exa 13本/計23ツールが、1リクエスト経過後に exa 1本/計13ツールになる。
- 子で MCP サーバーが接続する。`exposure: deferred` のサーバーでは `tool_search` が有効化される。
- SDK を上げたことで `ToolDefinition.execute` の第 5 引数が `ExtensionContext` から `ExtensionToolContext` に変わった。テストの偽コンテキストの型を変更した(実装側は影響なし)。
- 子のツール数が増える分、子セッションの固定費は増える。`extensions: true` の定義は、多数登録するプラグイン群との併用を前提に選ぶ。

## 代替案

| 代替 | 却下理由 |
|---|---|
| `bindExtensions` を呼ばないままにする | 子の全拡張ツールが常時 active になる。課税は静かだが確実で、設計されたトークン予算が子で成立しない |
| pi-exa 側でセットアップ時にグループを適用する | ホストに依存しない自己防御にはなるが、公開の有効化タイミング(設定・`exa_help`・`/exa enable` のみ)を変えることになり、pi-exa 側の契約変更になる。SDK 利用側の責務を pi-exa が負うべきではない |
| SDK を上げず `bindExtensions` のみ入れる | 上の税は消えるが、子里で MCP を使えず、定義の `extensions: true` が宙に浮く |
| 子の既定を `extensions: false` にして `general` の `extensions: true` を外す | 費用は最も小さい。ただし子から MCP や他の拡張が使えなくなり、委譲先が親より貧しい環境を強いことになる |