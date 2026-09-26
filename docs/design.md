# 設計(Step 2 以降で確定)

この文書は「作るもの」と「**作らないと決めたもの**」を同時に管理する。後者が無いと必ず膨らむ。

## 目的

1. 子エージェントを1つ起動し、その結果を受け取る(委譲の基本形)
2. 親・子・兄弟が同一プロセス内で直接メッセージをやり取りする(既存実装に無い差分)

## 利用者から見た振る舞い(たたき台)

### `spawn_agent`

- `agent` = `~/.pi/agent/agents/*.md` の frontmatter `name`、またはファイル名。子は常に in-process の
  セッションとして起動し、完了まで待つ。非同期(バックグラウンド)実行は持たない。
- モデル解決順: `model` 引数 → agent 定義の `model` → 親セッションのモデル。この順序は
  **引数が無視される余地を残さない**。解決結果は必ず結果に含めて返し、テストで固定する。
- `context: "fresh"`(既定)は空の文脈、`"fork"` は親の会話をコピーする。
- 返り値: `{ output, run_id, agent, model }`。子の追加情報は要求されない限り返さない。

### `message_agent`

- `to`: `"parent"` / run id / agent 名。
- 配送: 宛先が実行中なら `steer()`、待機中なら `followUp()`。どちらも `AgentSession` の公開メソッドで、
  同一プロセスだからこそ成立する。
- `wait` 既定値は `to === "parent"` のときのみ `true`。親からの指示は投げっぱなしが自然で、
  子から親への質問は答えが必要という非対称性を既定値に埋める。
- デッドロック防止: **1セッションにつき未解決の待機は1つまで**。A が B を待ち、B が A を待つ状態を
  状態1個で不可能にする。

### agent カタログ

`before_agent_start` でシステムプロンプトに `agents: <name> — <description 先頭40文字>` を注入する。
注入量も予算テストの対象。pi-subagents のように frontmatter 全フィールドを説明文へ展開しない。

### frontmatter 互換

`~/.pi/agent/agents/*.md` の pi-subagents 互換サブセットを読む:
`name, description, tools, model, thinking, systemPromptMode, inheritProjectContext, inheritSkills`。
未知キーは警告して無視する(`async` など)。既存の定義ファイルを修正せずに使えることを優先する。

## 非目標(YAGNI 台帳)

明示的に**作らない**。必要になった時点で、実測値とともに ADR を起こしてから議論する。

| 作らないもの | 理由 |
|---|---|
| 非同期(バックグラウンド)実行・別プロセス runner | モデルのモデル(agentic loop)に向かない。モデル指定が無視される分岐の温床でもある |
| ワークフロー DSL / チェーン / 並列タスク定義 | 制御フローはモデルの仕事。必要なら複数回 spawn すればよい |
| 永続 run ディレクトリ / status ファイル / resume / revive | プロセス内に状態があるため不要。落ちたらやり直す |
| missions / schedules / watchdog / acceptance gate | 委譲の基本形に含まれない |
| worktree / lane / merge 調整 | 書き込み競合は呼び出し側の設計問題 |
| TUI / fleet 表示 / RPC / 外部 CLI アダプタ | 対話ループに不要 |
| コスト集計 / usage 予算 / spawn 予算 | Pi 本体のセッション統計で足りる |
| skill / references の同梱 | 文脈を圧迫する。運用手順は README に置く |
| 遅延ロード機構 | 267 トークンなら常時ロードでよい。予算テストが同じ役割を果たす |
| 子による孫の spawn | 深さ1固定。暴走と責任範囲の曖昧化を同時に防ぐ |

## Step 2 の作業項目

1. **調査**: opencode / Codex / Claude Code のサブエージェント機能を比較し、委譲の意味論
   (モデル指定の解決順、文脈の引き継ぎ、結果の返し方、エージェント間通信)を整理する。
   本リポジトリの決定がそれらとどう違うかを記録する(差別化の半分は「持たないこと」にある)。
2. `catalog.ts`(frontmatter 探索・パース)を実装。純関数なので `test/unit/` で網羅。
3. `registry.ts`(run id / 名前 → `AgentSession` の表)を実装。可変状態はここだけ。
4. `spawn.ts`(`createAgentSession` の組み立て)を実装。
5. `deliver.ts`(steer / followUp の配送判定)を実装。純関数に切り出して unit テストで固定。
6. `test/integration/` を追加。スタブ `ModelRuntime` で API キー無しに spawn → 兄弟メッセージ往復を検証。
7. 上記を踏まえて本ドキュメントの「たたき台」を確定し、ADR に昇格させる。
