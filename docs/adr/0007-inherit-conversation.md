# ADR 0007: 文脈継承を呼び出し引数から agent 定義へ移す

- 状態: 採用
- 日付: 2026-09-28
- 対象: 削除した `spawn_agents` の `context` と、追加した `inheritConversation`

## 背景

- `context: "fresh" | "fork"` は 208 呼び出し中 `fork` が 0 件、明示 `fresh` が 18 件(既定値の再宣言)だった。
- 親の会話をコピーするかどうかは、親の会話に依存するかで決まる微妙な判断で、
  呼び出しごとにモデルが選ぶには根拠が薄い。
- 他ハーネスも呼び出し引数では持たない。OpenCode の Task は fresh 固定で `task_id` により再開し、
  Claude Code も fresh 固定で `resume` を使う。

## 決定

1. `spawn_agents` の `context` を削除する。
2. agent 定義の frontmatter に `inheritConversation`(boolean、既定 false)を追加する。
   true の定義の run だけ、親の会話をコピーして開始する。
3. 親の会話は、そのフラグが立つ run を作るときだけ読む(遅延読み出し)。

## 理由

- 文脈継承は「その agent をどう設計するか」であり、定義の作者(人間)が意図して決める方が確実。
- 既定を空に保つことで、親の長い会話を N 子へ複製するコストを既定で払わない。
- 文脈の継続は `resume_run_id` が担うため、fork は追加指示の代替ではない。

## 帰結

- fork はモデルから見えなくなる。子の文脈は既定で空、`inheritConversation` の定義だけ親の履歴から始まる。
- 手動確認項目と README の `context` 記述を更新する(ADR 0001 の resume は変更しない)。
