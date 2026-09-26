# pi-spawn

Pi から子エージェントを並列に起動し、**兄弟エージェント同士が直接メッセージをやり取り**できる拡張です。

## 実行モデル

pi-spawn には親セッションと子セッションがあります。

- **親セッション**: いまの Pi セッション。`spawn_agents` で子を起動します
- **子セッション**: 親から委譲された1つのタスクを実行します
- **兄弟**: 同じ `spawn_agents` 呼び出しで起動された子同士です

`spawn_agents` は同期的なツール呼び出しです。親のターンは `spawn_agents` から戻るまで終了せず、
全子と、`message_agent` の配送で始まったターンの完了を待ちます。そのため、親を待たせずに子を
バックグラウンド実行することはできません。

親・子・兄弟の間で、処理の完了を待つ関係は次の2箇所だけです。

| 待つ側 | 待たれる側 | 条件 |
|---|---|---|
| 親 | 全子と、配送で始まったターン | 常に。`spawn_agents` が返るまで |
| メッセージを送った子 | 宛先の兄弟の返信 | `wait_for_reply: true` のときだけ(既定 false) |

- `wait_for_reply` が変えるのは送信元の子の動作だけです。false でも、配送で始まったターンは親が `spawn_agents` から戻るまで実行されます
- 親は `spawn_agents` の実行中で返答できないため、子から親モデルへ質問はできません。判断基準はタスク文で渡し、曖昧さは spawn 前に親が人間へ確認します
- 親のターンが中止されると、子も中断されます

子セッションの既定:

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

GitHub から入れます。

```bash
pi install git:github.com/kurowashi/pi-spawn
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-spawn@<tag|commit>`。追加後は Pi を
再起動すると読み込まれ、`pi list` に現れます。

ローカルの作業コピーを使う場合は `~/.pi/agent/settings.json` の `packages` に、**その
settings.json からの相対パス**で追加します。既存の要素は残してください。

```json
{
	"packages": ["../../pi-plugins/pi-spawn"]
}
```

## 子エージェントの定義

子にする agent は `~/.pi/agent/agents/*.md` に用意します。ファイル名は任意で、frontmatter の
`name` が呼び出し名になります。最小構成は `name` と本文だけです。

```markdown
---
name: reviewer
description: ドキュメントのレビュー役
---

あなたはレビュアーです。指摘は根拠とセットで返してください。
```

### frontmatter の項目

| キー | 必須 | 意味 |
|---|---|---|
| `name` | ○ | 呼び出しに使う名前 |
| `description` | | モデルに渡す説明 |
| `tools` | | 子に許可するツール |
| `model` | | 既定モデル(`provider/id` 形式) |
| `thinking` | | 推論強度(off / minimal / low / medium / high / xhigh / max) |
| `systemPromptMode` | | `append`(既定)/ `replace` |
| `inheritProjectContext` | | 作業ディレクトリの `AGENTS.md` を子に渡すか(既定 true) |
| `inheritSkills` | | skills を子に渡すか(既定 true) |
| `extensions` | | グローバル設定の拡張を子で読み込むか(既定 false) |

- `tools`: カンマ区切りの文字列か配列で指定します。空リストなら子専用ツール(`message_agent`)だけ、無指定なら利用可能な全ツールを許可します。子が持たない名前は無視します
- 本文: 既定で Pi のシステムプロンプトに追加されます。`systemPromptMode: replace` なら本文だけになります
- `extensions: true`: MCP などの拡張を読み込み、子は `spawn_agents` も受け取ります

### 定義の反映

- 未知のキー(`async` など)は警告して無視します
- 同名の定義が複数ある場合はファイル名順で先勝ちです
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

単独で委譲する:

```text
spawn_agents({ tasks: [{ agent: "reviewer", task: "README の下書きをレビューして" }] })
```

並列に走らせ、子同士で相談させる:

```text
spawn_agents({
  tasks: [
    { agent: "writer", task: "下書きを書いて。不明点は reviewer に message_agent({ wait_for_reply: true }) で質問し、返信を受けてから続行すること" },
    { agent: "reviewer", task: "構成案をレビューして" }
  ]
})
```

実行中は1秒ごとに、各子の最新活動(ツール名など)と経過時間がツール表示に流れます。

## 子同士のメッセージ

子は `message_agent` で兄弟にメッセージを送ります。`message_agent` は子専用です。

```text
message_agent({ to, text, wait_for_reply? })
```

| 引数 | 意味 |
|---|---|
| `to` | 宛先。兄弟の agent 名か run id |
| `text` | 送る本文 |
| `wait_for_reply` | 送信元の子が返信を待つか(既定 false) |

### 返信を待つ

- `wait_for_reply: false`(既定): 送信元の子は返信を待たずに続行します
- `wait_for_reply: true`: 送信元の子は、宛先の**次の発話1回分**を戻り値として受け取ります。宛先のタスク完了を待つものではありません。返信がなければ120秒でエラーになります
- どちらの指定でも、配送で始まったターンは親が `spawn_agents` から戻るまで実行されます
- すでに他の run の返信待ちを受けている兄弟へ、さらに返信待ちはできません(待ちの循環を防ぐため)

### 配送のタイミング

- 実行中の兄弟へは、今のターンの切れ目で届きます
- 待機中の兄弟へは、新しいターンを開始して届けます

### 宛先の指定

- run id: 呼び出しごとに決まる子の識別子です。結果の見出し `[agent] run_id (model)` に載ります
- agent 名: 同じ agent が複数走っていると曖昧になるため、run id を使ってください
- 兄弟がいる子のタスク先頭には宛先一覧が自動で付きます

```text
Siblings you can message with message_agent: reviewer (a1b2c3d4), writer (e5f6a7b8)
```

## 実行結果

呼び出し結果は `{ agent, run_id, model, output }` の配列です。run が失敗した場合は `output` の
代わりに `error` が入り、兄弟の結果は失われません。未知の agent や解決できない `model` は、
何も起動せずにエラーになります。

- `model`: 実際に使われたモデル。解決順は `tasks[].model` → 定義の `model` → 親セッションのモデルです
- `usage`: 子のトークンとコスト。再開した run では再開後に加算された分だけです。親セッションの統計にも加算されます
- `session_file`: 子セッションの保存先(`~/.pi/agent/spawn-sessions/`)。全文は `pi --session <path>` で開けます

`timeout_seconds` は呼び出し全体の制限時間(秒)です。無指定なら制限はありません。過ぎたら全子を
中断します。`wait_for_reply` の120秒はこれとは別です。

## 高度な使い方

### 親の会話文脈を引き継ぐ

`spawn_agents({ context: "fork" })` で、親の会話をコピーした状態から子を始めます。既定は
`fresh`(空の文脈)です。

### run を再開する

`tasks[].resume_run_id` に以前の run id を渡すと、その子セッションを読み直し、同じ文脈の続きと
して `task` を実行します。

- `agent` / `model` / `cwd` は今回の指定が使われます
- run は起動時の `cwd` で探索するため、別の `cwd` で起動した run を再開するときは同じ `cwd` を渡します
- 再開できるのは run id をセッション id として保存した run だけです

### 子にさらに委譲する(多段委譲)

子に `spawn_agents` を使わせるには、その子の定義に `extensions: true` を書きます。
親 → 子 → 孫と委譲する場合、委譲する各階層で `extensions: true` が必要です。

## 制約と回避策

すべて意図的な非目標です。待機モデルに由来する制約の理由は「実行モデル」で説明しています。

| 制約 | 回避策 |
|---|---|
| バックグラウンド実行(親を待たせない) | 長い作業は分割して順に起動する |
| 子から親モデルへの質問(返答待ち) | タスク文に判断基準を書く。曖昧さは spawn 前に親が解消する |
| 親から実行中の子への指示 | タイムアウトで止めて出し直す |
| 実行中の子の全文をその場で見る | 完了後に `pi --session` で開く(進捗は活動ラベル) |
| 並列での書き込み隔離 | 読み取り中心のタスクに限定する |
| 子の出力の自動検証 | 親がテストや差分確認を実行する |
| コスト上限の強制 | 結果の `usage` とセッション統計で確認する(上限なし) |

## 開発者向け情報

この節は pi-spawn 自体を開発する人向けです。実行時依存はなく、依存はすべて devDependency。

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
