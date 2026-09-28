# ADR 0008: 呼び出しの制限時間をモデル引数からハーネス設定へ移す

- 状態: 採用
- 日付: 2026-09-28
- 対象: 削除した `spawn_agents` の `timeout_seconds` と、追加した `spawn.json` の `timeoutMs`、中断の報告

## 背景

- `timeout_seconds` は 208 呼び出し中 63 件で使われたが、値は 180〜2400 秒の当て推量だった。
  1つの締切が呼び出し全体に効くため、最も遅い子を見積もる必要がある。
- 発火しても成功として報告される実例があった(`timeout_seconds: 5` + `sleep 30` → `isError=false`、空出力)。
- 実測の run 時間は p50 17秒、p90 2.7分、p99 26分、最大44分で、固定値をモデルが当てる根拠はない。
- OpenCode の Task は現行スキーマに timeout を持たず、追加提案は「既定10分 + 環境変数で上書き、
  発火時は `task_id` 入りのエラー」だった。Codex と OpenCode の監視はプロバイダのストリーム単位
  (first-byte / idle)で、Pi 本体も `httpIdleTimeoutMs`(既定300秒)+エージェントリトライで検出する。

## 決定

1. `spawn_agents` の `timeout_seconds` を削除する。
2. 呼び出し全体の制限時間は `spawn.json` の `timeoutMs` にする。既定は60分、`0` は無制限。
   グローバル(`~/.pi/agent/spawn.json`)を先に読み、プロジェクト(`<cwd>/.pi/spawn.json`)で上書きする。
3. 中断された run は成功にせず、理由付きのエラーとして報告する。
   呼び出し側が中断した理由(`timed out after ...` / `aborted`)と、最終 assistant メッセージの
   `stopReason` / `errorMessage` を結果に反映する。

## 理由

- 制限時間はタスクの性質ではなく環境の性質で、モデルより人間の方が正しく決められる。
- 既定60分は実測の最大44分を切らずに、ハングを有限時間で終わらせる。
- ストリーム停止の検出を Pi 本体に任せることで、同じ監視を二重に持たない。
- 無言の空結果は、親が失敗を成功と誤認する最も危険な形なので、理由を必ず付ける。

## 帰結

- モデル面から時間の概念が消え、`spawn_agents` のトップレベル引数は `tasks` だけになる。
- 時間制限の変更は `spawn.json` の編集になる。
  stall は Pi 本体の `httpIdleTimeoutMs` で調整する。
- 中断理由が結果の `error` に出るため、`output` だけを見た成功判定ができない。
