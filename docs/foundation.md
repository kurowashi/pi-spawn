# 土台

`pi-subagents` の実測値から出発し、監査可能な最小構成を選んだ記録。数値はすべて実測
(測定方法は末尾)。記録日: 2026-09-26。

## 出発点: pi-subagents 0.71.0 の実測

| 項目 | 実測 | この数値が支えた決定 |
|---|---|---|
| `subagent` description | 5,240 文字(full: 6,529 文字) | ツール面の予算をトークンで拘束する |
| `subagent` parameters | 12,985 文字 / トップレベル **82 プロパティ** | ツールは2つ、引数は3個までに固定する |
| ツール定義だけで常時消費 | 約 5,000 トークン | 遅延ロード機構を作らず、実物を小さくする |
| 同梱 skill | `SKILL.md` 8.7KB + `references/` 129KB(`execution-controls.md` だけで 51KB) | skill を同梱しない(運用手順は README) |
| 実装量 | 289 ファイル / 91,326 行 / 17MB | フォークして削るより新規に書く |
| 管理アクション | 49 種 | 管理操作を一切持たない |
| 子→子メッセージ | 無し(`contact_supervisor` は親セッション固定) | ここが本拡張の差分になる |
| async のモデル指定 | 同期版と別実装(別プロセスの runner に JSON で伝達)。CHANGELOG に同種の修正が繰り返し記録されている | 非同期実行を持たず、モデル解決を1経路にする |

結論: **機能を削るのではなく、要らないものを最初から書かない**。密結合(`workflowScript` が全機能の
ハブ)のため、フォークして削るコストは新規に書くコストを上回る。

## 決定事項

| 領域 | 決定 | 理由 |
|---|---|---|
| 名前 | `pi-spawn` | 動詞1語。主ツール `spawn_agents` と語が一致。既存版の系譜を主張しない |
| 配布形態 | 単一パッケージ、**ビルドなし**(TS 直配布) | Pi は jiti で `.ts` を直接ロードする。中間生成物を持つ理由がない |
| 実行時 | Node 24(engines `>=22.19.0`)ネイティブ type stripping | 追加トランスパイラ不要。`enum`/`namespace` は実行時に落ちるため、この制約は `tsc` でも強制する |
| 型検査 | TypeScript 7.0.2 `--noEmit` | ネイティブコンパイラが高速なため pre-commit に置ける。`erasableSyntaxOnly` の動作はこの環境で検証済み |
| lint / format | Biome 2.5(1本) | ESLint + Prettier + lint-staged の3点を1本に。`--staged` 内蔵で lint-staged 不要 |
| テスト | `node:test` + `node:assert` | 追加依存ゼロ。glob は `"test/**/*.test.ts"` を明示(`node --test test/` は Node 24 で動かないことを実測) |
| git hook | lefthook 2.1 | husky + lint-staged より設定が小さく並列実行できる(どちらも「フックを1つ増やす」以上の差はない) |
| CI | Node 22.19 と 24 の2本 | Pi の `engines` は `>=22.19.0`。type stripping の世代差を検知する |
| テスト配置 | `test/` を `src/` から分離 | 混在させると pi の拡張探索・`npm pack`・カバレッジの3箇所で除外設定が必要になる。分離すれば除外設定そのものが不要 |

### 却下したもの

- **遅延ロード機構**(`subagents_enable` 相当): 遅延ロードの目的は「有効化していないセッションの
  文脈を守ること」。ツール面が常時ロードできる大きさ(308 トークン)なら目的自体が消えるため、
  隠す仕組みを持たない。予算テストはその大きさを保つ別の手段であり、遅延ロードの代替ではない。
- **attw / publint**: TS 直配布では要求される `.d.ts` 成果物が存在しない。`npm pack --dry-run` は
  内容一覧しか見ないため、`exports` の解決可否やメタデータの妥当性は検証できない。
  そこは Pi の実ロードテスト(`test/helpers/extension.ts`)が担う。
- **changesets / publish ワークフロー**: 現時点で公開予定がなく、配布はローカルパス。
  npm 公開を決めた時点で導入する(それまでは `CHANGELOG` を持たない)。
- **dependency-cruiser**: 検査したいのは「import 元が3種に限られること」だけで、
  `test/contract/dependencies.test.ts` の正規表現1本で足りる。依存グラフの可視化は必要になったら考える。

## トークン予算

| 対象 | 実測 |
|---|---|
| `spawn_agents` | 218 tok(スキーマ 768 文字 / 説明 90 文字) |
| `message_agent` | 90 tok(スキーマ 285 文字 / 説明 59 文字) |
| **合計** | **308 tok** |

`test/contract/budget.test.ts` が上限 **400 トークン**で拘束する。実測 308 に対して 400 としたのは、
説明文の言い回し変更(数十文字)では壊れず、ツール追加や引数群の追加では落ちる幅にするため。
同じテストが agent カタログ注入にも 120 トークンの上限を課す(5体×40字を上限とみなす)。

## 計測方法

| 値 | 方法 |
|---|---|
| 文字数(description / parameters) | 手元の `pi-subagents` 0.71.0 のソースを `JSON.stringify(...).length` |
| トークン数 | 文字数 ÷ 4 の概算(依存を増やさないため。プロバイダのトークナイザを使っても判定は変わらない) |
| 実装量 | `find src -name '*.js' \| wc -l` と行数集計(配布物に含まれる JS) |
| `node_modules` のサイズ | `du -sh node_modules` |
| カバレッジ | `npm run test:coverage`(Node 組み込みのカバレッジ) |
| 測定環境 | 2026-09-26、`pi-subagents` 0.71.0、Pi 0.87.1、Node 24.21.0、TypeScript 7.0.2、Biome 2.5.14 |

数値は環境で変わる。再計測は同じ方法で行い、方法を変えたらこの表を更新する。

## 既知のトレードオフ

- **devDependencies の `node_modules` が 636MB**。Pi 本体を型解決のために丸ごと入れるため。
  配布物には一切含まれない(実行時依存はゼロ)。CI では npm キャッシュで吸収する。
- **jiti と Node の2つのローダー**で `src` が解釈される。両者は `erasableSyntaxOnly` と
  契約テスト(実ロード)で一致を強制している。

## 検証結果

土台の時点では biome / tsc グリーン、テスト 10 件、カバレッジ 100%(当時はツール面のみで、
`execute` は未実装だった)。現時点の値は [design.md の「現状」](design.md#現状)を参照。
