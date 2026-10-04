# pi-spawn

Pi から子エージェントを並列に起動し、
**兄弟エージェント同士が直接メッセージをやり取り**できる拡張です。インストール後、
プロジェクトまたはホームディレクトリの `agents/*.md` に子を定義し、
親セッションから `spawn_agents` で起動します。実行中は `/spawn` で子の進捗・統計・ログを確認できます。

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
- 子の会話文脈は既定で空です。定義に `inheritConversation: true` を書いたときだけ親の会話をコピーします
- 子は永続する session id で識別します。再開は session id と entry id の組で位置を指定します
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
| `inheritConversation` | | false | 親の会話をコピーした状態から子を始めるか |
| `extensions` | | false | グローバル設定の拡張を子で読み込むか |

- `tools`: カンマ区切りの文字列か配列で指定します。空リストなら子専用ツール(`message_agent`)だけ、
  無指定なら利用可能な全ツールを許可します。
  子が持たない名前は無視します
- `model`: 使用モデルは `tasks[].model` → 定義の `model` → 親セッションの順で決まります
- 本文: 既定で Pi のシステムプロンプトに追加されます。
  `systemPromptMode: replace` なら本文だけになります
- `extensions: true`: MCP などの拡張を読み込み、子は `spawn_agents` も受け取ります
- `inheritConversation: true`: 親の会話をコピーした状態から子を始めます。既定は false(空の文脈)です。
  人間が定義で意図して指定するもので、モデルは呼び出しごとに選べません
- 値が不正な項目は警告して無視します(`systemPromptMode` は `append` に戻します)

### 定義の反映

- 未知のキー(`async` など)は警告して無視します
- 定義の変更は次に子を起動したときから反映されます
- 定義の一覧はモデルに `agents: <name> — <description>` の1行として注入されます

## 基本的な使い方

親セッションから `spawn_agents` を呼びます。子は並列に動き、全員の完了後に結果が返ります。

```text
spawn_agents({
  tasks: [{ agent, task, model?, cwd?, resume_session_id?, resume_entry_id? }, ...]
})
```

| 引数 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `tasks` | ○ | — | 同時に走らせるタスク(1件以上) |
| `tasks[].agent` | ○ | — | 子エージェント定義の `name` |
| `tasks[].task` | ○ | — | 委譲するタスク文 |
| `tasks[].name` | | agent 名(重複時は連番) | 表示用の短い名前 |
| `tasks[].model` | | 定義の `model` | 使用モデルの上書き(`provider/id`) |
| `tasks[].cwd` | | 親と同じ | 子の作業ディレクトリ |
| `tasks[].resume_session_id` | | — | 再開する子セッションの id |
| `tasks[].resume_entry_id` | | — | そのセッション内の再開位置(entry id)。`resume_session_id` と必ずセット |

`resume_session_id` と `resume_entry_id` は、以前の結果の `session_id` と `entry_id` をそのまま渡します。
2つは必ずセットで、片方だけではエラーになります。

`tasks[].name` は表示用の名前です。同じ agent を複数の役割で使うときの区別に使います。
未指定時は agent 名、同じ agent を複数起動したときは `writer-1` のように連番になります。

単独で委譲する:

```text
spawn_agents({ tasks: [{ agent: "reviewer", task: "README の下書きをレビューして" }] })
```

並列に走らせる:

```text
spawn_agents({
  tasks: [
    { agent: "writer", task: "構成案を書いて", name: "outline" },
    { agent: "reviewer", task: "構成案をレビューして", name: "review" }
  ]
})
```

実行開始時に各子の状態を表示し、その後は1秒ごとに更新します。
実行中に既定で見えるのは最新出力の1行だけです。詳しくは[実行中の子を見る](#実行中の子を見る)を参照してください。

## コマンド

| コマンド | 動作 |
|---|---|
| `/spawn` | 実行中 run の一覧から1件選び、ログを開きます |
| `/spawn <target>` / `/spawn logs <target>` | target の run のログを開きます |
| `/spawn status` | 解決済みの制限時間と設定ファイルの解決元を表示します |

target は session id だけです。一覧の選択肢には、進捗行と同じ情報に agent 名を加えたものを出します。

## 実行中の子を見る

`spawn_agents` は親のターンを占有しますが、その間も拡張コマンドは即座に実行されます。

### 進捗表示

子1体につき1行で、次の順に表示します。

- 表示名(`tasks[].name`。規則は引数表を参照)と `session_id=<id>`
- 最新活動(`thinking` / `writing` / `tool: bash` など。ターンが終わった子は `done`)
- 起動からの経過時間(`done` の子は完了時点で停止)
- 使用モデル、コンテキスト使用量(`ctx 12.3k/200k (6%)`)、コスト(0ドルのときは省略)
- 最新出力の1行(子がテキストを出力した後だけ表示。最後の非空行で、80文字を超える分は `...` で省略)

`done` はターンが終わった状態を意味し、兄弟からのメッセージで新しいターンが始まると `thinking` などに戻ります。

結果の表示(UI)は run ごとのブロックで、見出し・出力の抜粋・統計行(usage、コンテキスト、経過時間、`session_file`)を出します。
全文は `/spawn logs <target>` でライブ表示でき、完了後は結果の `session_file` を `pi --session <path>` に渡しても開けます。

### ログビュー

ログビューは子セッションの JSONL 末尾を0.7秒ごとに読み、次のタグを付けた行として表示します。

| タグ | 内容 |
|---|---|
| `[user]` / `[assistant]` | 発話 |
| `[tool:<name>]` / `[result:<name>]` / `[error:<name>]` | ツール呼び出し・結果・エラー |
| `[compacted]` / `[custom]` | コンパクション・その他のエントリ |

- 継続行は2スペース字下げし、1行は400文字を超える分を `...` で省略します

| キー | 動作 |
|---|---|
| `Esc` / `q` | 閉じる |
| `↑` / `k`、`↓` / `j` | 1行スクロール |
| `PgUp` / `PgDn` | ページスクロール |
| `f` / `End` | 最新に追従 |
| `t` / `Home` | 最古へ移動 |

### 完了後の扱い

- 一覧に出るのは実行中の run だけです。完了後は結果の `session_file` を `pi --session <path>` に渡して開きます
- run が完了するとステータス行が `finished` に変わり、以降の追記はありません(ビューは閉じるまで読み続けます)
- ログビューは TUI 専用です。RPC では要約の通知だけになり、print / JSON では何も表示しません

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
message_agent({ target_session_id, text })
```

| 引数 | 必須 | 意味 |
|---|---|---|
| `target_session_id` | ○ | 宛先の session id。タスク先頭の宛先一覧に載っています |
| `text` | ○ | 送る本文 |

### 配送とターン

メッセージは一方通行です。送信側のツール結果は `delivered` で、相手の返答は返りません。
返答は受け手の新しいターンとして届きます。

- 待機中の兄弟へは、新しいターンを開始して届きます
- 実行中の兄弟へは、今のターンの切れ目で届きます

### 宛先の指定

宛先は session id だけです。agent 名や `agent (session id)` のような表示形式は受け付けません。

- session id: 子セッションの永続 id(8桁)。結果の見出し `[name] session_id=<id> entry_id=<id> (model)` に載ります
- 兄弟がいる子のタスク先頭には、宛先一覧が `target_session_id=` / `name=` / `agent=` の形で自動で付きます

```text
Siblings you can message with message_agent:
- target_session_id=a1b2c3d4 name="review-1" agent="reviewer"
```

### 受信側が見るメッセージ

受け取った子には、送信元を明示したヘッダー付きで届きます。

```text
message_agent from_session_id=a1b2c3d4 name="review-1"

本文
```

返信するときは、この `from_session_id` を `target_session_id` に渡します。

## 実行結果

呼び出し結果は run ごとの結果の配列です。

| フィールド | 意味 |
|---|---|
| `name` | 表示名(`tasks[].name` と同じ規則) |
| `agent` | 定義名 |
| `session_id` | 子セッションの id。`resume_session_id` に渡すと再開できます |
| `model` | 実際に使われたモデル |
| `entry_id` | この run が終わった位置。`resume_entry_id` に渡すとここから再開できます |
| `output` | 最後の発話。メッセージで始まったターンの発話も含みます |
| `error` | 失敗した run だけに入ります。このとき `output` はありません |
| `usage` | 子のトークンとコスト。親セッションの統計にも加算されます |
| `context` | 終了時点のコンテキスト使用量 |
| `elapsed_ms` | 実行時間(ミリ秒) |
| `session_file` | 子セッションの保存先。全文は `pi --session <path>` で開けます |

- 再開した run の `usage` は、再開後に加算された分だけです
- run が失敗しても、兄弟の結果は失われません
- 未知の agent や解決できない `model` は、何も起動せずにエラーになります
- 呼び出し全体の制限時間は `spawn.json` で設定します(既定60分、`0` で無制限)。
  過ぎたら全子を中断し、各 run は `ERROR:` と理由(`timed out after 60m00s` など)になります
- 結果の見出し `[name] session_id=<id> entry_id=<id> (model)` と `output` はモデルにも渡ります。
  失敗した run は `ERROR: <error>` が渡ります
- `usage`・`context`・`elapsed_ms`・`session_file` はツール結果の `details` にだけ入り、モデルには渡りません

## 高度な使い方

### 呼び出しの制限時間を変える

`spawn_agents` の呼び出し全体には既定で60分の制限時間があります。過ぎると全子を中断し、各 run はエラーになります。

設定は `spawn.json` で行います。グローバル(`~/.pi/agent/spawn.json`、`PI_CODING_AGENT_DIR` で変更可)を先に読み、
プロジェクト(`<cwd>/.pi/spawn.json`)があれば上書きします(project trust が必要)。

```json
{ "timeoutMs": 3600000 }
```

| キー | 既定 | 意味 |
|---|---|---|
| `timeoutMs` | 3600000(60分) | 呼び出し全体の制限時間(ミリ秒)。`0` で無制限 |

- 値が不正なときは警告して既定値に戻します。警告は `/spawn status` にも出ます
- 現在の解決済みの値と設定ファイルの解決元は `/spawn status` で確認できます
- `timeoutMs: 0` は pi-spawn の呼び出し期限だけを無制限にします。
  モデルのストリーム停止(無応答)は引き続き Pi 本体の `httpIdleTimeoutMs`(既定300秒)とリトライが検出し、
  該当する run はエラーとして報告されます

### 親の会話文脈を引き継ぐ

子の定義に `inheritConversation: true` を書くと、親の会話をコピーした状態から子を始めます。
既定は false(空の文脈)です。

### セッションを再開する

`tasks[].resume_session_id` と `tasks[].resume_entry_id` に、以前の結果の `session_id` と `entry_id` をそのまま渡すと、
その子セッションを読み直し、指定した entry の履歴を文脈として `task` を実行します。

再開は指定した entry から新しい枝を作ります。指定した entry より後にある既存の枝は引き継ぎません。

```text
entry_id を指定
   ├─ 以前の枝: そのまま残る
   └─ resume 後: 新しい枝として追加
```

- 2つは必ずセットで指定します。片方だけではエラーになります
- `agent` / `model` / `cwd` は今回の指定が使われます
- セッションは起動時の `cwd` で探索するため、
  別の `cwd` で起動したセッションを再開するときは同じ `cwd` を渡します
- 親を `/tree` で戻した後に古い結果の組で再開しても、破棄した枝の続きは混ざりません
- 同じセッションを1回の呼び出しの複数タスクで再開することはできません(セッションへの同時書き込みになるため、事前エラーになります)
- 再開できるのは、`~/.pi/agent/spawn-sessions/` に保存され、
  指定した `resume_entry_id` が存在し、今回の `cwd` で探索できる子セッションだけです

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
| 親から実行中の子への指示 | 親のターンを中止する(Esc)。子も中断され、各 run はエラーとして報告される |
| 実行中の子の全文の確認 | `/spawn logs <target>` でライブ表示する(TUI のみ) |
| 完了した子のログの確認 | `session_file` を `pi --session <path>` に渡して開く |
| 並列での書き込み隔離 | 読み取り中心のタスクに限定する |
| 子の出力の自動検証 | 親がテストや差分確認を実行する |
| コスト上限の強制 | 上限はない。結果の `usage` とセッション統計で確認する |

## 開発者向け情報

この節は pi-spawn 自体を開発する人向けです。実行時依存(`dependencies`)はなく、依存は devDependency と、
Pi が供給する peer 依存(`@earendil-works/pi-tui`)だけです。
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
