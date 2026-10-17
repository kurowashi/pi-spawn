# 手動確認 — pi-spawn

自動検証の対象外の確認項目と手順です。AGENTS.md の制約表にある「手動確認項目 N」はこの番号を指します。

## 手動確認項目

`src/spawn.ts` の `createChildChannel` は実 SDK セッションを必要とするため、自動テストの対象外です。次の項目は実モデルで確認します。

1. 2エージェントを並列 spawn します。片方が `target_session_id=<相手の session id>` を指定して `message_agent` を呼びます。
   - 相手に新しいターンが起きること。
   - 受け手のセッションに `message_agent from_session_id=<id> name="<name>"` ヘッダー付きで届くこと。
   - 会話後の最新の発話が結果に現れること。
2. agent 定義の frontmatter に `extensions: true` を書いた agent を spawn します。子から MCP ツールを1つ呼ばせ、結果に現れること。呼び出しの終了後に MCP サーバーのプロセスが残っていないこと（`pgrep -f` などで確認）。
3. 既定の子（`extensions` 無し）からは `spawn_agents` を呼べないこと。
4. spawn した子のセッションが `~/.pi/agent/spawn-sessions/` に残ること。結果の `session_file` と一致し、`pi --session <path>` で開けること。`inheritConversation: true` の定義の子は親の履歴から始まること。
5. 子の実行中、`spawn_agents` の各子の1行が表示されること。完了後の結果に表示名・モデル・コンテキスト使用量・コスト・run 別 usage・`session_file` が出ること。進捗の追従と `done` の挙動は [ADR 0004](adr/0004-progress-done-state.md) と [README](../README.md) の通りです。完了後、親セッションのコスト統計に子の使用量が加算されていること（`/session` のコスト統計で確認）。
6. 子を spawn したときの結果の `session_id` と `entry_id` を、`resume_session_id` / `resume_entry_id` に渡して再 spawn します。
   - 前回の文脈を踏まえた返答が返ること。
   - 結果の `session_id` と `session_file` が前回と同じであること。
   - usage が再開後の分だけであること。
   - その再開結果の組で再度 resume できること。
   - 親を `/tree` で戻してから古い結果の組で resume し、破棄した枝の続きが混ざらないこと。
7. `<project>/.pi/agents/` の定義を確認します。信頼していないプロジェクトではカタログに現れず spawn も失敗すること。trust 済み（`--approve` など）では現れて spawn できること。
8. 子の実行中に `/spawn` でログを開き、追記への追従・スクロール・`Esc` での終了を確認します。実行が終わった後もビューが壊れず、`finished` 表示に変わること（キーの網羅は [README](../README.md) を参照）。
9. `~/.pi/agent/spawn.json` に小さい `timeoutMs`（例: 5000）を書いて長いタスクを spawn します。結果が `timed out after 5s` のエラーになること。`0` なら制限されないこと（確認後は戻す）。
10. 定義本文に `@path`（相対・`~/`・絶対）を書いた agent を spawn します。子の作業ディレクトリ基準で解決した参照先の内容が、子のプロンプトの `Contents of <絶対パス> (...)` として本文の後ろに入ること。子に「プロンプトの参照先の内容を答えて」と頼んで確認します。定義が `user` / `project` のどちらかで説明文が変わること。

## ツール面の手動レビュー

トークン予算は契約テストが守ります。「そのコストが機能と実使用に見合うか」は自動化できないため、ツール面（説明・スキーマ・引数・カタログ）を変えたときと定期的に次を行います。

1. 計測: `spawn_agents` / `message_agent` の `name + description + JSON.stringify(parameters)` とカタログ行を、`test/contract/budget.test.ts` の `tokensOf` と同じ式（4文字=1トークン）でツール別・引数別に集計します。
2. 実使用: `~/.pi/agent/sessions/**/*.jsonl` と `~/.pi/agent/spawn-sessions/*.jsonl` を JSONL として読み、`role: "assistant"` の `content[].type == "toolCall"` を集計します。
   - ツール別の呼び出し回数。
   - `spawn_agents` の `tasks[]` の各フィールド（agent / task / name / model / cwd / resume_session_id / resume_entry_id）と、`message_agent` の `target_session_id` / `text` の使用率。
   - `role: "toolResult"` のエラー（`details.error` か `Validation failed for tool`）。
   - 開発セッションの意図的な不正 agent テストは誤用に数えず、通常利用と分けます。
   - 文字列 grep で `"name":"spawn_agents"` を数えると、システムプロンプトの `toolsAdded` を拾って過大になります。必ず toolCall パートをパースします。
3. 判定: トークン占有率と使用率を突き合わせます。
   - 余剰候補: トークンが大きく使用率が低い引数（`model` / `resume_entry_id` 等）。
   - 不足: 誤用エラー。エラー本文が回復情報（定義済み agent 一覧等）を返せているか。
   - カタログは agent 定義数に比例して伸びるため、定義を増やしたときに測ります。
4. 記録: 計測値は契約テストのコメントに反映します（[変更時の手順](../AGENTS.md)と同じ）。
