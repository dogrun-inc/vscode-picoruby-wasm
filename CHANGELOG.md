# Changelog

All notable changes to the PicoRuby WASM extension are documented in this file.

## [Unreleased]

## [0.3.0] - 2026-10-XX

### Added

- Multi-file projects: `.rb` files next to the debug target HTML are collected into a virtual file system (VFS), and local `require` statements (`require 'lib/helper'`, `require './helper'`) are resolved from it
- Breakpoints in required `.rb` files and in every inline PicoRuby `<script>` block; stops are reported at the original file and line, so VS Code opens the correct file
- Step Into / Step Over (`F11` / `F10`) that stop on the next executable line, including lines in required files
- Debug Console evaluation of arbitrary expressions in the paused scope (via `mrb_debug_eval_in_binding`)
- `PicoRuby: Export Single HTML` command: bundles the HTML, collected `.rb` files, and the PicoRuby WASM runtime into one self-contained `dist/index.html`
- `PicoRuby: Export MRB HTML` command: same as above, but PicoRuby scripts are precompiled to MRB bytecode (`dist/index.mrb.html`)
- Multiple PicoRuby `<script>` tags per HTML file, including `<script type="text/ruby" src="...">` referencing a collected `.rb` file

### Changed

- Breakpoint injection moved from the extension to the WebView and is now source-map based: the require-expanded script keeps a line map back to each original file
- Breakpoint verification uses the same rules as the runtime instrumentation, so a breakpoint shown as verified always has a corresponding stop hook (continuation lines, closing keywords, comments, heredoc bodies, multi-line strings, `=begin` blocks, `require` lines and lines after `__END__` are reported as unverified)
- Inline HTML scripts on the same line as their tags (`<script type="text/ruby">puts 'hi'</script>`) are now supported

### Fixed

- `<script data-type="text/ruby">` is no longer treated as a PicoRuby script, and `data-src` no longer turns an inline script into an external one
- Lowercase heredoc identifiers (`<<~eof`) are recognized when deciding which lines can be instrumented
- `stepOut` is reported as unsupported instead of silently behaving like Step Into

### Known limitations

- Step Over behaves like Step Into (no call-depth tracking); Step Out is not supported because PicoRuby WASM exposes no step-out API
- Breakpoints added or removed after the debug session has started take effect on the next launch ([#19](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/19))
- Multi-line percent literals (`%w[...]`, `%q|...|`) and multi-line regexp literals are not tracked by the instrumentation and may cause a syntax error; keep them on one line or use heredocs ([#20](https://github.com/dogrun-inc/vscode-picoruby-wasm/issues/20))

## [0.2.0] - 2026-08-29

- Updated the bundled PicoRuby WASM runtime to v4.0.3
- Added PicoRuby WASM debugger support for PicoRuby code embedded in HTML
- Added WebView rendering for the active HTML debug target
- Added HTML line-number mapping for embedded PicoRuby breakpoints
- Added automatic `binding.irb` injection for executable breakpoint lines
- Added local stylesheet inlining for HTML debug targets
- Added validation and regression tests for HTML extraction, breakpoint handling, and stylesheet processing
- Updated the README and added a Japanese README

## [0.1.0] - 2026-07-02

- First public release
- Added PicoRuby syntax highlighting
- Added embedded PicoRuby highlighting for HTML injection contexts
- Added PicoRuby built-in completion (classes, methods, constants, module functions)
- Added snippet completion for `def` and `class`
- Added workspace commands to enable or disable `.rb` to `picoruby` association