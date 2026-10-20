![PicoRuby](https://avatars.githubusercontent.com/u/82246354?s=100&v=4)

![VSCode](https://img.shields.io/badge/VSCode->1.120-blue.svg?style=flat)
![PicoRuby](https://img.shields.io/badge/PicoRuby-4.0.5-red.svg?style=flat)

[English](README.md) | [日本語](README-ja.md)

# VSCode PicoRuby WASM

A Visual Studio Code extension for developing and debugging PicoRuby. Bundles PicoRuby WASM **v4.0.5**.

This extension provides syntax highlighting and code completion for PicoRuby, as well as **interactive debugging of PicoRuby code embedded in HTML files, running inside VS Code's Webview**. Projects split across multiple `.rb` files are supported: `require` statements are resolved from the files next to your HTML, and breakpoints and stepping work inside those files.

> **Note**: v0.3.0 adds multi-file (`require`) debugging, Step Into / Step Over, and single-file HTML export. Please report issues you encounter on GitHub.

---

## Features

### 1. Syntax Highlighting
- **.rb Files**: Grammar highlighting for PicoRuby files.
- **HTML Files**: Automatic highlighting for embedded Ruby code within `<script type="text/ruby">` or `<script type="text/picoruby">` tags.

### 2. Code Completion
- **Built-in Classes**: `Array`, `Hash`, `String`, `GPIO`, `UART`, and more.
- **Built-in Methods**: `puts`, `require`, `pin_mode`, `digital_write`, and more.
- **Built-in Constants**: `TRUE`, `FALSE`, `NIL`, etc.
- **Context-Aware Completion**: Supports `::` and `.` access patterns.
- **Snippets**: Completion templates for common structures like `def` and `class`.

### 3. PicoRuby WASM Debugger (Powered by PicoRuby v4.0.5)
Renders the currently open HTML file in VS Code's Webview panel while executing and debugging the embedded PicoRuby code in real time.

- **Multi-file projects**: `.rb` files in the same directory tree as the HTML are collected into a virtual file system, and local `require` statements are resolved from it.
- **Breakpoints anywhere**: Set breakpoints in the HTML's inline scripts or in any required `.rb` file. When execution stops, VS Code opens the original file at the original line.
- **Step Into / Step Over**: Advance one executable line at a time, following calls into required files.
- **Variable Inspection**: Real-time scope inspection for local variables (`Locals`) and global variables (`Globals`).
- **Debug Console Evaluation**: Evaluate arbitrary PicoRuby expressions in the paused scope.

### 4. Single-File HTML Export
Bundle your HTML, all collected `.rb` files, and the PicoRuby WASM runtime into one self-contained HTML file that runs in any browser without this extension.

- **`PicoRuby: Export Single HTML`**: Ships Ruby source (`dist/index.html`).
- **`PicoRuby: Export MRB HTML`**: Precompiles the Ruby scripts to MRB bytecode (`dist/index.mrb.html`).

---

## Requirements

- **Visual Studio Code**: 1.120.0 or later

---

## Installation

### From Marketplace
1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for `PicoRuby WASM`.
3. Click **Install**.

- Direct Link: [Visual Studio Marketplace - PicoRuby WASM](https://marketplace.visualstudio.com/items?itemName=dogrun-inc.picoruby-wasm)

### From VSIX
1. Download the `.vsix` package from the releases page.
2. In VS Code, open the Extensions view and click the `...` menu in the top right.
3. Select `Install from VSIX...` and choose the downloaded file.

---

## Usage

### 1. Enable PicoRuby in Workspace
Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run one of the following commands:

- `PicoRuby: Enable` (Maps `.rb` files to PicoRuby in the workspace)
- `PicoRuby: Disable` (Removes the `.rb` mapping)

### 2. Write PicoRuby in HTML
Use `text/ruby` or `text/picoruby` script tags to write PicoRuby code inside HTML files.

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

### 3. Start Debugging

The debugger targets the **HTML file currently open and active in the editor**.

1. Open the target HTML file in the editor.
2. Create or configure `.vscode/launch.json` (see minimal setup below).
3. Press `F5` to start debugging.

Minimal `launch.json` configuration:

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

* Setting `"program": "${file}"` allows the debugger to run whichever HTML file is currently active in the active editor tab.

### 4. Split Your Code Across Files

Every `.rb` file in the directory containing the HTML file (and its subdirectories) is collected when debugging starts, and `require` resolves against that set:

| Statement | Resolves to |
|---|---|
| `require 'lib/helper'` | `lib/helper.rb` or `lib/helper/index.rb`, relative to the HTML's directory |
| `require './helper'` / `require '../shared'` | Relative to the file containing the `require` |
| `require 'js'` | Left untouched (built-in library) |

A typical layout (see [sample/vfs-require](sample/vfs-require)):

```
project/
├── index.html        <script type="text/ruby">require 'main'</script>
├── main.rb           require './lib/message'; require 'ui/status_view'
├── lib/
│   └── message.rb
└── ui/
    └── status_view.rb
```

You can also reference a file directly from the HTML: `<script type="text/ruby" src="main.rb"></script>`. Multiple PicoRuby `<script>` tags are executed in document order.

### 5. Export a Self-Contained HTML

Open the Command Palette with the target HTML active (or right-click it in the Explorer) and run `PicoRuby: Export Single HTML` or `PicoRuby: Export MRB HTML`. The result is written to a `dist/` folder next to the source HTML.

---

## Debugger Controls

VS Code's standard debug interface works seamlessly:

* **Set Breakpoint**: Click the left gutter next to a line number, in the HTML file or in any `.rb` file under the HTML's directory.
* **Continue**: `F5`
* **Step Over / Step Into**: `F10` / `F11` (both stop on the next executable line; see limitations)
* **Inspect Variables**: Expand the `Locals` or `Globals` sections in the Debug sidebar's `Variables` view.
* **Evaluate Expressions**: Type PicoRuby variables or expressions in the `Debug Console` while paused.
* **Stop**: `Shift + F5`

---

## Debugger Specifications & Limitations

* **How it works**: Before execution, the debugger expands local `require` statements into a single script and prefixes each executable line with a lightweight trace hook that records the original file and line. Breakpoints and stepping pause via `binding.irb` from that hook, so execution stops in your own scope with locals intact.
* **Unsupported Breakpoint Lines**: Lines that cannot safely receive the hook are shown as unverified (hollow circle) and will not stop: comments, blank lines, closing keywords (`else`, `elsif`, `when`, `rescue`, `ensure`, `end`), continuation lines (the second line of `foo(a,` / `b)`), heredoc bodies, multi-line string bodies, `=begin` blocks, `require` lines, and anything after `__END__`.
* **Breakpoint changes during a session**: Breakpoints are fixed when the session starts. Adding or removing them while debugging takes effect on the next launch ([#19](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/19)).
* **Step Over / Step Out**: PicoRuby WASM has no call-depth-aware stepping API, so Step Over currently behaves like Step Into, and Step Out is not supported.
* **Multi-line percent and regexp literals**: `%w[...]`, `%q|...|` and `/.../` spanning several lines are not tracked and may cause a syntax error. Keep them on one line or use a heredoc ([#20](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/20)).
* **VFS scope**: Only `.rb` files under the HTML's directory are collected. Files outside it cannot be required or debugged.
* **CSS Loading Restrictions**: CSS files from external URLs (e.g., `https://` or `http://`) are blocked due to Content Security Policy (CSP) restrictions in Webview.
* **Security Protection**: HTML links with `href="javascript:..."` attributes are stripped out before rendering in Webview.

---

## Release Status

* **Current Version**: `v0.3.0` (Includes PicoRuby v4.0.5; adds multi-file `require` debugging, stepping, and HTML export)

Please report bugs or feature requests on GitHub Issues:

* Bug reports
* Requests for unsupported built-in classes or methods
* Line number / breakpoint offset issues
* Webview rendering issues

---

## Links

* **Repository**: [GitHub - dogrun-inc/vscode-picoruby-wasm](https://github.com/dogrun-inc/vscode-picoruby-wasm)
* **Issue Tracker**: [GitHub Issues](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues)
* **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## License

[MIT License](https://www.google.com/search?q=LICENSE)
