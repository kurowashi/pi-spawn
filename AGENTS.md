# AGENTS.md — pi-spawn で作業するエージェント向けの指示

読者は pi-spawn を変更する AI エージェントと開発者です。利用者向けの仕様は [README](README.md) に、
設計の判断基準は [DESIGN.md](DESIGN.md) と [PHILOSOPHY.md](PHILOSOPHY.md)(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、
自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所であり、
自動検証はすべて `verify` に含まれます。

## 制約

### ツール面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| この拡張が登録するツール面は `spawn_agents`(親)/ `message_agent`(子)の2つだけ | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `EXPECTED_PARENT_TOOLS`、`src/tools/child-tools.ts`、`src/spawn.ts` の `noExtensions` |
| 登録コマンドは `spawn` だけ | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `EXPECTED_COMMANDS`、`src/index.ts` |
| ツール定義(説明+スキーマ)の合計が **400 トークン**以内 | `test/contract/budget.test.ts` | `test/contract/budget.test.ts` の `TOKEN_BUDGET`(計測値はコメント) |
| ツール説明は **160 文字**以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_DESCRIPTION_CHARS` |
| トップレベル引数は 3 個以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_TOP_LEVEL_PARAMETERS` |
| スキーマは `additionalProperties: false` | `test/contract/tool-surface.test.ts` | `src/tools/*.ts` |
| 子ツールの引数は `target_run_id` と `text` だけ | `test/contract/tool-surface.test.ts` の `EXPECTED_PARAMETERS` | `src/tools/message-agent.ts` |
| 宛先は run id の完全一致のみ | `test/unit/deliver.test.ts` + `test/unit/message-agent.test.ts` | `src/registry.ts` の `resolveTarget` |
| 受信メッセージは `from_run_id` / `name` のヘッダーを持つ | `test/unit/deliver.test.ts` + `test/integration/spawn-agents.test.ts` | `src/deliver.ts` の `formatMessage` |
| ブリーフィングは `target_run_id=` / `name=` / `agent=` の KV で示す | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `siblingBriefing` |
| 解決エラーは live の run id だけを並べる | `test/unit/message-agent.test.ts` | `src/registry.ts` の `explainTarget` |
| 結果見出しは `run_id=<id>` で示す | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` の `formatResults` |
| 親履歴を継承し、読み出すのは定義の `inheritConversation: true` のときだけ | `test/unit/catalog.test.ts` + `test/integration/spawn-agents.test.ts` | `src/catalog.ts` の `parseAgent` + `src/spawn.ts` の `startRuns` |
| `spawn.json` の解決順はグローバル → trust 済み project。`0` は無制限 | `test/unit/config.test.ts` | `src/config.ts` |
| 制限時間の既定は 3600000ms | `test/unit/config.test.ts` | `src/config.ts` の `DEFAULT_CONFIG` |
| 解決した `timeoutMs` は spawn request に渡る | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` の `spawnRequest` |
| 制限時間に達した run は中断し、`timed out after ...` を返す | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `watchAborts` |
| 失敗した run は成功にせず、`aborted` / provider の `errorMessage` をエラーとして報告する | `test/unit/spawn.test.ts` + `test/unit/session-adapter.test.ts` | `src/spawn.ts` の `failureLabel` / `lastAssistantOutcome` |
| 兄弟の timeout は、自分の prompt が settle 済みの run の結果を書き換えない | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `promptSettled` |

### カタログ・resume・usage・表示名

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| カタログは同名 agent を1件だけ表示する(ファイル名の昇順で最初の定義) | `test/unit/catalog.test.ts` | `src/catalog.ts` の `formatCatalog` |
| 定義の解決順は project → user。project 定義は trust 済みのときだけ読む | `test/unit/catalog.test.ts` + `test/integration/spawn-agents.test.ts` | `src/catalog.ts` の `definitionRoots` / `discoverAgents` |
| resume は永続化済みの run だけを対象にする(run id = セッション id) | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` |
| resume の探索は `cwd` 一致で行う | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` |
| 再開した run の usage は再開後の差分のみ | `test/unit/spawn.test.ts` + `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `subtractUsage` |
| run の表示名は `tasks[].name`、無ければ agent 名、複数 run では連番 | `test/unit/spawn.test.ts` | `src/spawn.ts` の `displayNames` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` を持たない) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_DEV_DEPENDENCIES` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 配布物は `src/` と `package.json` / `README.md` のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

## 変更時の手順

- ツールを増やす・引数を増やす場合は、`TOKEN_BUDGET` を更新する。
  予算は「上げるもの」ではなく「交渉するもの」として扱い、再導出は PHILOSOPHY.md の判断手順に立ち返る。
  上げる場合は計測値をテストのコメントに更新し、コミットメッセージに理由を残す。
- 依存を追加できるのは devDependency と、Pi が供給する peer 依存(`ALLOWED_PEER_DEPENDENCIES`)のみ。
  devDependency は `ALLOWED_DEV_DEPENDENCIES` を更新し、コミットメッセージに理由を残す。
  実行時依存(`dependencies`)の追加は不可。
- 決定の記録は [docs/adr/](docs/adr/) に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、
  却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受けます。契約テストは jiti 経由で `src` をもう一度ロードするため、
  同じファイルが2実体として数えられます。
- ドキュメントの段落内の改行は、文末(。！？)・読点(、)・コロン(:)の直後に置く。

## 手動確認項目(自動検証の対象外)

`src/spawn.ts` の `createChildChannel` だけは実 SDK セッションを必要とするため自動テストの対象外です。
ここは実モデルで確認します。

1. 2エージェントを並列 spawn し、片方が `target_run_id=<相手の run id>` を指定した `message_agent` を呼び、
   相手に新しいターンが起き、受け手のセッションに `message_agent from_run_id=<id> name="<name>"` ヘッダー付きで届き、
   会話後の最新の発話が結果に現れること。
2. agent 定義の frontmatter に `extensions: true` を書いた agent を spawn し、子から MCP ツールを1つ呼ばせて結果に現れること。
   呼び出しの終了後に MCP サーバーのプロセスが残っていないこと(`pgrep -f` などで確認)。
3. 既定の子(`extensions` 無し)からは `spawn_agents` を呼べないこと。
4. spawn した子のセッションが `~/.pi/agent/spawn-sessions/` に残り、結果の `session_file` と一致し、
   `pi --session <path>` で開けること。`inheritConversation: true` の定義の子は親の履歴から始まること。
5. 子の実行中に `spawn_agents` の各子の1行と、
   完了後の結果の表示に表示名・モデル・コンテキスト使用量・コスト・run 別 usage・`session_file` が出ること
   (進捗の追従と `done` の挙動は ADR 0004 と README の通り)。
   完了後、親セッションのコスト統計に子の使用量が加算されていること(`/session` のコスト統計で確認)。
6. 子を spawn したときの run id を `resume_run_id` に渡して再 spawn し、前回の文脈を踏まえた返答が返ること。
   `session_file` が前回と同じで、usage が再開後の分だけであること。
7. `<project>/.pi/agents/` の定義が、信頼していないプロジェクトではカタログに現れず spawn も失敗し、
   trust 済み(`--approve` など)では現れて spawn できること。
8. 子の実行中に `/spawn` でログを開き、追記への追従・スクロール・`Esc` での終了を確認する。
   実行が終わった後もビューが壊れず、`finished` 表示に変わること(キーの網羅は README を参照)。
9. `~/.pi/agent/spawn.json` に小さい `timeoutMs`(例: 5000)を書いて長いタスクを spawn し、
   結果が `timed out after 5s` のエラーになること。`0` なら制限されないこと(確認後は戻す)。

## 手動レビュー(自動検証の対象外): ツール面の必要十分性

トークン予算は契約テストが守るが、「そのコストが機能と実使用に見合うか」は自動化できない。
ツール面(説明・スキーマ・引数・カタログ)を変えた時と、定期的に確認する:

1. 計測: `spawn_agents` / `message_agent` の `name + description + JSON.stringify(parameters)` とカタログ行を、
   `test/contract/budget.test.ts` の `tokensOf` と同じ式(4文字=1トークン)でツール別・引数別に集計する。
2. 実使用: `~/.pi/agent/sessions/**/*.jsonl` と `~/.pi/agent/spawn-sessions/*.jsonl` を JSONL として読み、
   `role: "assistant"` の `content[].type == "toolCall"` を集計する。
   ツール別の呼び出し回数、
   `spawn_agents` の `tasks[]` の各フィールド(agent / task / name / model / cwd / resume_run_id)と
   `message_agent` の `target_run_id` / `text` の使用率、
   `role: "toolResult"` のエラー(`details.error` か `Validation failed for tool`)を出す。
   - 開発セッションの意図的な不正 agent テストは誤用と数えず、通常利用と分ける。
   - 文字列 grep で `"name":"spawn_agents"` を数えると、システムプロンプトの `toolsAdded` を
     拾って過大になる。必ず toolCall パートをパースする。
3. 判定: トークン占有率と使用率を突き合わせる。
   - 余剰候補: トークンが大きく使用率が低い引数(`model` / `resume_run_id` 等)。
   - 不足: 誤用エラー。エラー本文が回復情報(定義済み agent 一覧等)を返せているか。
   - カタログは agent 定義数に比例して伸びるため、定義を増やした時に測る。
4. 記録: 計測値は契約テストのコメントに反映する(変更時の手順と同じ)。
