# AGENTS.md — pi-spawn で作業するエージェント向けの指示

読者は pi-spawn を変更する AI エージェントと開発者です。利用者向けの仕様は [README](README.md) に、
設計の判断基準は [DESIGN.md](DESIGN.md) と [PHILOSOPHY.md](PHILOSOPHY.md)(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、
自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm run knip` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所であり、
自動検証はすべて `verify` に含まれます。

## ローカル開発

依存は devDependency と、Pi が供給する peer 依存だけです。実行時依存(`dependencies`)はありません。コマンドはリポジトリのルートで実行します。

```bash
npm install
npm run verify
npm test
npm run test:coverage
npm run fix
```

- `npm run verify`: 完了条件を検証します（biome + tsc + 全テスト + カバレッジ閾値）
- `npm test`: 全テストを実行します
- `npm run test:coverage`: unit と integration だけをカバレッジ閾値付きで実行します
- `npm run fix`: 自動修正を実行します

コミット前に lefthook が format・lint・型検査を実行します。フックの有効化は `npx lefthook install` を手動で行います。`package.json` の lifecycle script（`prepare` / `postinstall`）には置きません。`pi install git:...` は `npm install --omit=dev` を実行するため、devDependency の lefthook がない状態で script が走るとインストールごと失敗します。CI はフックと同じ検査を独立に実行します。

## 制約

### ツール面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| この拡張が登録するツール面は `spawn_agents`(親)/ `message_agent`(子)の2つだけ | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `EXPECTED_PARENT_TOOLS`、`src/tools/child-tools.ts`、`src/spawn.ts` の `noExtensions` |
| 子のセッションは `session_start` を発火する(SDK は `bindExtensions` を呼ばないと発火しない) | 手動確認項目 2 | `src/spawn.ts` の `bindExtensions`、`docs/adr/0011-bind-child-extensions.md` |
| `extensions: true` の子は CLI と同じ内蔵拡張(codemode / tool_search / MCP)を使う | 手動確認項目 2 | `src/spawn.ts` の `extensionFactories` |
| 登録コマンドは `spawn` だけ | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `EXPECTED_COMMANDS`、`src/index.ts` |
| ツール定義(説明+スキーマ)の合計が **400 トークン**以内 | `test/contract/budget.test.ts` | `test/contract/budget.test.ts` の `TOKEN_BUDGET`(計測値はコメント) |
| ツール説明は **160 文字**以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_DESCRIPTION_CHARS` |
| トップレベル引数は 3 個以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_TOP_LEVEL_PARAMETERS` |
| スキーマは `additionalProperties: false` | `test/contract/tool-surface.test.ts` | `src/tools/*.ts` |
| 子ツールの引数は `target_session_id` と `text` だけ | `test/contract/tool-surface.test.ts` の `EXPECTED_PARAMETERS` | `src/tools/message-agent.ts` |
| 宛先は session id の完全一致のみ | `test/unit/deliver.test.ts` + `test/unit/message-agent.test.ts` | `src/registry.ts` の `resolveTarget` |
| 受信メッセージは `from_session_id` / `name` のヘッダーを持つ | `test/unit/deliver.test.ts` + `test/integration/spawn-agents.test.ts` | `src/deliver.ts` の `formatMessage` |
| ブリーフィングは `target_session_id=` / `name=` / `agent=` の KV で示す | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `siblingBriefing` |
| 解決エラーは live の session id だけを並べる | `test/unit/message-agent.test.ts` | `src/registry.ts` の `explainTarget` |
| 結果見出しは `session_id=<id> entry_id=<id>` で示す | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` の `formatResults` |
| 親履歴を継承し、読み出すのは定義の `inheritConversation: true` のときだけ | `test/unit/catalog.test.ts` + `test/integration/spawn-agents.test.ts` | `src/catalog.ts` の `parseAgent` + `src/spawn.ts` の `startRuns` |
| 継承した会話は親の現在の枝で終わり、破棄した枝を含まない | `test/integration/spawn-agents.test.ts` | `src/tools/spawn-agents.ts` の `spawnContext` + `src/spawn.ts` の `createSessionManager` |
| `spawn.json` の解決順はグローバル → trust 済み project。`0` は無制限 | `test/unit/config.test.ts` | `src/config.ts` |
| 制限時間の既定は 3600000ms | `test/unit/config.test.ts` | `src/config.ts` の `DEFAULT_CONFIG` |
| 解決した `timeoutMs` は spawn request に渡る | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` の `spawnRequest` |
| `/spawn status` は解決済みの `timeoutMs` と設定ファイルの解決元を通知する | `test/unit/spawn-command.test.ts` | `src/tools/spawn-command.ts` の `statusReport` |
| 制限時間に達した run は中断し、`timed out after ...` を返す | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `watchAborts` |
| 失敗した run は成功にせず、`aborted` / provider の `errorMessage` をエラーとして報告する | `test/unit/spawn.test.ts` + `test/unit/session-adapter.test.ts` | `src/spawn.ts` の `failureLabel` / `lastAssistantOutcome` |
| 兄弟の timeout は、自分の prompt が settle 済みの run の結果を書き換えない | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `promptSettled` |

### カタログ・resume・usage・表示名

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| カタログは同名 agent を1件だけ表示する(ファイル名の昇順で最初の定義) | `test/unit/catalog.test.ts` | `src/catalog.ts` の `formatCatalog` |
| カタログは `spawn_catalog` セクションとして注入し、プロンプトを固定しない | `test/contract/prompt-surface.test.ts` | `src/index.ts` の `before_agent_start` |
| 定義の解決順は project → user。project 定義は trust 済みのときだけ読む | `test/unit/catalog.test.ts` + `test/integration/spawn-agents.test.ts` | `src/catalog.ts` の `definitionRoots` / `discoverAgents` |
| resume は 2 フィールドの組で指定する(`resume_session_id` + `resume_entry_id`。両方必須) | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `resolveResume` |
| resume の entry は保存済みセッションに存在する | `test/integration/spawn-agents.test.ts` + `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` の `hasSessionEntry` |
| 再開した run は保存済みの session id を保ち、結果の組で再び再開できる | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `planRun` |
| 同じセッションを1呼び出しの複数タスクに指定できない | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `assertDistinctSessions` |
| resume の探索は `cwd` 一致で行う | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` |
| 再開した run の usage は再開後の差分のみ | `test/unit/spawn.test.ts` + `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `subtractUsage` |
| run の表示名は `tasks[].name`、無ければ agent 名、複数 run では連番 | `test/unit/spawn.test.ts` | `src/spawn.ts` の `displayNames` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` を持たない) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| 循環依存を作らない | `npx biome check .` | `biome.jsonc` の `noImportCycles` |
| 未宣言の依存を import しない(import 元パッケージの `package.json` へ先に宣言する) | `npx biome check .` | `biome.jsonc` の `noUndeclaredDependencies` |
| 未使用の export・依存・ファイルを検出しない | `npm run knip` | `knip.jsonc` |
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

## 手動確認

自動検証の対象外の確認は [docs/manual-checks.md](docs/manual-checks.md) に書きます。
