# ADR 0009: run id を廃止し、同一性を session id に、resume 位置を entry id にする

- 状態: 採用
- 日付: 2026-09-28
- 対象: `spawn_agents` の `tasks[].resume_session_id` / `tasks[].resume_entry_id`、
  `message_agent` の `target_session_id`、結果の `session_id` / `entry_id`

## 背景

- run id は子セッション id と同じ永続キーを二重に持っていた。ADR 0001 はセッション id = run id を決めたが、
  実装は resume のたびに新しい run id を採番し、保存済みセッションを同じファイルへ追記していた。
  そのため結果の `run_id` を `resume_run_id` に渡すと `unknown run id` になり、実セッションで8回発生した(モデルは `resumed_from` から復旧した)。
- 子セッションは追記型で、親の `/tree` は親の枝しか戻さない。resume は常にファイル最終行を現在位置とみなすため、
  親を `/tree` で戻した後に resume すると、破棄した枝の続きを含む文脈で子が動き始める。
- `inheritConversation` の fork は `SessionManager.forkFrom` を使い、同じく最終行を leaf にするため、
  `/tree` 後の fork は破棄した枝を子へコピーする。

## 決定

1. run id を廃止し、子の同一性は session id に、位置は entry id にする。
   結果は `session_id` + `entry_id` を返し、2つが揃って次回の再開キーになる。
2. `tasks[]` の `resume_run_id` を `resume_session_id` + `resume_entry_id` の2フィールドに置き換え、
   両方を必須にする(平置き。結果のフィールド名と揃え、セッションファイルを読むときに対応が取れるようにする)。
3. resume は保存済みセッションを開き、entry へ `branch()` してから実行する。
   以降のターンはその entry の子になり、破棄した枝の続きにはならない。
4. 1回の呼び出しで同じ session id を複数タスクに指定したら事前エラーにする(セッションへの同時書き込みを構造的に防ぐ)。
5. `message_agent` の宛先、ブリーフィング、送信元ヘッダーは session id を使う(`target_session_id` / `from_session_id`)。
6. `inheritConversation` の fork は親の現在の枝(`getBranch()`)をコピーし、親の leaf へ `branch()` する。

## 理由

- 同一性を1つにすると、「resume が返した識別子で再開できない」クラスが構造的に消える。
- 「セッション + entry」は Pi 本体の状態モデルそのもの(ファイル + 木の節)で、新しい概念を増やさない。
- entry を明示すると、`/tree` の巻き戻し・破棄した枝・fork の leaf が同じ原因(最終行 = 現在位置)から解ける。
- セッションを複製しないので、`session_file` と usage 差分の意味は今までどおりになる。

## 帰結

- 結果と引数が1→2フィールドになり、ツール面は 304 → 333 トークン(実測。予算 400 以内)。
- 既存の子セッションに保存されている session id は、そのまま `session_id` として利用できる。
  ただし古い結果には `entry_id` が無いため、その結果だけでは再開できず、`pi --session` で位置を選ぶ必要がある。
- 子セッションのファイルは枝が増え続ける(自動削除は元から無い)。
- 同じセッションを並行して resume する使い方はできなくなる(元から同じファイルを壊していた)。
- [ADR 0001](0001-resume-run-id.md) を廃止し、[ADR 0006](0006-run-id-addressing.md) の識別子部分を置き換える。

## 代替案

| 代替 | 却下理由 |
|---|---|
| run id を残し、resume 後の結果に保存済みの id を返す | 同一性が2つのままで、どちらを渡すかを覚える必要が残る |
| resume を copy-on-write にする(毎回 fork する) | トランスクリプトの複製が増え、`session_file` と usage の基準が変わる |
| 親 entry id を子へ記録し、現在の枝に一致する子 leaf を選ぶ | 親子の対応表という隠れた状態が増える |
| `resume_entry_id` を任意にする | 省略時はファイル最終行という、今回直す原因そのものに戻る |
