![PicoRuby](https://avatars.githubusercontent.com/u/82246354?s=100&v=4)

![VSCode](https://img.shields.io/badge/VSCode->1.120-blue.svg?style=flat)
![PicoRuby](https://img.shields.io/badge/PicoRuby-4.0.5-red.svg?style=flat)

[English](README.md) | [日本語](README-ja.md)

# VSCode PicoRuby WASM

Visual Studio CodeでPicoRubyを開発・デバッグするための拡張機能です。内蔵PicoRuby WASMのバージョンは **v4.0.5** です。

本拡張機能では、PicoRubyコードの構文ハイライトや補完機能に加え、**VS Codeで現在開いているHTMLファイルをWebview上で動かしながら、埋め込まれたPicoRubyコードをインタラクティブにデバッグ実行**できます。複数の `.rb` ファイルに分割したプロジェクトにも対応しており、`require` はHTMLと同じディレクトリ配下のファイルから解決され、それらのファイル内でもブレークポイントとステップ実行が機能します。

> **Note**: v0.3.0 では、複数ファイル（`require`）のデバッグ、Step Into / Step Over、単一HTMLエクスポートが追加されました。不具合を見つけた際は GitHub Issue でお知らせください。

---

## 主な機能

### 1. 構文ハイライト
- **.rb ファイル**: PicoRuby用の文法定義ハイライト
- **HTML ファイル**: `<script type="text/ruby">` または `<script type="text/picoruby">` 内の組み込みRubyコードを自動ハイライト

### 2. コード補完
- **組み込みクラス**: `Array`, `Hash`, `String`, `GPIO`, `UART` など
- **組み込みメソッド**: `puts`, `require`, `pin_mode`, `digital_write` など
- **組み込み定数**: `TRUE`, `FALSE`, `NIL` など
- **コンテキスト補完**: `::` や `.` アクセス形式に対応
- **スニペット**: `def`, `class` などの基本構文入力補完

### 3. PicoRuby WASM デバッガー（PicoRuby v4.0.5 搭載）
VS Codeのエディターで現在開いているHTMLファイルをWebviewパネルに描画しながら、内部のPicoRubyコードを同期実行・デバッグします。

- **複数ファイル構成**: HTMLと同じディレクトリツリー内の `.rb` ファイルを仮想ファイルシステムに収集し、ローカルの `require` をそこから解決
- **どこにでもブレークポイント**: HTML内のインラインスクリプトにも、`require` される `.rb` ファイルにも設置可能。停止時はVS Codeが元のファイルの元の行を開きます
- **Step Into / Step Over**: 実行可能行を1行ずつ進み、`require` 先のファイル内の呼び出しにも追従
- **変数スコープの確認**: 一時停止中のローカル変数（`Locals`）およびグローバル変数（`Globals`）のリアルタイム参照
- **デバッグコンソールでの評価**: 停止中のスコープで任意のPicoRuby式を評価

### 4. 単一HTMLエクスポート
HTML・収集した全 `.rb` ファイル・PicoRuby WASMランタイムを1つのHTMLファイルにまとめ、本拡張機能なしでブラウザから実行できる形で出力します。

- **`PicoRuby: Export Single HTML`**: Rubyソースのまま同梱（`dist/index.html`）
- **`PicoRuby: Export MRB HTML`**: RubyスクリプトをMRBバイトコードに事前コンパイルして同梱（`dist/index.mrb.html`）

---

## 必要条件

- **Visual Studio Code**: 1.120.0 以降

---

## インストール方法

### Marketplace からインストール
1. VS Codeの拡張機能ビュー（`Ctrl+Shift+X` / `Cmd+Shift+X`）を開く
2. `PicoRuby WASM` を検索して **インストール** をクリック

- 直接リンク: [Visual Studio Marketplace - PicoRuby WASM](https://marketplace.visualstudio.com/items?itemName=dogrun-inc.picoruby-wasm)

### VSIX ファイルからインストール
1. リリース情報から `.vsix` パッケージをダウンロード
2. VS Codeの拡張機能ビューの右上 `...` メニューから `Install from VSIX...` を実行
3. ダウンロードしたファイルを選択

---

## 使い方

### 1. ワークスペースでPicoRubyを有効化
コマンドパレット（`Ctrl+Shift+P` / `Cmd+Shift+P`）から以下のコマンドを実行します。

- `PicoRuby: Enable`（`.rb` ファイルを PicoRuby として関連付け）
- `PicoRuby: Disable`（関連付けの解除）

### 2. HTML内にPicoRubyコードを記述
`text/ruby` または `text/picoruby` タグを使用してHTML内にスクリプトを記述します。

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>PicoRuby WASM Demo</h1>

  <script type="text/ruby">
    require 'js'

    document = JS.document
    puts "Hello from PicoRuby v#{PicoRuby::VERSION}!"
  </script>
</body>
</html>

```

### 3. デバッグ実行の開始

デバッガーは**現在エディターでアクティブ（開いている）状態のHTMLファイル**を実行対象とします。

1. デバッグ対象のHTMLファイルをVS Codeのエディターで開きます。
2. `.vscode/launch.json` を作成・設定します（下記参照）。
3. F5 キーを押してデバッグを開始します。

最小構成の `launch.json` の例:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch PicoRuby WASM",
      "type": "picoruby-wasm",
      "request": "launch",
      "program": "${file}",
      "cwd": "${workspaceFolder}"
    }
  ]
}

```

* `program` に `${file}` を指定することで、現在アクティブなHTMLファイルを対象として実行できます。

### 4. コードを複数ファイルに分割する

デバッグ開始時に、HTMLファイルがあるディレクトリ（およびそのサブディレクトリ）内のすべての `.rb` ファイルが収集され、`require` はその集合に対して解決されます。

| 記述 | 解決先 |
|---|---|
| `require 'lib/helper'` | HTMLのディレクトリを基準に `lib/helper.rb` または `lib/helper/index.rb` |
| `require './helper'` / `require '../shared'` | `require` を書いたファイルからの相対パス |
| `require 'js'` | そのまま（組み込みライブラリ） |

典型的な構成（[sample/vfs-require](sample/vfs-require) 参照）:

```
project/
├── index.html        <script type="text/ruby">require 'main'</script>
├── main.rb           require './lib/message'
│                     require 'ui/status_view'
├── lib/
│   └── message.rb
└── ui/
    └── status_view.rb
```

`<script type="text/ruby" src="main.rb"></script>` のようにHTMLから直接ファイルを参照することもできます。PicoRuby用の `<script>` タグが複数ある場合は文書順に実行されます。

### 5. 単一HTMLとしてエクスポートする

対象のHTMLをアクティブにした状態でコマンドパレットから `PicoRuby: Export Single HTML` または `PicoRuby: Export MRB HTML` を実行します。結果は元のHTMLと同じ場所の `dist/` フォルダに出力されます。

---

## デバッガーの操作方法

VS Code標準のデバッグインターフェースがそのまま利用できます。

* **ブレークポイントの設定**: エディター左端（ガター）をクリックして赤丸を設置（HTMLファイルでも、HTMLのディレクトリ配下の `.rb` ファイルでも可）
* **続行 (Continue)**: `F5`
* **ステップ実行 (Step Over / Into)**: `F10` / `F11`（どちらも次の実行可能行で停止します。制限事項を参照）
* **変数確認**: デバッグサイドバーの `Variables` ビュー（`Locals` / `Globals`）を展開
* **式の評価**: 停止中に `Debug Console` でPicoRubyの変数や式を入力して試行
* **停止 (Stop)**: `Shift + F5`

---

## デバッガーの仕様と制限事項

* **動作の仕組み**: 実行前にローカルの `require` を1つのスクリプトに展開し、各実行可能行の先頭に元のファイル・行番号を記録する軽量なトレースフックを付加します。ブレークポイントとステップ実行はこのフックから `binding.irb` で一時停止するため、ユーザーコード自身のスコープで停止し、ローカル変数をそのまま参照できます。
* **ブレークポイント設置不可の行**: フックを安全に付加できない行は未検証（白抜きの丸）として表示され、停止しません。対象: コメント行、空行、閉じキーワード（`else`, `elsif`, `when`, `rescue`, `ensure`, `end`）、継続行（`foo(a,` / `b)` の2行目など）、ヒアドキュメント本体、複数行文字列の本体、`=begin` ブロック、`require` 行、`__END__` 以降。
* **セッション中のブレークポイント変更**: ブレークポイントはセッション開始時に確定します。デバッグ中に追加・削除した内容は次回起動時に反映されます（[#19](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/19)）。
* **Step Over / Step Out**: PicoRuby WASM には呼び出し深度を考慮したステップAPIがないため、現在 Step Over は Step Into と同じ動作になり、Step Out は未対応です。
* **複数行のパーセントリテラル・正規表現**: 複数行にまたがる `%w[...]`、`%q|...|`、`/.../` は追跡されず、構文エラーになる場合があります。1行に収めるか、ヒアドキュメントを使用してください（[#20](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/20)）。
* **収集範囲**: 収集されるのはHTMLのディレクトリ配下の `.rb` ファイルのみです。それより外側のファイルは `require` もデバッグもできません。
* **CSSの読み込み制限**: 外部URL（`https://` や `http://` など）を指定したCSSは、セキュリティ上の制限（CSP）により読み込まれません。
* **セキュリティ保護**: 安全のため、`href="javascript:..."` 属性を持つHTMLリンクは表示前に除去されます。

---

## リリース状況

* **現在のバージョン**: `v0.3.0`（PicoRuby v4.0.5 搭載・複数ファイル `require` デバッグ、ステップ実行、HTMLエクスポートを追加）

不具合や機能要望がございましたら、GitHub Issueにてお知らせください。（日本語でOKです）

* バグ報告
* 未対応の組み込みクラス・メソッドの要望
* ブレークポイントや行番号のズレ
* Webviewでの描画に関する問題

---

## リンク

* **リポジトリ**: [GitHub - dogrun-inc/vscode-picoruby-wasm](https://github.com/dogrun-inc/vscode-picoruby-wasm)
* **Issue トラッカー**: [GitHub Issues](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues)
* **変更履歴**: [CHANGELOG.md](CHANGELOG.md)

## ライセンス

[MIT License](https://www.google.com/search?q=LICENSE)
