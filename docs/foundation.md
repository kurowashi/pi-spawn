# 土台(Step 1)

`pi-subagents` の実測値から出発し、監査可能な最小構成を選んだ記録。数値はすべて実測。

## 出発点: pi-subagents 0.71.0 の実測

| 項目 | 実測 |
|---|---|
| `subagent` description | 5,240 文字(full: 6,529 文字) |
| `subagent` parameters | 12,985 文字 / トップレベル **82 プロパティ** |
| ツール定義だけで常時消費 | 約 5,000 トークン |
| 同梱 skill | `SKILL.md` 8.7KB + `references/` 129KB(`execution-controls.md` だけで 51KB) |
| 実装量 | 289 ファイル / 91,326 行 / 17MB |
| 管理アクション | 49 種 |
| 子→子メッセージ | 無し(`contact_supervisor` は親セッション固定) |
| async のモデル指定 | 同期版と別実装(別プロセスの runner に JSON で伝達)。CHANGELOG に同種の修正が繰り返し記録されている |

結論: **機能を削るのではなく、要らないものを最初から書かない**。密結合(`workflowScript` が全機能の
ハブ)のため、フォークして削るコストは新規に書くコストを上回る。

## 決定事項

| 領域 | 決定 | 理由 |
|---|---|---|
| 名前 | `pi-spawn` | 動詞1語。主ツール `spawn_agent` と語が一致。既存版の系譜を主張しない |
| 配布形態 | 単一パッケージ、**ビルドなし**(TS 直配布) | Pi は jiti で `.ts` を直接ロードする。中間生成物を持つ理由がない |
| 実行時 | Node 24(engines `>=22.19.0`)ネイティブ type stripping | 追加トランスパイラ不要。`enum`/`namespace` は実行時に落ちるため、この制約は `tsc` でも強制する |
| 型検査 | TypeScript 7.0.2 `--noEmit` | ネイティブコンパイラが高速なため pre-commit に置ける。`erasableSyntaxOnly` の動作はこの環境で検証済み |
| lint / format | Biome 2.5(1本) | ESLint + Prettier + lint-staged の3点を1本に。`--staged` 内蔵で lint-staged 不要 |
| テスト | `node:test` + `node:assert` | 追加依存ゼロ。glob は `"test/**/*.test.ts"` を明示(`node --test test/` は Node 24 で動かないことを実測) |
| git hook | lefthook 2.1 | husky + lint-staged より設定が小さく並列実行 |
| CI | Node 22.19 と 24 の2本 | Pi の `engines` は `>=22.19.0`。type stripping の世代差を検知する |
| テスト配置 | `test/` を `src/` から分離 | 混在させると pi の拡張探索・`npm pack`・カバレッジの3箇所で除外設定が必要になる。分離すれば除外設定そのものが不要 |

### 却下したもの

- **遅延ロード機構**(`subagents_enable` 相当): ツール面が 267 トークンなら常時ロードで問題ない。
  予算テストが同じ役割を果たすため、機能を1つ消せる。
- **attw / publint**: TS 直配布では要求される `.d.ts` 成果物が存在しない。`npm pack --dry-run` の
  内容検証のほうが実効的で、依存も増えない。
- **changesets / publish ワークフロー**: ローカルパス install のため不要(YAGNI)。
- **dependency-cruiser**: import 境界は `test/contract/dependencies.test.ts` の約 30 行で足りる。

## トークン予算

| ツール | 実測 |
|---|---|
| `spawn_agent` | 162 tok(スキーマ 578 文字 / 説明 54 文字) |
| `message_agent` | 105 tok(スキーマ 321 文字 / 説明 82 文字) |
| **合計** | **267 tok** |

`test/contract/budget.test.ts` が上限 400 トークンで拘束する。説明文の言い回しを変えても壊れず、
ツールを1つ足すか引数群を足すと落ちる幅にしてある。

## 既知のトレードオフ

- **devDependencies の `node_modules` が 636MB**。Pi 本体を型解決のために丸ごと入れるため。
  配布物には一切含まれない(実行時依存はゼロ)。CI では npm キャッシュで吸収する。
- **jiti と Node の2つのローダー**で `src` が解釈される。両者は `erasableSyntaxOnly` と
  契約テスト(実ロード)で一致を強制している。

## 検証結果(この土台の時点)

```
biome check .       グリーン(11 ファイル)
tsc --noEmit        グリーン
node --test         10 passed
coverage            100% (lines / branches / funcs)
```
