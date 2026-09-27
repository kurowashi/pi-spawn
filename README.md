# pi-spawn

Pi から子エージェントを並列に起動し、
**兄弟エージェント同士が直接メッセージをやり取り**できる拡張です。インストール後、
プロジェクトまたはホームディレクトリの `agents/*.md` に子を定義し、
親セッションから `spawn_agents` で起動します。

## 実行モデル

- **親セッション**: いまの Pi セッション。`spawn_agents` で子を起動し、全子の結果を受け取ります
- **子セッション**: 親から委譲された1つのタスクを実行します
- **兄弟**: 同じ `spawn_agents` 呼び出しで起動された子同士。`message_agent` で直接連絡できます

`spawn_agents` は同期的なツール呼び出しです。親のターンは `spawn_agents` から戻るまで終了せず、
全子と、メッセージで始まったターン(兄弟からのメッセージで始まるターン)の完了を待ちます。そのため、
親を待たせずに子をバックグラウンド実行することはできません。

待機するのは親だけです。子は他のセッションを待ちません。

| 待つ側 | 待たれる側 | 条件 |
|---|---|---|
| 親 | 全子と、メッセージで始まったターン | 常に。`spawn_agents` が返るまで |

- 親は `spawn_agents` の実行中は応答できないため、子から親セッションへ質問はできません。
  判断基準はタスク文で渡し、曖昧さは spawn 前に親が人間へ確認します
- 親のターンが中止されると、子も中断されます

### 子セッションの既定

- 委譲の深さは既定で 1 です。子を起動できるのは、定義に `extensions: true` を書いた子だけです
- 子の作業ディレクトリは既定で親と同じです
- 子の会話文脈は既定で空(`fresh`)です。`context: "fork"` のときだけ親の会話をコピーします
- 子セッションは `~/.pi/agent/spawn-sessions/` に保存されます

## 前提条件

| 項目 | 条件 |
|---|---|
| Pi | インストール済みであること。0.87.1 で検証(他のバージョンは未検証) |
| Node.js | 22.19.0 以上 |

## インストール

### GitHub からインストールする

通常はこちらを使います。

```bash
pi install git:github.com/kurowashi/pi-spawn
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-spawn@<tag|commit>`。

### ローカルの作業コピーを使う

pi-spawn を開発している場合は、`~/.pi/agent/settings.json` の `packages` に、
**その settings.json からの相対パス**で追加します。既存の要素は残してください。

```json
{
	"packages": ["../../pi-plugins/pi-spawn"]
}
```

どちらの場合も、追加後は Pi を再起動すると読み込まれ、`pi list` に現れます。

## 子エージェントの定義

子にする agent は 2 箇所の `agents/*.md` に用意します。ファイル名は任意で、
frontmatter の `name` が呼び出し名になります。
プロジェクト側の定義は project trust(Pi がプロジェクトを信頼済みとして扱う状態)のときだけ読みます。
信頼は起動時の `--approve` か `/trust` で与えます。

| 場所 | 用途 | 必要条件 |
|---|---|---|
| `<project>/.pi/agents/*.md` | プロジェクト固有の定義 | project trust |
| `~/.pi/agent/agents/*.md` | 全プロジェクト共通の定義 | なし |

同じ `name` の定義が複数ある場合は、プロジェクト側が優先されます。
同じ場所ではファイル名の昇順で最初の1件だけが有効です(カタログにも1件だけ表示されます)。

必須は `name` と本文だけです。次の例の `description` は任意で、
モデルが子を選ぶときの説明になります。

```markdown
---
name: reviewer
description: ドキュメントのレビュー役
---

あなたはレビュアーです。指摘は根拠とセットで返してください。
```

### frontmatter の項目

| キー | 必須 | 既定 | 意味 |
|---|---|---|---|
| `name` | ○ | — | 呼び出しに使う名前 |
| `description` | | — | モデルに渡す説明 |
| `tools` | | すべてのツール | 子に許可するツール |
| `model` | | 親セッション | 使用モデル(`provider/id` 形式) |
| `thinking` | | Pi の既定 | 推論強度(off / minimal / low / medium / high / xhigh / max) |
| `systemPromptMode` | | `append` | 本文の適用方法(`append` / `replace`) |
| `inheritProjectContext` | | true | 作業ディレクトリの `AGENTS.md` を子に渡すか |
| `inheritSkills` | | true | skills を子に渡すか |
| `extensions` | | false | グローバル設定の拡張を子で読み込むか |

- `tools`: カンマ区切りの文字列か配列で指定します。空リストなら子専用ツール(`message_agent`)だけ、
  無指定なら利用可能な全ツールを許可します。子が持たない名前は無視します
- `model`: 使用モデルは `tasks[].model` → 定義の `model` → 親セッションの順で決まります
- 本文: 既定で Pi のシステムプロンプトに追加されます。
  `systemPromptMode: replace` なら本文だけになります
- `extensions: true`: MCP などの拡張を読み込み、子は `spawn_agents` も受け取ります
- 値が不正な項目は警告して無視します(`systemPromptMode` は `append` に戻します)

### 定義の反映

- 未知のキー(`async` など)は警告して無視します
- 定義の変更は次に子を起動したときから反映されます
- 定義の一覧はモデルに `agents: <name> — <description>` の1行として注入されます

## 基本的な使い方

親セッションから `spawn_agents` を呼びます。子は並列に動き、全員の完了後に結果が返ります。

```text
spawn_agents({
  tasks: [{ agent, task, model?, cwd?, resume_run_id? }, ...],
  context?: "fresh" | "fork",
  timeout_seconds?: number
})
```

| 引数 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `tasks` | ○ | — | 同時に走らせるタスク(1件以上) |
| `tasks[].agent` | ○ | — | 子エージェント定義の `name` |
| `tasks[].task` | ○ | — | 委譲するタスク文 |
| `tasks[].model` | | 定義の `model` | 使用モデルの上書き(`provider/id`) |
| `tasks[].cwd` | | 親と同じ | 子の作業ディレクトリ |
| `tasks[].resume_run_id` | | — | 再開する run の id |
| `context` | | `fresh` | `fresh`(空) / `fork`(親の会話をコピー) |
| `timeout_seconds` | | 制限なし | 呼び出し全体の制限時間(秒) |

単独で委譲する:

```text
spawn_agents({ tasks: [{ agent: "reviewer", task: "README の下書きをレビューして" }] })
```

並列に走らせる:

```text
spawn_agents({
  tasks: [
    { agent: "writer", task: "構成案を書いて" },
    { agent: "reviewer", task: "構成案をレビューして" }
  ]
})
```

実行中は1秒ごとに、各子の状態がツール表示に流れます。子1体につき1行で、次の順に表示します。

- 名前と run id
- 最新活動(`thinking` / `writing` / `tool: bash` など)
- 経過時間
- 最新出力の1行(子がテキストを出力した後だけ表示。最後の非空行で、80文字を超える分は `...` で省略)

実行中に表示するのは最新出力の1行だけです。全文は子セッションに残り、
完了後に結果の `session_file` を `pi --session <path>` に渡して開きます。

## 子同士のメッセージ

子は `message_agent` で兄弟にメッセージを送ります。`message_agent` は子専用です。使わせるには、
タスク文で指示します:

```text
spawn_agents({
  tasks: [
    { agent: "writer", task: "下書きを書いて。不明点は reviewer に message_agent で質問すること" },
    { agent: "reviewer", task: "構成案をレビューして" }
  ]
})
```

```text
message_agent({ to, text })
```

| 引数 | 必須 | 意味 |
|---|---|---|
| `to` | ○ | 宛先。兄弟の agent 名か run id |
| `text` | ○ | 送る本文 |

### 配送とターン

メッセージは一方通行です。送信側のツール結果は `delivered` で、相手の返答は返りません。
返答は受け手の新しいターンとして届きます。

- 待機中の兄弟へは、新しいターンを開始して届きます
- 実行中の兄弟へは、今のターンの切れ目で届きます

### 宛先の指定

- run id: 呼び出しごとに決まる子の識別子です。結果の見出し `[agent] run_id (model)` に載ります
- agent 名: 同じ agent が複数走っていると曖昧になるため、run id を使ってください
- 兄弟がいる子のタスク先頭には宛先一覧が自動で付きます

```text
Siblings you can message with message_agent: reviewer (a1b2c3d4), writer (e5f6a7b8)
```

## 実行結果

呼び出し結果は run ごとの結果の配列です。

| フィールド | 意味 |
|---|---|
| `agent` | 定義名 |
| `run_id` | run の識別子。`resume_run_id` に渡すと再開できます |
| `model` | 実際に使われたモデル |
| `resumed_from` | 再開元の run id(再開した run だけ) |
| `output` | 最後の発話。メッセージで始まったターンの発話も含みます |
| `error` | 失敗した run だけに入ります。このとき `output` はありません |
| `usage` | 子のトークンとコスト。親セッションの統計にも加算されます |
| `session_file` | 子セッションの保存先。全文は `pi --session <path>` で開けます |

- 再開した run の `usage` は、再開後に加算された分だけです
- run が失敗しても、兄弟の結果は失われません
- 未知の agent や解決できない `model` は、何も起動せずにエラーになります
- `timeout_seconds` は呼び出し全体の制限時間(秒)です。無指定なら制限はありません。
  過ぎたら全子を中断します

## 高度な使い方

### 親の会話文脈を引き継ぐ

`spawn_agents({ context: "fork" })` で、親の会話をコピーした状態から子を始めます。
既定は `fresh`(空の文脈)です。

### run を再開する

`tasks[].resume_run_id` に以前の run id を渡すと、その子セッションを読み直し、
同じ文脈の続きとして `task` を実行します。

- `agent` / `model` / `cwd` は今回の指定が使われます
- run は起動時の `cwd` で探索するため、
  別の `cwd` で起動した run を再開するときは同じ `cwd` を渡します
- 再開できるのは run id をセッション id として保存した run だけです

### 子にさらに委譲する(多段委譲)

子に `spawn_agents` を使わせるには、その子の定義に `extensions: true` を書きます。
親 → 子 → 孫と委譲する場合、委譲する各階層で `extensions: true` が必要です。

## 制約と回避策

これらはすべて意図的な制約です。
待機モデルに由来する理由は [実行モデル](#実行モデル) で説明しています。

| 制約 | 回避策 |
|---|---|
| バックグラウンド実行(親を待たせない) | 長い作業は分割して順に起動する |
| 子から親セッションへの質問 | タスク文に判断基準を書く。曖昧さは spawn 前に解消する |
| 子が同一ターン内で返信を待つ | 返信は次のターンで届く。会話はターンで進める |
| 親から実行中の子への指示 | タイムアウトで止めて出し直す |
| 実行中の子の全文をその場で見る | 実行中は最新出力の1行のみ。完了後に `session_file` を `pi --session <path>` に渡して開く |
| 並列での書き込み隔離 | 読み取り中心のタスクに限定する |
| 子の出力の自動検証 | 親がテストや差分確認を実行する |
| コスト上限の強制 | 上限はない。結果の `usage` とセッション統計で確認する |

## 開発者向け情報

この節は pi-spawn 自体を開発する人向けです。実行時依存はなく、依存はすべて devDependency です。
コマンドはリポジトリのルートで実行します。

```bash
npm install
npm run verify
npm test
npm run test:coverage
npm run fix
```

- `npm run verify`: 完了条件を検証します(biome + tsc + 全テスト + カバレッジ閾値)
- `npm test`: 全テストを実行します
- `npm run test:coverage`: unit と integration だけをカバレッジ閾値付きで実行します
- `npm run fix`: 自動修正を実行します

コミット前に lefthook が format/lint/型検査を実行します。
CI はフックと同じ検査を独立に実行します(フックは利便性のためのもので、ゲートの権威ではありません)。
契約テストが、ツール定義の大きさを 400 トークン以下に制限しています。

フックの有効化は `npx lefthook install` を手動で実行します。
`package.json` の lifecycle script(`prepare` / `postinstall`)には置きません:
`pi install git:...` は `npm install --omit=dev` を実行するため、
devDependency の lefthook が無い状態で script が走るとインストールごと失敗します。
