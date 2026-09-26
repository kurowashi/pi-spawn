# AGENTS.md — pi-spawn で作業するエージェント向けの指示

読者は pi-spawn を変更する AI エージェントと開発者です。利用者向けの仕様は README に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは
制約として書かず、自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。下表の「検証」列は個別の検証箇所であり、
自動検証はすべて `verify` に含まれます。

## 制約

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | `test/contract/dependencies.test.ts` | 同ファイルの `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | 同ファイルの `ALLOWED_DEV_DEPENDENCIES` |
| ツール面は `spawn_agents`(親)/ `message_agent` / `ask_user`(対話 UI 時の子のみ)の3つだけ | `test/contract/tool-surface.test.ts` + 手動確認 | 同ファイルの `EXPECTED_PARENT_TOOLS`、`src/tools/child-tools.ts`、`src/spawn.ts` の `noExtensions` |
| ツール定義(説明+スキーマ)の合計が **400 トークン**以内 | `test/contract/budget.test.ts` | 同ファイルの `TOKEN_BUDGET` |
| ツール説明は **160 文字**以内 | `test/contract/tool-surface.test.ts` | 同ファイルの `MAX_DESCRIPTION_CHARS` |
| トップレベル引数は 3 個以内、スキーマは `additionalProperties: false` | `test/contract/tool-surface.test.ts` | 同ファイルの `MAX_TOP_LEVEL_PARAMETERS` |
| resume は永続化済みの run だけを対象にする(run id = セッション id、`cwd` 一致で探索) | `test/unit/spawn-tool.test.ts` の `findRunSession` | `src/tools/spawn-agents.ts` |
| 再開した run の usage は再開後の差分のみ | `test/unit/spawn.test.ts` + `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `subtractUsage` |
| 人間への質問は spawn 呼び出し単位で直列化される | `test/integration/spawn-agents.test.ts` | `src/spawn.ts` の `createAskQueue` |
| 配布物は `src/` と `package.json` / `README.md` のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

## 変更時の手順

- ツールを増やす・引数を増やす場合は、先に `docs/adr/` に ADR を起こして決定を記録し、`TOKEN_BUDGET` を更新する。
  予算は「上げるもの」ではなく「交渉するもの」として扱う。上げた理由は ADR に残す。
- 依存を追加する場合は devDependency のみ可能。allowlist の更新と ADR をセットで行う。
  実行時依存(`dependencies`)の追加は不可。
- カバレッジは `test/unit` と `test/integration` で計測する(`package.json` の `test:coverage`)。
  契約テストは jiti 経由で `src` をもう一度ロードするため、同じファイルが2実体として数えられる。

## 手動スモークテスト(自動検証の対象外)

`src/spawn.ts` の `createChildChannel` だけは実 SDK セッションを必要とするため自動テストの対象外。
ここは実モデルでのスモークテストで確認する:

1. 2エージェントを並列 spawn し、片方からもう片方へ `message_agent` で質問して返信が結果に現れること。
2. `extensions: true` の agent を spawn し、子から MCP ツールを1つ呼ばせて結果に現れること。
   呼び出しの終了後に MCP サーバーのプロセスが残っていないこと(`pgrep -f` などで確認)。
3. 既定の子(`extensions` 無し)からは `spawn_agents` を呼べないこと。
4. spawn した子のセッションが `~/.pi/agent/spawn-sessions/` に残り、結果の `session_file` と一致し、
   `pi --session <path>` で開けること。`context: "fork"` の子は親の履歴から始まること。
5. 子の実行中に `spawn_agents` の表示が1秒ごとに更新されること。完了後、親セッションのコスト統計に
   子の使用量が加算されていること(`/session` で確認)。
6. 子を spawn したときの run id を `resume_run_id` に渡して再 spawn し、前回の文脈を踏まえた返答が
   返ること。`session_file` が前回と同じで、usage が再開後の分だけであること。
7. 対話 UI で子から `ask_user` の質問が表示され、回答が子の結果に反映されること。print モードの
   子には `ask_user` が注入されないこと。
