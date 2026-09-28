# ADR 0006: 宛先を run id だけにし、送信元をメッセージに明示する

- 状態: 採用 (2026-09-28 識別子は [ADR 0009](0009-resume-address-pair.md) で session id に置き換え。完全一致の KV アドレスと送信元ヘッダーは有効)
- 日付: 2026-09-28
- 対象: `message_agent` の `target_run_id`、宛先解決、子向けブリーフィング、メッセージのヘッダー

## 背景

- `message_agent` の `to` は run id と agent 名の2形式を受け、解決に失敗すると
  `Live runs: name (agent, runid)` という**そのままでは渡せない形式**を返していた。
  子向けブリーフィングも `agent (runid)` を配っていた。
- 実測(09-23〜09-28、子セッション806呼び出し): `message_agent` の失敗33件のうち、15件が
  `"document quality reviewer (17ab2215)"` のような表示形式の貼り付け、
  8件が同名 agent の曖昧解決だった。
- 受信側には本文しか届かず、どの run からのメッセージかを判別できなかった。
- SDK の `sendUserMessage` はテキストしか運べないため、送信元は本文で示すしかない。

## 決定

1. `to` を `target_run_id` にし、run id の完全一致だけを受け付ける。
   agent 名の解決と曖昧解決(`ambiguous`)を削除する。
2. 解決エラーは `Live run_ids: <id>, <id>` と、アドレス可能な値だけを並べる。
3. 子向けブリーフィングは `target_run_id=` / `name=` / `agent=` の明示 KV を1行ずつ出す。
4. 配送メッセージの先頭に `message_agent from_run_id=<id> name="<name>"` を付ける。
   返信はこの `from_run_id` を `target_run_id` に渡す。
5. 親向けの結果見出しは `[name] run_id=<id> (model)` にする。

## 理由

- 受け付ける形式を1つにすると、誤用のクラス(表示形式の貼り付け・同名の曖昧さ)が構造的に消える。
- 表示とアドレスを同じ形式にすると、モデルが表示を貼るのは自然な振る舞いであり、防げない。
  表示形式はUIにだけ残し、AIが読む文字列はKVに統一する。
- 送信元がなければ、受け手は返信先を推測することになり、一方通行の設計でも会話が成立しない。

## 帰結

- `message_agent` の引数は `target_run_id` と `text` の2つになる。
- ブリーフィングは兄弟数に比例して複数行になる(1行あたりの情報は増える)。
- トークン計測: `message_agent` 71 → 87、全体 344 → 304(`spawn_agents` の引数削減を含む)。
