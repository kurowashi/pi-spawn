# ADR 0010: カタログを `spawn_catalog` セクションで注入し、プロンプトを固定しない

- 状態: 採用
- 日付: 2026-10-06
- 対象: `before_agent_start` でのエージェントカタログの注入

## 背景

- カタログはモデルが spawn 先を知る唯一の面であり、`before_agent_start` のたびに注入していた。
- 従来は `{ systemPrompt }` を返してプロンプト末尾に追記していた。Pi はこれを `forceSystemPrompt` として扱い、その実行のプロンプト全文を固定する。
- `forceSystemPrompt` が設定されると、それ以降に `sections` を変更する拡張の内容は provider に届かない。実測では pi-spawn の後に読み込まれる pi-import の `project_context` 差し替えがモデルに届かず、import が無効になっていた。
- pi-spawn はカタログを追加するだけで、プロンプト全体を所有する必要がない。

## 決定

1. カタログは `systemPromptOptions.sections["spawn_catalog"]` として注入する。
2. `before_agent_start` から `systemPrompt` を返さない(プロンプト全体を固定しない)。

## 理由

- セクションは Pi の差分記録の契約に沿って provider に届き、他の拡張は引き続きプロンプトを変更できる。
- 追加専用のカタログにプロンプト全体の所有権は不要である。

## 帰結

- カタログは `<spawn_catalog>...</spawn_catalog>` として組み込みセクション(`cwd` など)の後に置かれる(従来はプロンプト全体の末尾)。
- pi-import など `before_agent_start` で `sections` を変更する拡張が、pi-spawn の後でも動く。

## 代替案

| 代替 | 却下理由 |
|---|---|
| `{ systemPrompt }` を返し続ける | プロンプトを固定し、後続拡張のセクション変更をモデルから隠す |
| 既存セクション(`tools` など)へ追記する | ツール定義とカタログの所有が混ざり、他拡張の変更と衝突する |
| カタログを `preamble` に入れる | プロンプト全体の所有が必要になり、同じ固定の問題が戻る |
