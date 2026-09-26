# pi-spawn

Pi の子エージェントを spawn し、**兄弟エージェント同士が直接メッセージをやり取り**できる拡張。

- 子は並列に動き、親は全員の完了を待って結果をまとめて受け取る(バックグラウンド実行はしない)
- 子セッションは親と同じプロセスで動く
- 既定の子は子を spawn できない(委譲の深さは 1)。定義に `extensions: true` を書いた子だけが、拡張と一緒に `spawn_agents` を受け取る

## 動作条件

| | |
|---|---|
| Pi | インストール済みであること。0.87.1 で検証(他のバージョンは未検証) |
| Node.js | 22.19.0 以上 |

## インストール

GitHub から入れる:

```bash
pi install git:github.com/kurowashi/pi-spawn
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-spawn@<tag|commit>`。追加後は Pi を
再起動すると読み込まれ、`pi list` に現れる。

ローカルの作業コピーを使う場合は `~/.pi/agent/settings.json` の `packages` に、**その
settings.json からの相対パス**で追加する:

```json
{
	"packages": ["../../pi-plugins/pi-spawn"]
}
```

## エージェント定義

子にする agent は `~/.pi/agent/agents/*.md` に用意する。ファイル名は任意で、frontmatter の
`name` が呼び出し名になる。

`~/.pi/agent/agents/reviewer.md` の例:

```markdown
---
name: reviewer
description: ドキュメントのレビュー役
tools: read, grep
thinking: high
---

あなたはレビュアーです。指摘は根拠とセットで返してください。
```

| キー | 必須 | 意味 |
|---|---|---|
| `name` | ○ | 呼び出しに使う名前 |
| `description` | | モデルに渡す説明 |
| `tools` | | 子に許可するツール。カンマ区切り文字列か配列。空リストなら `message_agent` のみ。無指定なら利用可能な全ツール。子に無い名前は無視される |
| `model` | | 既定モデル。`provider/id` 形式 |
| `thinking` | | 推論強度(off / minimal / low / medium / high / xhigh / max) |
| `systemPromptMode` | | `append`(既定、本文を Pi のプロンプトに追加)/ `replace`(本文のみ) |
| `inheritProjectContext` | | 作業ディレクトリの `AGENTS.md` を子に渡すか(既定 true) |
| `inheritSkills` | | 利用可能な skills を子に渡すか(既定 true) |
| `extensions` | | 子セッションでグローバル設定の `packages`(拡張)をロードするか(既定 false) |

- 本文(例の「あなたはレビュアーです…」)は既定で Pi のシステムプロンプトに追加される
- 未知のキー(`async` など)は警告して無視する
- 同名の定義が複数ある場合はファイル名順で先勝ち。編集は次に spawn する子から反映される
- 定義の一覧はモデルに `agents: <name> — <description>` の1行として注入される
- `extensions: true` の子は MCP などの拡張をロードし、`spawn_agents` も受け取る。多段委譲は階層ごとに true が要る
- 他の agent(`writer` など)も同じ形式で `~/.pi/agent/agents/` に作る

## 使い方

親セッションから `spawn_agents` を呼ぶ。子は `message_agent` を持ち、兄弟に連絡できる。

```text
spawn_agents({
  tasks: [{ agent, task, model?, cwd? }, ...],
  context?: "fresh" | "fork",
  timeout_seconds?: number
})

message_agent({ to, text, wait_for_reply? })   // 子のみ
```

| 引数 | 場所 | 意味 |
|---|---|---|
| `tasks` | `spawn_agents` | 起動する子の一覧(1件以上)。1件なら単独委譲 |
| `agent` / `task` | `tasks[]` | 定義の `name` / 子への指示 |
| `model` | `tasks[]`(任意) | 子のモデルを上書き(`provider/id` 形式) |
| `cwd` | `tasks[]`(任意) | 子の作業ディレクトリ(既定は親と同じ) |
| `context` | `spawn_agents`(任意) | `fresh`(既定、空の文脈)/ `fork`(この会話をコピー) |
| `timeout_seconds` | `spawn_agents`(任意) | 呼び出し全体の制限時間(秒)。過ぎたら全子を中断する |
| `to` / `text` / `wait_for_reply` | `message_agent`(子のみ) | 宛先(agent 名か run id)/ 本文 / 返信を待つか(既定 false) |

単独で委譲する:

```text
spawn_agents({ tasks: [{ agent: "reviewer", task: "README の下書きをレビューして" }] })
```

並列に走らせ、子同士で相談させる:

```text
spawn_agents({
  tasks: [
    { agent: "writer", task: "下書きを書いて。不明点は reviewer に message_agent で聞くこと" },
    { agent: "reviewer", task: "構成案をレビューして" }
  ]
})
```

`wait_for_reply: true` で送ったメッセージは、宛先の次の発話が戻り値になる(返信が無ければ 120 秒でエラー)。
run id は呼び出しごとに決まる子の識別子。同じ agent を複数走らせたとき、agent 名での宛先は
曖昧になるため run id を使う。兄弟がいる子のタスク先頭には宛先一覧が自動で付く:

```text
Siblings you can message with message_agent: reviewer (a1b2c3d4), writer (e5f6a7b8)
```

呼び出し結果は `{ agent, run_id, model, output }` の配列。run が失敗した場合は `output` の
代わりに `error` が入る。未知の agent や解決できない `model` は、何も起動せずにエラーになる。

## できること

| できる | 内容 |
|---|---|
| 単一委譲 | `tasks` に1件渡し、完了を待って出力を受け取る |
| 並列委譲 | 複数件を同時に走らせ、全員の完了を待って全結果を受け取る |
| 失敗の切り分け | 子の失敗はその子の結果に `error` として入り、兄弟の結果は失われない |
| 子同士の会話 | 兄弟を agent 名か run id で指定し、`wait_for_reply: true` で返信も受け取れる |
| 兄弟の把握 | 兄弟がいる子のタスク先頭に宛先一覧が自動で付く |
| モデル解決 | `tasks[].model` → 定義の `model` → 親セッションのモデルの順。実際に使われたモデルは結果に必ず入る |
| 配送 | 実行中の兄弟には今のターンの切れ目で届き、待機中の兄弟には新しいターンで届く。配送で始まったターンの完了も待ってから返る |
| ハング防止 | 兄弟待ちのデッドロックを防ぎ、親ターンの中止にも追従する |
| 使用量の把握 | 子のトークンとコストを結果の `usage` に含め、親セッションの統計にも加算する |
| 進捗の表示 | 実行中は1秒ごとに各子の最新活動(ツール名など)と経過時間がツール表示に流れる |
| 子ログの保存 | 子セッションを `~/.pi/agent/spawn-sessions/` に保存する。全文は結果の `session_file` のパスを `pi --session` で開く |

## できないこと

すべて意図的な非目標。

| できない | 代替 |
|---|---|
| バックグラウンド実行(親を待たせない) | 親は待つしかない。長い作業は小さく分割して順に spawn する |
| 終わった子への追加指示(resume) | 新しい spawn でやり直す |
| 子から親への質問(返答待ち) | タスク文に判断基準を書く。結果に「未決」と選択肢を書かせる |
| 親から実行中の子への指示 | タイムアウトで止めて出し直す |
| 実行中の子の全文をその場で見る | 進捗は活動ラベルで見える。全文は完了後に `pi --session` で開く |
| 並列での書き込み隔離 | 読み取り中心のタスクに限定する。`cwd` を分けても同一リポジトリの編集は衝突する |
| 子の出力の自動検証 | 親がテストや差分確認を実行する |
| コスト上限の強制 | コストは結果と Pi のセッション統計で確認できる。上限は無い |

「バックグラウンド実行」は全子の完了まで親のモデルターンを止める方針のため、「子から親への
質問」は親モデルが `spawn_agents` の実行中で返答できないため、どちらも成立しない。

## 開発

pi-spawn 自体を開発する場合の手順。実行時依存はなく、依存はすべて devDependency。

```bash
npm install
npm run verify        # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test              # 全テスト
npm run test:coverage # unit と integration だけをカバレッジ閾値付きで
npm run fix           # 自動修正
```

コミット前に lefthook が format/lint/型検査を実行する。CI はフックと同じ検査を独立に実行する
(フックは利便性のためのもので、ゲートの権威ではない)。ツール定義の大きさは契約テストが
400 トークン以下に拘束する。

フックの有効化は `npx lefthook install` を手動で実行する。`package.json` の lifecycle script
(`prepare` / `postinstall`) には置かない: `pi install git:...` は `npm install --omit=dev` を
実行するため、devDependency の lefthook が無い状態で script が走るとインストールごと失敗する。