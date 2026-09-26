# AGENTS.md — pi-spawn の制約

このファイルには**機械的に検証できるルールだけ**を書く。検証手段を併記できないルールは、
規約ではなく希望なので書かない。

## 制約

| 制約 | 検証 |
|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` |
| `src` の import は node builtin / 相対 `.ts` / Pi 提供パッケージの3種のみ | `test/contract/dependencies.test.ts` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` |
| 登録ツールは `spawn_agent` と `message_agent` の2つだけ | `test/contract/tool-surface.test.ts` |
| ツール定義(説明+スキーマ)の合計が予算内 | `test/contract/budget.test.ts` |
| ツール説明は 160 文字以内 | `test/contract/tool-surface.test.ts` |
| トップレベル引数は 6 個以内、スキーマは `additionalProperties: false` | `test/contract/tool-surface.test.ts` |
| 配布物は `src/` とメタデータのみ | `test/ci/package-contents.test.ts` |
| `enum` / `namespace` / parameter properties を使わない | `tsc`(`erasableSyntaxOnly`) |
| 型は `any` なし、非null断言なし、浮いた Promise なし | Biome(`noExplicitAny`, `noNonNullAssertion`, `noFloatingPromises`) |
| `console` を使わない | Biome(`noConsole`) |
| 認知複雑度は 12 以下 | Biome(`noExcessiveCognitiveComplexity`) |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `tsc` + Node 実行 |
| ビルド工程を持たない(TS を直接配布) | `package.json` に build script なし + `pi.extensions` が `./src/index.ts` |

## 変更時の手順

- ツールを増やす・引数を増やす場合は、先に `docs/adr/` に決定を記録し、予算テストの数値を更新する。
  予算は「上げるもの」ではなく「交渉するもの」として扱う。
- 依存を追加する場合は devDependency allowlist の更新と ADR をセットで行う。
- 完了条件は `npm run verify` が通ること。フックが通っても CI が通らなければ未完了。

## 現時点で実装されていないもの

`src/tools/*.ts` の `execute` は Step 2 まで意図的に `throw` する。ツール面(名前・説明・スキーマ)は
確定しており、契約テストの対象はそこである。
