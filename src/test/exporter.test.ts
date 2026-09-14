import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildPicoRubyMrbHtml, buildPicoRubySingleHtml } from '../exporter';

suite('single HTML exporter', () => {
	test('embeds collected VFS data and removes local init script reference', async () => {
		const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.resolve(__dirname, '..', '..');
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-export-'));
		const htmlPath = path.join(directory, 'index.html');

		try {
			writeFileSync(path.join(directory, 'sub.rb'), 'MESSAGE = "hello"\n');
			writeFileSync(
				htmlPath,
				[
					'<!DOCTYPE html>',
					'<html><body>',
					'<script type="text/ruby">require "sub"</script>',
					'<script src="init.iife.js"></script>',
					'</body></html>'
				].join('\n')
			);

			const html = await buildPicoRubySingleHtml({ extensionUri: vscode.Uri.file(repoRoot) } as vscode.ExtensionContext, htmlPath);

			assert.ok(html.includes('window.__PICORUBY_VFS__ = {"sub.rb":"MESSAGE = \\"hello\\"\\n"};'));
			assert.ok(html.includes('window.__PICORUBY_WASM_BASE64__ = '));
			assert.ok(html.includes('window.__PICORUBY_MODULE_SOURCE__ = '));
			assert.ok(html.includes('function expandVfsRequires'));
			assert.ok(html.includes('function resolveVfsScriptPath'));
			assert.ok(html.includes('instantiateWasm(imports, receiveInstance)'));
			assert.ok(!html.includes('src="init.iife.js"'));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('inlines safe local CSS with URL suffixes and treats leading slash as relative', async () => {
		const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.resolve(__dirname, '..', '..');
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-export-css-'));
		const htmlPath = path.join(directory, 'index.html');

		try {
			writeFileSync(path.join(directory, 'style.css'), 'body { color: red; }');
			writeFileSync(path.join(path.dirname(directory), 'outside.css'), 'body { color: blue; }');
			writeFileSync(
				htmlPath,
				[
					'<html><head>',
					'<link rel="stylesheet" href="/style.css?v=1#theme">',
					'<link rel="stylesheet" href="../outside.css">',
					'<link rel="stylesheet" href="missing.css">',
					'</head><body></body></html>'
				].join('\n')
			);

			const html = await buildPicoRubySingleHtml({ extensionUri: vscode.Uri.file(repoRoot) } as vscode.ExtensionContext, htmlPath);

			assert.ok(html.includes('body { color: red; }'));
			assert.ok(html.includes('href="../outside.css"'));
			assert.ok(html.includes('href="missing.css"'));
			assert.ok(!html.includes('body { color: blue; }'));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('builds MRB tasks for inline and VFS-backed Ruby script tags', async function () {
		this.timeout(10000);
		const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.resolve(__dirname, '..', '..');
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-export-mrb-'));
		const htmlPath = path.join(directory, 'index.html');

		try {
			writeFileSync(path.join(directory, 'main.rb'), 'puts "external"\n');
			writeFileSync(
				htmlPath,
				[
					'<html><body>',
					'<script type="text/ruby" src="main.rb"></script>',
					'<script type="text/ruby">puts "inline"</script>',
					'</body></html>'
				].join('\n')
			);

			const html = await buildPicoRubyMrbHtml({ extensionUri: vscode.Uri.file(repoRoot) } as vscode.ExtensionContext, htmlPath);

			assert.strictEqual((html.match(/type="application\/x-mrb"/g) ?? []).length, 2);
			assert.ok(html.includes('data-picoruby-mrb="R1JFTg'));
			assert.ok(!html.includes('src="main.rb"'));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});