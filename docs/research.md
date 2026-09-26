# サブエージェント機能の全量インベントリ

Claude Code / Codex / opencode / pi-subagents / pi-spawn を**機能単位で**比較する。
一次資料は各公式ドキュメント(確認日 2026-09-26)。pi-subagents は手元の 0.71.0 の
`docs/` と `src/extension/schemas.js`(82 パラメータ)から列挙した。トークン数などの実測値の
測定方法は [foundation.md の「計測方法」](foundation.md#計測方法)を参照。

凡例(pi-spawn 列の状態):

- `○` この拡張に実装済み
- `△` 条件付き・限定的(条件はセルの注記に従う)
- `×` 実装していない(設計上は可能だが作らない、または未着手)
- `–` この設計では概念自体が成立しない(例: 同期 spawn における「非同期結果の待ち合わせ」)
- `保留` 実装していないが、追加する候補として記録済み(§7 に条件を書く)

pi-spawn 列だけが太字なのは、これが比較の基準列だからである。他実装の記号は
「その実装に機能があるか」を表し、既定で有効かどうかはセルの注記で補う。

「pi-subagents を捨てると何が失われるか」を知るために pi-subagents の列が最も重要。

## 1. 実行モデル

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| 単一 spawn(同期・結果を待つ) | ○ | ○ | ○ | ○ | **○** |
| 並列 spawn(1呼び出しで N 件) | ○ agent teams / 複数タスク | ○(`max_threads` 既定 6) | ○ | ○ `tasks` / chain / workflow | **○ `tasks[]`(1..8)** |
| 非同期 spawn(親は待たない) | ○ background subagents(`run_in_background`) | ○ | ○ background child sessions | ○ `async: true` | **保留**(ADR 0001。条件は §7) |
| 非同期結果の待ち合わせ | ○ 完了時に報告 | ○ 全結果が揃うまで待つ | △ | ○ `bg_wait` / status / children.list | **–**(同期のみなので不要) |
| 実行中の進捗取得 | ○ agent view | ○ `/agent` | ○ 子セッション閲覧 | ○ status / includeProgress | **×** |
| 中断・停止 | ○ | ○ | ○ | ○ `stop` / interrupt | **×** タイムアウトのみ |
| 実行中への追加指示(steering) | △ SendMessage | ○ | △ | ○ `steer`(3モード) | **×**(同期 spawn では送る時点が無い) |
| 再開・再起動(resume) | ○ セッション resume | ○ スレッド継続 | ○ `task_id` | ○ resume / revive / retained children | **×** |
| 子による孫 spawn(深さ) | △ 1 セッション内 | ○ `max_depth` 既定 **1** | △ `permission.task` で制御 | ○ `maxSubagentDepth` 既定 2 | **×**(構造で 1 固定) |
| 同時実行数の上限 | △ | ○ `max_threads` | △ | ○ 各種上限 / grant | **×**(1呼び出し 8 件が事実上の上限) |
| 実行タイムアウト | ○ | ○ `job_max_runtime_seconds` 既定 1800 | △ | ○ `timeoutMs` / toolTimeoutMs / checkpoint | **○ `timeout_ms`** |
| 別マシン・別プロセス実行 | △ agent view / Remote | – | – | ○ 別プロセス runner / Herdr 保存マシン | **×**(同一プロセス固定) |

## 2. 文脈・モデル

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| 空の文脈で起動(fresh) | ○(既定) | ○ | ○(既定) | ○ `context: fresh` | **○(既定)** |
| 親会話の引き継ぎ(fork) | ×(渡せるのはプロンプト文字列のみ) | △ 親の実行時上書きを再適用 | △ `task_id` 継続 | ○ `context: fork` | **○ `context: fork`** |
| プロジェクト文脈(CLAUDE.md / AGENTS.md)継承 | ○(`omitClaudeMd` で除外可) | ○ | ○ | ○ `inheritProjectContext` | **○ `inheritProjectContext`** |
| skills 継承 | ○ | ○ skills | △ | ○ `inheritSkills` / `skill` 引数 | **○ `inheritSkills`** |
| 子のツール制限 | ○ `tools` | ○ sandbox / 権限 | ○ `permission` / `tools` | ○ `tools` / capabilityCeiling / excludeTools | **○ 定義の `tools`** |
| 権限・sandbox の継承 | ○(background は自動 deny) | ○ 親ターンの上書きが勝つ | ○ 子の permission | ○ `permissions` / child watchdog 仲裁 | **△ 親セッションの既定に従う** |
| 呼び出し時のモデル指定 | ○(env 変数が最優先) | ○ | ×(第三者プラグインが必要) | ○ `model`(thinking サフィックス可) | **○ `tasks[].model`** |
| 定義側のモデル既定 | ○ | ○ role ごと | ○ | ○ frontmatter | **○ frontmatter** |
| 推論強度(thinking / reasoning effort) | ○ | ○ `reasoning_effort` | ○ | ○ `thinking` | **○ `thinking`** |
| フォールバックモデル | × | – | × | ○ `fallbackModels` | **×** |
| 構造化出力(schema 強制) | △ SDK の output_format | ○ structured outputs | △ | ○ `outputSchema` / structured_output | **×** |
| 出力のファイル化・共有 | × | – | – | ○ `output` / `share`(Gist) | **×** |
| プロバイダ資産の注入(高速枠など) | – | – | – | ○ `fast`(OpenAI priority tier) | **×** |

## 3. エージェント定義

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| ユーザー定義エージェント | ○ `.claude/agents/*.md` | ○ `~/.codex/agents/*.toml` | ○ `opencode.json` / `.md` | ○ `~/.pi/agent/agents/*.md` | **○ 同じ場所・同じ frontmatter** |
| プロジェクト定義エージェント | ○ | ○ `.codex/agents/` | ○ | ○ プロジェクト優先 | **×**(ユーザー定義のみ) |
| ビルトインエージェント | ○ Explore, Plan, general-purpose, statusline-setup, claude-code-guide | ○ default, worker, explorer | ○ build, plan(primary)+ general, explore, scout(subagent) | ○ worker, reviewer, scout, oracle, researcher, evidence-auditor, delegate, 外部CLI 6種 | **×**(pi 本体にも無い) |
| 定義カタログのモデルへの提示 | ○ description(合計 15,000 tok 超で警告) | ○ description | ○ description | ○ システムプロンプトへ広告 | **○ 1行・40字上限・予算テストで拘束** |
| 定義の無効化・上書き | ○ | ○ | ○ | ○ `agentOverrides` / disable / eject | **×** |
| 定義の作成・編集をモデルから行う | × | × | × | ○ `create` / `update` / `delete`(49 管理アクションの一部) | **×** |

## 4. 協調(エージェント間)

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| 子 → 親: 最終結果 | ○ | ○ | ○ | ○ | **○** |
| 子 → 親: ブロッキングな質問 | ×(質問は失敗する) | △ 親が follow-up を routing | × | ○ `contact_supervisor` + pause/resume | **保留**(条件は §7) |
| 子 → 親: 進捗通知 | ○ | ○ | △ | ○ `progress_update` | **×** |
| 親 → 子: steering | △ SendMessage | ○ | △ | ○ `steer` | **×**(親が停止中なので送る時点が無い。§7 に保留として記録) |
| 子 → 子(兄弟)直接メッセージ | ○ `SendMessage` / agent teams | × | × | △ 外部 `pi-intercom` を明示導入した場合のみ | **○ `message_agent`(本拡張の差分)** |
| 兄弟の返信を待つ | △(新しいターンとして届く) | × | × | × | **○ `wait: true`** |
| broadcast | ○(高コストと明記) | × | × | × | **×** |
| 共有タスクリスト | ○ agent teams | △ | × | ○ workflow / lane | **×** |
| 宛先の探索(アドレス帳) | ○ `ListAgents` | ○ `/agent` | ○ 子セッション一覧 | ○ `children.list` / status | **△ カタログ注入で代替** |
| デッドロック防止 | – (待機が無い) | – | – | ○ pause/resume で回避 | **○ inbound wait 1本制限** |
| 配送タイミング(兄弟宛メッセージ) | ターン終了時のみ | – (兄弟間メッセージ無し) | – (同左) | – (同左) | **○ 実行中は steer / 待機中は followUp** |

## 5. 検証・品質・統制

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| 受け入れゲート(コマンド検証) | × | × | × | ○ `acceptance` / `gate` | **×** |
| typed gate(JSON schema 検証) | × | ○ structured outputs | × | ○ | **×** |
| 専用レビュー役・oracle | ○ ビルトイン Plan | ○ role 定義 | ○ explore | ○ reviewer / oracle / evidence-auditor | **×**(定義すれば可) |
| watchdog(境界レビュー・監視) | △ hooks | × | × | ○ | **×** |
| 子のツール呼び出し承認の仲裁 | ○ 権限プロンプト | ○ approval を親へ提示 | ○ permission | ○ child watchdog が approve/deny | **△ 親セッションの権限に従う** |
| コスト・使用量の集計 | ○ 同一利用枠 | △ | △ | ○ `/subagent-cost` / usageBudget | **×**(pi 本体の統計で見る) |
| spawn 予算・spawn 数の上限 | × | ○ max_threads | × | ○ `maxSubagentSpawnsPerSession` + grant | **×** |
| 改竄検知・契約ダイジェスト | × | × | × | ○ launchContractDigest / preflight | **×** |

## 6. 運用・UI・統合

| 機能 | Claude Code | Codex | opencode | pi-subagents | pi-spawn |
|---|---|---|---|---|---|
| 実行一覧 UI | ○ agent view / `claude agents` | ○ アプリ・`/agent` | ○ 子セッション切替 | ○ fleet view / async widget | **×** |
| トランスクリプト閲覧 | ○ | ○ | ○ | ○ `status`(transcript tail) | **×** |
| 実行へのアタッチ・切替 | ○ | ○ `/agent` | ○ `session_child_*` | ○ resume / inspector | **×** |
| mission / goal 管理 | × | × | × | ○ missions(作業台帳・決定・成果物) | **×** |
| スケジュール実行 | × | × | × | ○ `schedule.*`(cron 風) | **×** |
| worktree 分離 | × | ○ Codex app のワーキングツリー(スレッド/自動化を別 worktree で実行) | × | ○ `worktree` / lane / merge 記録 | **×** |
| 他拡張からの操作(RPC) | △ SDK | – | – | ○ `pi-subagents/rpc` + extension API | **×** |
| MCP ツールを子に渡す | ○ | ○ | ○ | ○(pi-mcp-adapter 経由・条件付き) | **×**(子は組み込み + `message_agent` のみ) |
| 外部 CLI を子として実行 | – | – | – | ○ claude-code / codex-exec / cursor-agent | **×** |
| 子セッションの永続化・resume | ○ | ○ | ○ | ○ session file | **×**(in-memory) |
| 対話のみの補助(遅延ロード・説明文モード) | – | – | – | ○ `subagents_enable` / toolDescriptionMode | **×**(不要な大きさではない) |

## 7. この表から導かれる pi-spawn の位置

**実装しているもの(pi-subagents と同等以上)**

- 同期の単一・並列 spawn(1..8)
- fresh / fork 文脈、プロジェクト文脈・skills 継承、定義の `tools` 制限
- モデル解決(task → 定義 → 親)と thinking。解決結果を必ず結果に含める
- エージェント定義の互換(既存ファイルを無修正で使える)
- **兄弟間の直接メッセージと返信待ち**(pi-subagents に無い)
- 兄弟宛メッセージの実行中配送(steer)。Claude Code の「ターン終了時のみ」に対する差分。
  親から実行中の子への steering は提供しない(送る時点が無い)
- 配送のデッドロック防止
- ツール面 308 トークン(pi-subagents は約 5,000)

**実装していないもの(pi-subagents では使えていた)**

| 失うもの | 影響 | 代替 |
|---|---|---|
| 非同期 spawn + 待ち合わせ | 親は全員の完了を待つ。長時間ジョブを投げて別作業はできない | なし(設計判断 ADR 0001) |
| resume / retained children | 終わった子に追加指示できない | 新しい spawn |
| 子 → 親の質問(ブロッキング) | 子は判断を仰げず、自分の判断で進むか結果に「未決」と書く | タスク文に判断基準を書く / 結果に選択肢を書かせる |
| 親 → 子 steering | 実行中に軌道修正できない | タイムアウトで止めて出し直す |
| worktree 分離・lane・merge | 書き込み先が同じなので並列で編集させると衝突する | read-only タスクに限定 / cwd を分けて手動隔離 |
| 受け入れゲート・typed gate | 「検証済み」の証跡が残らない | 親が検証する |
| watchdog | 境界での独立レビューが無い | 明示的に reviewer を spawn |
| コスト・予算・spawn 上限 | 使用量の統制が無い | pi 本体のセッション統計 |
| mission / schedule | 作業台帳・定期実行が無い | なし |
| fleet UI / トランスクリプト閲覧 / inspector | 子の様子が見えない(結果だけ) | 無し。子の出力を結果に含めさせる |
| 永続セッション | 子の会話は残らない | 必要な内容は結果に含めさせる |
| MCP ツール・外部 CLI の子 | 子は read/bash/edit/write + メッセージのみ | 親が MCP を使う |
| RPC / 他拡張連携 | 外から操作できない | なし |

### 保留(追加する候補と条件)

表の `保留` は次の候補を指す。着手は ADR を起こしてから。

- **in-process のバックグラウンド子**: 非同期 spawn と同じだが別プロセス runner を持たない。
  モデル解決は1経路のまま、子 → 親の質問と親 → 子 steering が成立する。
  条件: 「親を待たせたい」または「子が判断を仰ぎたい」需要が実運用で確認されたとき。
- **兄弟の broadcast、共有タスクリスト、子の永続セッション化、子への MCP ツール受け渡し**:
  いずれも現在は非目標。条件: 並列 spawn を常用するようになり、都度のタスク文への記載では
  足りなくなったとき。

## 8. 一次資料

| 実装 | 参照 |
|---|---|
| Claude Code | <https://code.claude.com/docs/en/sub-agents>、`/agent-teams`、`/cross-session-messaging`、`/agent-view`、`/agent-sdk/subagents` |
| Codex | <https://developers.openai.com/codex/subagents>、`/codex/config-reference`(`agents.*`)、Codex SDK の subagents 章 |
| opencode | <https://opencode.ai/docs/agents/>、`/v2/docs/agents/`、`/v2/docs/config`、`src/config/agent.ts` |
| pi-subagents | 手元の 0.71.0 `docs/*.md`、`src/extension/schemas.js`(82 パラメータ)、`agents/*.md` |

競合3実装のドキュメントはバージョンを明示しないため、確認日(2026-09-26)が唯一の基準点である。
読む時点で機能が変わっている可能性がある。特定のセルの根拠を確かめるときは、上の URL を
その時点で再確認すること。
