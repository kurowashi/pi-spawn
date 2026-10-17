# AGENTS.md — pi-spawn

読者: pi-spawn を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

- 登録するツールは `spawn_agents`（親）と `message_agent`（子）の2つだけ。コマンドは `spawn` だけ（`test/contract/tool-surface.test.ts`）。
- ツール定義（説明 + スキーマ）の合計は 400 トークン以内。説明は 160 文字以内。トップレベル引数は3個以内。スキーマは `additionalProperties: false`。子ツールの引数は `target_session_id` と `text` だけ（`test/contract/tool-surface.test.ts`）。
- 子のセッションは `session_start` を発火する。SDK は `bindExtensions` を呼ばないと発火しない。`extensions: true` の子は CLI と同じ内蔵拡張を使う（`test/integration/spawn-agents.test.ts`）。
- 宛先は session id の完全一致だけ。解決エラーは live の session id だけを並べる。受信メッセージは `from_session_id` / `name` のヘッダーを持つ（`test/integration/spawn-agents.test.ts`）。
- 親の履歴を継承するのは、定義の `inheritConversation: true` のときだけ。継承した会話は親の現在の枝で終わり、破棄した枝を含まない（`test/integration/spawn-agents.test.ts`）。
- `spawn.json` の解決順はグローバル → trust 済み project。`0` は無制限。制限時間の既定は 3600000ms。制限時間に達した run は中断し、`timed out after ...` を返す。兄弟の timeout は、自分の prompt が settle 済みの run の結果を書き換えない（`test/integration/spawn-agents.test.ts`）。
- 失敗した run は成功にせず、`aborted` や provider の `errorMessage` をエラーとして報告する（`test/integration/spawn-agents.test.ts`）。
- カタログは同名 agent を1件だけ表示する（ファイル名の昇順で最初の定義）。`spawn_catalog` セクションとして注入し、プロンプトを固定しない。定義の解決順は project → user で、project 定義は trust 済みのときだけ読む（`test/unit/catalog.test.ts`）。
- resume は `resume_session_id` と `resume_entry_id` の2フィールドを両方必須で指定する。resume の探索は `cwd` 一致で行う。再開した run は保存済みの session id を保ち、再開後の usage は差分だけを数える（`test/integration/spawn-agents.test.ts`）。
- 同じセッションを1呼び出しの複数タスクに指定しない（`test/integration/spawn-agents.test.ts`）。
- 実行時依存を持たない。配布は `src/`、`package.json`、`README.md` だけ（`test/contract/dependencies.test.ts`、`test/ci/package-contents.test.ts`）。
- 定義本文の `@path` は子の起動時に展開する。規則は pi-import と同じで、テストで固定する。展開は `src/memory-import.ts`、スキャナは `src/import-scan.ts`（`test/unit/memory-import.test.ts`、`test/unit/import-scan.test.ts`）。本文直下は子の `cwd` 基準、`user` / `project` は定義の場所で決まる（ADR 0013）。

## 変更手順

- ツールを増やす・引数を増やす場合は、`test/contract/tool-surface.test.ts` を先に更新する。`test/contract/budget.test.ts` で 400 トークンの予算を超えないことを確認する。
- 子の起動・継承・resume の意味を変えるときは、`test/integration/spawn-agents.test.ts` を先に更新する。関係する ADR を読む（継承は 0007、子の拡張は 0011、resume は 0001・0009、カタログは 0010、定義本文の `@path` は 0013）。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
