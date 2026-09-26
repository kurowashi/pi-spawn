# AGENTS.md — pi-spawn の制約

このファイルには**機械的に検証できるルールだけ**を書く。検証手段を併記できないルールは、
規約ではなく希望なので書かない。手動でしか確認できない範囲は末尾に区分して示す。

## 検証コマンド

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が完了条件。
下表の「検証」列は個別の検証箇所であり、すべて `verify` に含まれる。

## 制約

| 制約 | 検証 | 上限・許可の定義箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | 同上 | 同ファイルの `ALLOWED_PEER_DEPENDENCIES` |
| devDependency は allowlist 内のみ | 同上 | 同ファイルの `ALLOWED_DEV_DEPENDENCIES` |
| 登録ツールは親の `spawn_agents` と子の `message_agent` の2つだけ | `test/contract/tool-surface.test.ts` | 同ファイルの `EXPECTED_PARENT_TOOLS` |
| 子は spawn 系ツールを受け取らない(深さ1固定) | 同上 | — |
| ツール定義(説明+スキーマ)の合計が **400 トークン**以内 | `test/contract/budget.test.ts` | 同ファイルの `TOKEN_BUDGET` |
| システムプロンプトへの agent カタログ注入が **120 トークン**以内 | 同上 | 同ファイルの `CATALOG_BUDGET`(5体×40字を上限とみなす) |
| ツール説明は **160 文字**以内 | `test/contract/tool-surface.test.ts` | `MAX_DESCRIPTION_CHARS` |
| トップレベル引数は 3 個以内、スキーマは `additionalProperties: false` | 同上 | `MAX_TOP_LEVEL_PARAMETERS` |
| 配布物は `src/` とメタデータのみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | 同上 | `biome.jsonc` |
| 認知複雑度は 12 以下 | 同上 | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

## 変更時の手順

- ツールを増やす・引数を増やす場合は、先に `docs/adr/` に決定を記録し、`TOKEN_BUDGET` を更新する。
  予算は「上げるもの」ではなく「交渉するもの」として扱う。上げた理由は ADR に残す。
- 依存を追加する場合は devDependency のみ可能。allowlist の更新と ADR をセットで行う。
  実行時依存(`dependencies`)の追加は不可。
- カバレッジは `test/unit` と `test/integration` で計測する(`package.json` の `test:coverage`)。
  契約テストは jiti 経由で `src` をもう一度ロードするため、同じファイルが2実体として数えられる。
- 完了条件は `npm run verify` が通ること。フックが通っても CI が通らなければ未完了。

## 手動確認が残る範囲(制約ではない)

`src/spawn.ts` の `createChildChannel` だけは実 SDK セッションを必要とするため自動テストの対象外。
ここは実モデルでのスモークテストで確認する: 2エージェントを並列 spawn し、片方からもう片方へ
`message_agent` で質問して返信が結果に現れること。
