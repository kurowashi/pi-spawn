# pi-spawn

Pi の子エージェントを spawn し、**兄弟エージェント同士が同一プロセス内で直接メッセージをやり取り**する拡張。
`pi-subagents` の代替として、必要なものだけを実装する。

- モデルに見せるツール面は 308 トークン(計測方法は [docs/foundation.md](docs/foundation.md) の「計測方法」)
- 子セッションは同一プロセス内。非同期実行(親が結果を待たずに制御を戻す起動)・別プロセス runner・
  run status ファイルを持たない
- 子は子を spawn できない(委譲の深さは 1 に固定)

## 動作条件

| | |
|---|---|
| Pi | 0.87.1 で検証(ローカルパッケージとして読み込む) |
| Node.js | `>= 22.19.0` を要求(`package.json` の `engines`) |

## インストール

`~/.pi/agent/settings.json` の `packages` に、**その settings.json からの相対パス**で追加する:

```json
{
	"packages": ["../../pi-plugins/pi-spawn"]
}
```

npm には公開していないため、これはローカル開発用の指定。追加後は Pi の再起動で読み込まれ、
`pi list` に現れる。

## 使い方

単独で委譲する場合:

```
spawn_agents({ tasks: [{ agent: "writer", task: "README の下書きを書いて" }] })
```

並列に走らせ、子同士で相談させる場合:

```
spawn_agents({
  tasks: [
    { agent: "writer", task: "下書きを書いて。不明点は reviewer に message_agent で聞くこと" },
    { agent: "document qualitiy reviewer", task: "構成案をレビューして" }
  ]
})
```

子は `message_agent({ to: "reviewer", text: "...", wait: true })` で返信まで受け取れる。
宛先は agent 名か run id。run id は呼び出し後に決まるため、各子のタスク先頭に
「メッセージできる兄弟: 名前 (run id)」として自動で通知される。

## できること

| できる | 内容 |
|---|---|
| 単一委譲 | `tasks` に1件渡し、その完了を待って出力を受け取る |
| 並列委譲 | 1回の呼び出しで 1〜8 件を同時に走らせ、**全員の完了を待って**全結果を受け取る |
| 失敗の切り分け | 子の失敗はその子の結果に `error` として入り、兄弟の結果は失われない |
| 子同士の会話 | 兄弟を agent 名か run id で指定し、`wait: true` で返信も受け取れる |
| 兄弟の把握 | 各子のタスク先頭に「メッセージできる兄弟: 名前 (run id)」が自動で付く |
| 文脈の選択 | `fresh`(空の文脈で開始、既定)または `fork`(この会話をコピーして開始) |
| モデル指定 | 優先順は `tasks[].model` → 定義の `model` → 親セッションのモデル。**実際に使われたモデルは結果に必ず入る** |
| 推論強度 | 定義の `thinking`(off / minimal / low / medium / high / xhigh / max) |
| ツール制限 | 定義の `tools` に列挙したものだけ。子は spawn 系ツールを受け取らない |
| タイムアウト | `timeout_ms` を過ぎたら全子を中断し、結果にエラーを返す |
| 既存定義の再利用 | `~/.pi/agent/agents/*.md` を読む。対応キーのみ有効で、未知キーは警告して無視する |
| 利用可能なエージェントの把握 | 一覧と説明がシステムプロンプトに1行で注入される |
| 実行中の宛先への配送 | 実行中の兄弟には次の安全点で届く(待機中の兄弟には次のターンで届く) |
| ハング防止 | 兄弟待ちのデッドロックを防ぎ、親ターンの中止にも追従する |

## できないこと

すべて意図的な非目標。機能ごとの全量比較(競合3実装 + pi-subagents)は
[docs/research.md](docs/research.md) にある。

| できない | 代替 |
|---|---|
| バックグラウンド実行(親を待たせない) | 親は待つしかない。長い作業は小さく分割して順に spawn する |
| 終わった子への追加指示(resume) | 新しい spawn でやり直す |
| 子から親への質問(返答待ち) | タスク文に判断基準を書く。結果に「未決」と選択肢を書かせる |
| 親から実行中の子への指示 | タイムアウトで止めて出し直す |
| 子の様子を見る(進捗・トランスクリプト) | 子に結果へ含めさせる |
| worktree の分離 | 読み取り中心のタスクに限定する。`cwd` を分けても同一リポジトリの並列編集の衝突は残る |
| 受け入れゲート・検証証跡 | 親が検証する |
| コスト・spawn 上限の統制 | Pi 本体のセッション統計 |
| mission・定期実行・watchdog | なし |
| 子への MCP ツール・外部 CLI | 親が使う。子は read / bash / edit / write と `message_agent` のみ |
| 子セッションの永続化 | 必要な内容は結果に含めさせる |

「バックグラウンド実行」と「子→親の質問」は、同期 spawn では親のモデルターンが停止しているため
**構造的に成立しない**([docs/research.md](docs/research.md) の発見節)。回避策(in-process の
バックグラウンド子)は保留として記録してあり、必要になれば ADR を起こして追加する。

## エージェント定義

`~/.pi/agent/agents/*.md` を pi-subagents 互換のサブセットで読む。

| キー | 意味 |
|---|---|
| `name` | 呼び出しに使う名前(必須) |
| `description` | システムプロンプトに注入される説明(40字まで) |
| `tools` | 子に許可するツール。子のツール名と交差させ、無いものは落とす |
| `model` | 既定モデル。`provider/id` 形式 |
| `thinking` | 推論強度 |
| `systemPromptMode` | `append`(既定、Pi のプロンプトに本文を追加)/ `replace`(本文のみ) |
| `inheritProjectContext` | AGENTS.md を子に渡すか(既定 true) |
| `inheritSkills` | skills を子に渡すか(既定 true) |

未知のキー(`async` や `fallbacks` など)は警告して無視する。**対応キーだけが有効**であり、
定義ファイルが読めることと全設定が反映されることは別である。

## 開発

```bash
npm install          # 依存(すべて devDependency。実行時依存はゼロ)
npm run verify       # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test             # 全テスト
npm run test:coverage # unit と integration だけをカバレッジ閾値付きで
npm run fix          # 自動修正
```

コミット前に lefthook が format/lint/型検査を実行する。CI は同じ検査を独立に実行する
(フックは利便性のためのもので、ゲートの権威ではない)。

`test:coverage` が `test/unit` と `test/integration` に限定されているのは、契約テストが
jiti 経由で `src` をもう一度ロードするため。同じファイルが2つのモジュール実体として数えられ、
未カバー扱いになるのを避けている。契約テストは `npm test` で実行される。

## 設計資料

- [`docs/foundation.md`](docs/foundation.md) — 土台(ツール選定・構成・制約・CI・計測方法)
- [`docs/research.md`](docs/research.md) — 競合3実装と pi-subagents の機能全量、実装状況
- [`docs/design.md`](docs/design.md) — 作るもの/作らないもの、モジュール構成、作業状態
- [`docs/adr/`](docs/adr) — 決定の記録
- [`AGENTS.md`](AGENTS.md) — 機械的に検証できる制約のみ
