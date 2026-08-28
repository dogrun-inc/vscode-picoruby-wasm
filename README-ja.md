![PicoRuby](https://avatars.githubusercontent.com/u/82246354?s=100&v=4)

![VSCode](https://img.shields.io/badge/VSCode->1.120-blue.svg?style=flat)
![PicoRuby](https://img.shields.io/badge/PicoRuby-4.0.3-red.svg?style=flat)

# VSCode PicoRuby WASM

Visual Studio CodeでPicoRubyを開発・デバッグするための拡張機能です。内蔵PicoRuby WASMのバージョンは **v4.0.3** です。

本拡張機能では、PicoRubyコードの構文ハイライトや補完機能に加え、**VS Codeで現在開いているHTMLファイルをWebview上で動かしながら、埋め込まれたPicoRubyコードをインタラクティブにデバッグ実行**できます。

> **Note**: デバッガー機能は v0.2.0 より追加された機能です。現在はHTML（Webview）に埋め込まれたPicoRubyコードを中心に動作確認を行っています。

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

### 3. PicoRuby WASM デバッガー（PicoRuby v4.0.3 搭載）
VS Codeのエディターで現在開いているHTMLファイルをWebviewパネルに描画しながら、内部のPicoRubyコードを同期実行・デバッグします。

- **自動ブレークポイント注入**: 設定した行へ `binding.irb` を自動注入して実行を一時停止
- **変数スコープの確認**: 一時停止中のローカル変数（`Locals`）およびグローバル変数（`Globals`）のリアルタイム参照
- **デバッグコンソールでの評価**: 停止中の変数を参照した式の動的評価

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

---

## デバッガーの操作方法

VS Code標準のデバッグインターフェースがそのまま利用できます。

* **ブレークポイントの設定**: エディター左端（ガター）をクリックして赤丸を設置
* **続行 (Continue)**: `F5`
* **ステップ実行 (Step Over / Into)**: `F10` / `F11`
* **変数確認**: デバッグサイドバーの `Variables` ビュー（`Locals` / `Globals`）を展開
* **式の評価**: 停止中に `Debug Console` でPicoRubyの変数や式を入力して試行
* **停止 (Stop)**: `Shift + F5`

---

## デバッガーの仕様と制限事項

* **実行対象**: エディターで開いているHTMLファイル内で、最初に見つかったPicoRuby用 `<script>` タグのコードが実行されます（複数の script タグの結合実行には未対応）。
* **1行スクリプト**: `<script type="text/ruby">puts 'hi'</script>` のように開始・終了タグと同じ行に記述されたコードはサポート外です。コードは改行して記述してください。
* **ブレークポイント設置不可の行**: 構文エラーを防ぐため、コメント行、空行、および特定の制御構文行（`else`, `elsif`, `when`, `rescue`, `ensure`, `end` など）には `binding.irb` が注入されず、停止対象外となります。
* **CSSの読み込み制限**: 外部URL（`https://` や `http://` など）を指定したCSSは、セキュリティ上の制限（CSP）により読み込まれません。
* **セキュリティ保護**: 安全のため、`href="javascript:..."` 属性を持つHTMLリンクは表示前に除去されます。

---

## リリース状況

* **現在のバージョン**: `v0.2.0`（PicoRuby v4.0.3 搭載・デバッガー機能追加）

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
