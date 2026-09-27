# AGENTS.md — pi-spawn で作業するエージェント向けの指示

読者は pi-spawn を変更する AI エージェントと開発者です。利用者向けの仕様は README に、
設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

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
| ツール面は `spawn_agents`(親)/ `message_agent`(子)の2つだけ | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `EXPECTED_PARENT_TOOLS`、`src/tools/child-tools.ts`、`src/spawn.ts` の `noExtensions` |
| ツール定義(説明+スキーマ)の合計が **400 トークン**以内 | `test/contract/budget.test.ts` | `test/contract/budget.test.ts` の `TOKEN_BUDGET`(計測値はコメント) |
| ツール説明は **160 文字**以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_DESCRIPTION_CHARS` |
| トップレベル引数は 3 個以内 | `test/contract/tool-surface.test.ts` | `test/contract/tool-surface.test.ts` の `MAX_TOP_LEVEL_PARAMETERS` |
| スキーマは `additionalProperties: false` | `test/contract/tool-surface.test.ts` | `src/tools/*.ts` |

### カタログ・resume・usage

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| カタログは同名 agent を1件だけ表示する(ファイル名の昇順で最初の定義) | `test/unit/catalog.test.ts` | `src/catalog.ts` の `formatCatalog` |
| 定義の解決順は project → user。project 定義は trust 済みのときだけ読む | `test/unit/catalog.test.ts` + `test/integration/spawn-agents.test.ts` | `src/catalog.ts` の `definitionRoots` / `discoverAgents` |
| resume は永続化済みの run だけを対象にする(run id = セッション id) | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` |
| resume の探索は `cwd` 一致で行う | `test/unit/spawn-tool.test.ts` | `src/tools/spawn-agents.ts` |
| 再開した run の usage は再開後の差分のみ | `test/unit/spawn.test.ts` + `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `subtractUsage` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
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
- 依存を追加する場合は devDependency のみ可能。allowlist の更新とコミットメッセージの理由をセットで行う。
  実行時依存(`dependencies`)の追加は不可。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、
  却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受けます。契約テストは jiti 経由で `src` をもう一度ロードするため、
  同じファイルが2実体として数えられます。

## 手動確認項目(自動検証の対象外)

`src/spawn.ts` の `createChildChannel` だけは実 SDK セッションを必要とするため自動テストの対象外です。
ここは実モデルで確認します。

1. 2エージェントを並列 spawn し、片方からの `message_agent` が相手の新しいターンを起こし、会話後の最新の発話が結果に現れること。
2. `extensions: true` の agent を spawn し、子から MCP ツールを1つ呼ばせて結果に現れること。
   呼び出しの終了後に MCP サーバーのプロセスが残っていないこと(`pgrep -f` などで確認)。
3. 既定の子(`extensions` 無し)からは `spawn_agents` を呼べないこと。
4. spawn した子のセッションが `~/.pi/agent/spawn-sessions/` に残り、結果の `session_file` と一致し、
   `pi --session <path>` で開けること。`context: "fork"` の子は親の履歴から始まること。
5. 子の実行中に `spawn_agents` の表示が1秒ごとに更新されること。各子の1行に最新活動と経過時間が出て、
   子がテキストを出力した後は最新出力の1行も出ること(80文字を超える分は `...` で省略)。完了後、
   親セッションのコスト統計に子の使用量が加算されていること(`/session` で確認)。
6. 子を spawn したときの run id を `resume_run_id` に渡して再 spawn し、前回の文脈を踏まえた返答が返ること。
   `session_file` が前回と同じで、usage が再開後の分だけであること。
7. `<project>/.pi/agents/` の定義が、信頼していないプロジェクトではカタログに現れず spawn も失敗し、
   trust 済み(`--approve` など)では現れて spawn できること。

## 手動レビュー(自動検証の対象外): ツール面の必要十分性

トークン予算は契約テストが守るが、「そのコストが機能と実使用に見合うか」は自動化できない。
ツール面(説明・スキーマ・引数・カタログ)を変えた時と、定期的に確認する:

1. 計測: `spawn_agents` / `message_agent` の `name + description + JSON.stringify(parameters)` とカタログ行を、
   `test/contract/budget.test.ts` の `tokensOf` と同じ式(4文字=1トークン)でツール別・引数別に集計する。
2. 実使用: `~/.pi/agent/sessions/**/*.jsonl` と `~/.pi/agent/spawn-sessions/*.jsonl` を JSONL として読み、
   `role: "assistant"` の `content[].type == "toolCall"` を集計する。
   ツール別の呼び出し回数、`tasks[]` の各フィールドと `context` / `timeout_seconds` の使用率、
   `role: "toolResult"` のエラー(`details.error` か `Validation failed for tool`)を出す。
   - 開発セッションの意図的な不正 agent テストは誤用と数えず、通常利用と分ける。
   - 文字列 grep で `"name":"spawn_agents"` を数えると、システムプロンプトの `toolsAdded` を
     拾って過大になる。必ず toolCall パートをパースする。
3. 判定: トークン占有率と使用率を突き合わせる。
   - 余剰候補: トークンが大きく使用率が低い引数(`model` / `resume_run_id` 等)。
   - 不足: 誤用エラー。エラー本文が回復情報(定義済み agent 一覧等)を返せているか。
   - カタログは agent 定義数に比例して伸びるため、定義を増やした時に測る。
4. 記録: 計測値は契約テストのコメントに反映する(変更時の手順と同じ)。
