# PicoRuby WASM

PicoRuby development support for Visual Studio Code.

This extension currently focuses on:

- Syntax highlighting for PicoRuby
- Code completion for PicoRuby built-ins

> Debugger support is under active development and is not included in this release yet.

## Features

### Syntax Highlighting

- PicoRuby grammar support
- Embedded PicoRuby highlighting in HTML through an injection grammar

### Code Completion

- Built-in classes such as Array, Hash, String, GPIO, UART, and more
- Built-in methods such as puts, require, pin_mode, and digital_write
- Built-in constants such as TRUE, FALSE, and NIL
- Context-aware completion for `::` and `.` access patterns
- Snippet suggestions for `def` and `class`

## Not Yet Implemented

- Debugger integration
- Runtime execution features

If you are interested in debugger support, please watch this repository for updates.

- Repository: https://github.com/dogrun-inc/vscode-picoruby-wasm
- Issues: https://github.com/dogrun-inc/vscode-picoruby-wasm/issues

## Requirements

- Visual Studio Code 1.74.0 or later

## Installation

### From Marketplace

1. Open the Extensions view in VS Code
2. Search for "PicoRuby WASM"
3. Click Install

Direct link:

- https://marketplace.visualstudio.com/items?itemName=dogrun-inc.picoruby-wasm

### From VSIX

1. Download the `.vsix` package
2. In VS Code, run `Extensions: Install from VSIX...`
3. Select the downloaded file

## Usage

### File Association

This extension provides commands to associate `.rb` files with PicoRuby in your current workspace:

- Enable PicoRuby for this workspace (`.rb` -> `picoruby`)
- Disable PicoRuby for this workspace (remove the `.rb` mapping)

Open the Command Palette and run either command when needed.

### Completion

Start typing in a PicoRuby file and trigger completion with:

- Ctrl+Space on Windows or Linux
- Cmd+Space on macOS, depending on system settings

## Release Status

Current release: `v0.1.0` (initial release)

Please report issues and suggestions for:

- Bugs
- Missing built-ins
- Highlighting edge cases

## Known Limitations

- Completion is currently focused on built-in and core symbols
- Full language intelligence and debugger support are not yet available

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
