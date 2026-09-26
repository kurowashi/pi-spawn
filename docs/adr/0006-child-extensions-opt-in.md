# 0006. 子の拡張ロードは agent 定義で opt-in にする

## 状態

採用

## 文脈

子セッションは `noExtensions: true` で作られていたため、設定済みの拡張(MCP adapter など)が
一切入らず、MCP ツールを持つ agent を定義しても子では使えなかった(比較表は [research.md](../research.md) を参照)。

一方で無条件に拡張を渡すのは危険である。

- `DefaultResourceLoader` は `noExtensions: false` のとき settings の `packages` を丸ごと読む。
  子は pi-spawn 自身もロードし、`spawn_agents` を取得する。ADR 0002 が副次的な安全境界と
  していた「委譲の深さが1に固定される」は成立しなくなる。
- 拡張のツールスキーマは子の全リクエストに乗る。MCP サーバーのスキーマは大きく、
  既定で子に配ると文脈予算(ADR 0002)の前提が崩れる。
- MCP adapter のようなセッションスコープの拡張は接続・認証・cleanup を持つ。子は
  これまで一度も破棄されておらず、`AgentSession.dispose()` は `session_shutdown` を
  発火しないため、ロードするだけでは資源が残る。

## 決定

1. agent 定義 frontmatter に `extensions: true` を追加する。既定は false(現在の挙動)。
   有効な agent の子セッションだけが、settings に構成された全 package をロードする。
2. 除外・allowlist は持たない。設定の外にある選択(どの package を子に渡すか)を新設せず、
   拡張側の設定(どの MCP サーバーを使うかなど)をそのまま尊重する。子が pi-spawn 自身も
   ロードして孫を spawn できる状態(多段委譲)を許し、さらに委譲するかは階層ごとの agent 定義の
   `extensions` で決まる。README / AGENTS.md の「子は spawn 系ツールを受け取らない(深さ1固定)」は
   **既定の子**についての記述に変える。
3. 子セッションの終了時に `session_shutdown` を明示的に発火してから `dispose()` する。
   SDK は dispose では拡張の cleanup を呼ばないため、これを怠ると MCP 接続などが残る。
4. チャネル生成中に失敗した場合も、それまでに作成した子セッションを破棄する。

## 結果

- MCP ツールを持つ子を定義できる。拡張分のスキーマは既定では子の文脈に乗らない(opt-in)。
- 通常終了では全拡張の cleanup が完了してから dispose される。生成途中の失敗でも、
  それまでに作成した子は同じ経路で破棄される。cleanup の失敗は allSettled で捨てる。
  run の結果は確定済みで報告先がなく、ここで投げても失う情報がないため。
- 多段委譲が可能になり、1呼び出し8件を前提にしていた fan-out の抑制は効かなくなる
  (ツリー全体の総数に上限は無い)。spawn 予算を持たない判断の根拠は既定の子にのみ適用される。
- 子のツール面は定義の `tools` との交差で絞れる。拡張が登録したツール名も `tools` に書ける。

## 再検討の条件

- 拡張ごとの allowlist や除外の需要(UI 依存の拡張が子で大量に警告を出すなど)が
  実運用で確認されたとき。
- 多段 fan-out が実運用で問題になったとき(深さ上限または spawn 予算の導入を検討する)。
