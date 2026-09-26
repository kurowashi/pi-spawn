# 0003. ビルド工程を持たず、TypeScript を直接配布する

## 状態

採用(Step 1)

## 文脈

Pi は jiti を用いて拡張の `.ts` を直接ロードするため、配布に中間生成物を必要としない。
一方で Node も `.ts` をネイティブに type stripping できる(Node 22.18+ / 23.6+ で既定有効)。
両者は別のローダーであり、片方だけが解釈できる構文を書くと「テストは通るが Pi で動かない」
あるいはその逆が起こりうる。

## 決定

- ビルド工程を持たない。`package.json` の `pi.extensions` は `./src/index.ts` を指す。
- 実行時コードは Node のネイティブ type stripping で解釈可能な構文に限定する。
  これを `tsconfig` の `erasableSyntaxOnly` で強制する(`enum` / `namespace` /
  parameter properties を型エラーにする)。
- 検証は `node --test`(Node ローダー)と、テスト内での `discoverAndLoadExtensions`
  (jiti ローダー)の両方を通す。
- 型検査は `tsc --noEmit` のみ。TypeScript 7 のネイティブコンパイラを使い、
  pre-commit で毎回実行できる速度を確保する。

## 結果

- 生成物・ソースマップ・ビルド設定が存在しない。読む人が見るファイルは実行されるファイルそのもの。
- `enum` などの便利構文は使えないが、代替は素直な union 型であり、失う表現力は小さい。
- ローダー差のリスクは契約テストと `erasableSyntaxOnly` で二重に塞ぐ。
