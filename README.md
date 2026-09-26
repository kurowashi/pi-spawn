# pi-spawn

Pi の子エージェントを spawn し、親・子・兄弟が同一プロセス内で直接メッセージをやり取りする拡張。
`pi-subagents` の代替として、**必要なものだけ**を実装する。

- モデルに見せるツール面は **267 トークン**(参考: `pi-subagents` は約 5,000 トークン)
- 子セッションは同一プロセス内(in-process)。非同期実行・別プロセス runner を持たない
- 兄弟エージェント同士が直接会話できる(親を中継しない)

## インストール

`~/.pi/agent/settings.json` の `packages` にローカルパスを追加する:

```json
{
	"packages": ["../../pi-plugins/pi-spawn"]
}
```

## ツール

| ツール | 提供先 | 用途 |
|---|---|---|
| `spawn_agent` | 親のみ | 子エージェントを1つ起動し、結果を待つ |
| `message_agent` | 親と子 | `parent` / run id / agent 名 宛にメッセージを送る |

子には `spawn_agent` を渡さないため、委譲の深さは常に 1 に固定される。

## 開発

```bash
npm install
npm run verify     # biome + tsc + カバレッジ付きテスト
npm test           # テストのみ
npm run fix        # 自動修正
```

コミット前に lefthook が format/lint/型検査を実行する。CI は同じ検査を独立に実行する
(フックは利便性のためのもので、ゲートの権威ではない)。

## 設計

- [`docs/foundation.md`](docs/foundation.md) — 土台(ツール選定・構成・制約・CI)
- [`docs/design.md`](docs/design.md) — 作るもの/作らないもの、実装方針
- [`docs/adr/`](docs/adr) — 決定の記録
- [`AGENTS.md`](AGENTS.md) — 機械的に検証できる制約のみ
