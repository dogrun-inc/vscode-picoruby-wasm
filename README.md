![PicoRuby](https://avatars.githubusercontent.com/u/82246354?s=100&v=4)

![VSCode](https://img.shields.io/badge/VSCode->1.120-blue.svg?style=flat)
![PicoRuby](https://img.shields.io/badge/PicoRuby-4.0.3-red.svg?style=flat)

# VSCode PicoRuby WASM

A Visual Studio Code extension for developing and debugging PicoRuby. Bundles PicoRuby WASM **v4.0.3**.

This extension provides syntax highlighting and code completion for PicoRuby, as well as **interactive debugging for embedded PicoRuby code in HTML files running inside VS Code's Webview**.

> **Note**: Debugger support is a new feature introduced in v0.2.0. Currently, testing has been focused primarily on PicoRuby code embedded in HTML (Webview) files.

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

### 3. PicoRuby WASM Debugger (Powered by PicoRuby v4.0.3)
Renders the currently open HTML file in VS Code's Webview panel while executing and debugging the embedded PicoRuby code in real time.

- **Automatic Breakpoint Injection**: Automatically injects `binding.irb` into target lines to pause execution.
- **Variable Inspection**: Real-time scope inspection for local variables (`Locals`) and global variables (`Globals`).
- **Debug Console Evaluation**: Dynamic expression evaluation in the Debug Console while paused.

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

---

## Debugger Controls

VS Code's standard debug interface works seamlessly:

* **Set Breakpoint**: Click the left gutter next to a line number to set a breakpoint.
* **Continue**: `F5`
* **Step Over / Step Into**: `F10` / `F11`
* **Inspect Variables**: Expand the `Locals` or `Globals` sections in the Debug sidebar's `Variables` view.
* **Evaluate Expressions**: Type PicoRuby variables or expressions in the `Debug Console` while paused.
* **Stop**: `Shift + F5`

---

## Debugger Specifications & Limitations

* **Execution Target**: Only the first PicoRuby `<script>` tag found in the open HTML file will be executed (combining multiple script tags into a single program is not supported).
* **Single-Line Scripts**: Inline scripts placed on the same line as the opening/closing tag (e.g., `<script type="text/ruby">puts 'hi'</script>`) are not supported. Write code on new lines.
* **Unsupported Breakpoint Lines**: To prevent syntax errors, `binding.irb` cannot be injected into comment lines, empty lines, or control keywords (`else`, `elsif`, `when`, `rescue`, `ensure`, `end`, etc.). Breakpoints set on these lines will be ignored.
* **CSS Loading Restrictions**: CSS files from external URLs (e.g., `https://` or `http://`) are blocked due to Content Security Policy (CSP) restrictions in Webview.
* **Security Protection**: HTML links with `href="javascript:..."` attributes are stripped out before rendering in Webview.

---

## Release Status

* **Current Version**: `v0.2.0` (Includes PicoRuby v4.0.3, adds Webview debugger support)

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
