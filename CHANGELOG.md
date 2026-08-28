# Changelog

All notable changes to the PicoRuby WASM extension are documented in this file.

## [Unreleased]

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