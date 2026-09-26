# 設計

「作るもの」と「**作らないと決めたもの**」を同時に管理する。後者が無いと必ず膨らむ。
競合3実装との機能全量比較は [research.md](research.md) を参照(本書では繰り返さない)。

## 用語

同じ「並行」を指す言葉が複数あるため、本書では次に固定する。

- **並列実行**: 複数の子が同時に動くこと。本拡張は対応する。
- **非同期実行**: 親が子の完了を待たずに制御を戻すこと。本拡張は**持たない**(ADR 0001)。
- **兄弟**: 同じ `spawn_agents` 呼び出しで起動された子どうし。

## 目的

1. 子エージェントを起動し、その結果を受け取る(委譲の基本形)
2. **兄弟エージェント同士が直接メッセージをやり取りする**(既存実装に無い差分)

## 構造上の制約(設計の出発点)

同期 spawn では、親は `spawn_agents` のツール結果が返るまでモデルターンを進められない。したがって:

- **子→親の質問は成立しない**(親が停止中のため答えられない)。pi-subagents は pause/resume でこれを解くが、
  その機構こそが複雑さの主要因だった。
- **親→子の steering も送るタイミングが無い**。
- **兄弟同士の会話は成立する**。兄弟は各自のモデルループを持つ独立セッションとして並走しており、
  親が停止していても互いに応答できる。

この制約から、面は「並列起動」と「兄弟間メッセージング」に絞られる。却下案の詳細は
[research.md の発見節](research.md)を参照。

## ツール面

### `spawn_agents`

```
spawn_agents({
  tasks: [{ agent, task, model?, cwd? }, ...],   // 1..8 を並列起動
  context?: "fresh" | "fork",                    // 既定 fresh
  timeout_ms?: number
}) -> {
  results: [{ agent, run_id, model, output } | { agent, run_id, model, error }]
}
```

- 1要素なら単独委譲、複数要素なら並列 fanout。どちらも同じ経路を通る(分岐を作らない)。
- 全員の完了を待ってから返す。部分結果や途中経過は返さない。
- 子の失敗はその子の `error` になり、兄弟の結果は失われない。事前解決の失敗
  (未知の agent、解決不能なモデル)だけが呼び出し全体を失敗させる。
- モデル解決順: `tasks[].model` → 定義の `model` → 親セッションのモデル。
  **解決結果を必ず `results[].model` に含める**。指定が黙って無視される余地を残さない。
- 既定では子に `spawn_agents` を渡さないため、委譲の深さは 1 になる。定義に
  `extensions: true` を書いた子は拡張と一緒に `spawn_agents` を受け取り、多段委譲できる(ADR 0006)。

### `message_agent`

```
message_agent({ to, text, wait? }) -> { reply?: string }
```

- 子のみが使う。宛先 `to` は兄弟の run id か agent 名。
- 各子のタスク先頭に「メッセージできる兄弟: 名前 (run id)」の1行を自動で付ける。
  run id は呼び出し後にしか決まらないため、これが無いと run id 指定は実質使えず、
  同じ agent を2回 spawn したときに区別できない。
- 配送: `sendUserMessage({ deliverAs: "steer" })` の1経路。実行中なら次の安全点で現ターンに割り込み、
  待機中なら新しいターンを開始する。配送が開始したターン(誘発ターン)の完了は `spawn_agents` が待つ。
- `wait: true` は宛先の次のアシスタント発話を返り値にする。既定は `false`。
- デッドロック防止: **1セッションにつき未解決の inbound wait は1つまで**。
  A→B→A を状態1ビットで不可能にする。
- 提供しないもの: `to: "parent"`、broadcast、共有タスクリスト、`list_agents`
  (カタログ注入で探索は足りる)。

### agent カタログ

`before_agent_start` で `agents: <name> — <description 先頭40文字>` をシステムプロンプトに注入する。
注入量も予算テストの対象(120 トークン)。

### frontmatter 互換

`~/.pi/agent/agents/*.md` の pi-subagents 互換サブセットを読む:
`name, description, tools, model, thinking, systemPromptMode, inheritProjectContext, inheritSkills, extensions`。
`extensions` は子セッションでグローバル設定の `packages` をロードするか(既定 false)。
**対応キーのみ有効**で、未知キー(`async` など)は警告して無視する。
定義ファイルが読めることと、全設定が反映されることは別である。

## モジュール構成

可変状態は registry が保持する `RunHandle`(inbound wait と誘発ターン)のみ。依存は下向きのみ。

```
src/index.ts        factory(配線のみ)
src/catalog.ts      agent 定義の探索・frontmatter パース(純関数)
src/registry.ts     run id / 名前 → セッションの表。RunHandle を保持
src/spawn.ts        モデル解決、並列実行、SDK セッションの生成、誘発ターンの完了待ち
src/deliver.ts      配送と誘発ターンの追跡、待機の排他
src/tools/          spawn_agents(親)と message_agent(子)
```

## 非目標(YAGNI 台帳)

明示的に**作らない**。必要になった時点で、実測値とともに ADR を起こしてから議論する。

| 作らないもの | 理由 |
|---|---|
| 子→親の質問 / pause / resume | 同期 spawn では成立しない。pause/resume 機構が複雑さの主要因だった |
| 親→子の steering | 送るタイミングが構造上存在しない |
| 非同期実行(親が待たない起動) | 別プロセス runner がモデル解決を二重化させた(ADR 0001)。回避策は保留として記録済み |
| in-process のバックグラウンド子 | 技術的には可能だが、未完了の子の追跡・回収・失敗時の部分結果が新たに必要になる。需要が実証されてから |
| ワークフロー DSL / チェーン定義 | 制御フローはモデルの仕事。複数回 spawn すればよい |
| 永続 run ディレクトリ / status ファイル / resume / revive | プロセス内に状態があるため不要。**子セッションも in-memory で、落ちたらやり直す** |
| mission / 定期実行 | 委譲の基本形ではない。Pi の外(利用者の運用)で足りる |
| watchdog / 受け入れゲート | 「独立した検証」は reviewer を明示的に spawn すれば得られる。自動挿入は委譲の意味論ではなく品質機構 |
| worktree / lane / merge 調整 | 隔離は本拡張の責務ではなく、書き込み競合の解決は呼び出し側の設計問題 |
| TUI / fleet 表示 / RPC | 対話の見た目と外部連携は Pi 本体と他拡張の領域。本拡張は結果だけを返す |
| コスト集計 | Pi 本体のセッション統計で見える |
| usage 予算 / spawn 予算 | 同期・1呼び出し 8 件までなら暴走の余地が小さく、上限を設けるより呼び出し側の判断で足りる |
| skill / references の同梱 | 文脈を圧迫する(pi-subagents は 138KB 同梱)。運用手順は README に置く |
| 遅延ロード機構 | 308 トークンなら常時ロードでよい。予算テストが大きさを保つ |
| `list_agents` / broadcast / 共有タスクリスト | カタログ注入で探索は足りる。broadcast は宛先の特定を要らず、必要になったら `tasks` を増やせばよい |
| 定義の env 変数によるグローバル上書き | `model` 引数 → 定義 → 親 で足りる(ADR 0004) |

## 現状

- 実装・自動テスト完了(基準: 2026-09-26 の作業ツリー)。
- **未検証**: 実モデルでのスモークテスト。`src/spawn.ts` の `createChildChannel` は実 SDK セッションを
  必要とするため自動テストの対象外。手順は [AGENTS.md](../AGENTS.md) の末尾にある。
- 検証値: `npm run verify` グリーン、テスト 77 件、カバレッジ 95.37% lines / 92.83% branches /
  96.74% functions、ツール面 308 トークン。測定方法は [foundation.md](foundation.md) の「計測方法」。
