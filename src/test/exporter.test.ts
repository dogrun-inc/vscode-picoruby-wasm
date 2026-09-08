import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { buildPicoRubySingleHtml } from '../exporter';

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
			assert.ok(!html.includes('src="init.iife.js"'));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});