# ADR 0001: run id を子セッション id にして resume を可能にする

- 状態: 採用
- 日付: 2026-09-26
- 対象: `spawn_agents` の `tasks[].resume_run_id`

## 背景

- 子セッションは永続化され、`~/.pi/agent/spawn-sessions/` に残るようになった。
- 「終わった子への追加指示 (resume)」は他ハーネス (Claude Code, Codex, OpenCode, Cursor) では一般的で、
  レビュー→修正の反復で子の文脈を再説明するコストを消せる。
- AGENTS.md の規約により、引数を増やす場合は ADR とトークン予算の確認が必要。

## 決定

1. `tasks[]` に任意の `resume_run_id` を追加する。トップレベル引数は増やさない。
2. 子セッションの session id を run id にする (`SessionManager.create` / `forkFrom` の `{ id }`)。
   これにより run id がセッションの永続キーになる。
3. 探索は `SessionManager.findById(cwd, runId, sessionDir)`。`cwd` は `task.cwd ?? spawn 時の cwd`。
4. 再開した run の `usage` は再開後に請求された差分だけを報告する (開始時の基準値を減算)。
5. 再開できるのは run id を session id として持つ子セッションだけ(この変更以降に spawn した run)。

## 理由

- トップレベル引数とツール数を増やさず、タスク単位の指定に収まる。
- 専用の索引ファイルを持たず、SDK のセッション探索 API だけで解決できる。
- usage の減算は、親セッションのコスト集計に過去の請求を二重計上しないために必要。

## 帰結

- `resume_run_id` は `cwd` で絞って探索されるため、別の `cwd` で spawn した run を再開するには
  同じ `cwd` を指定する必要がある。
- `agent` / `model` / `cwd` は再開時の指定が使われる(定義の変更は反映される)。
- `context: "fork"` は再開する task には影響しない。
- セッションファイルは自動削除されない。再開できる期間は保存期間に等しい。

## 代替案

| 代替 | 却下理由 |
|---|---|
| トップレベル引数 `resume_run_id` | 複数 task の同時 spawn でどの task を再開するか表現できない。引数上限 3 も超える |
| 専用ツール `resume_agent` | ツール面とトークン予算が増え、`spawn_agents` とほぼ同じ処理を重複させる |
| 索引ファイル (`spawn-sessions/index.json`) | 二重管理になり、セッションの削除との整合を自分で保つ必要がある |
