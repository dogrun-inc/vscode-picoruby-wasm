import * as assert from 'assert';
import * as vscode from 'vscode';

import { picoRubyWasmWebviewTestHooks } from '../debug/session';

suite('session webview html', () => {
	test('createPicoRubyWasmWebviewHtmlWithExtensionUri emits nonce and module import', () => {
		const extensionUri = vscode.Uri.parse('file:///extension-root');
		const expectedScriptUri = vscode.Uri.joinPath(extensionUri, 'assets', 'picoruby.js');
		let requestedScriptUri: vscode.Uri | undefined;

		const webview = {
			cspSource: 'https://test.webview.source',
			asWebviewUri(uri: vscode.Uri): vscode.Uri {
				requestedScriptUri = uri;
				return vscode.Uri.parse(`https://test.webview.source${uri.path}`);
			}
		} as unknown as vscode.Webview;

		const html = picoRubyWasmWebviewTestHooks.createPicoRubyWasmWebviewHtmlWithExtensionUri(webview, extensionUri);

		assert.strictEqual(
			requestedScriptUri?.toString(),
			expectedScriptUri.toString(),
			'script path must be resolved from extensionUri/assets/picoruby.js'
		);

		const nonceMatch = html.match(/<script type="module" nonce="([a-f0-9]{32})">/);
		assert.ok(nonceMatch, 'module script must include a nonce generated from random bytes');
		assert.ok(html.includes("script-src 'nonce-"), 'CSP must include nonce-based script-src');
		assert.ok(html.includes("'wasm-unsafe-eval'"), 'CSP must allow wasm-unsafe-eval');
		assert.ok(!html.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval');
		assert.ok(
			html.includes("import('https://test.webview.source/extension-root/assets/picoruby.js')"),
			'generated HTML must import the asWebviewUri-converted script URI'
		);
		assert.ok(html.includes('const vscode = acquireVsCodeApi();'), 'webview must initialize VS Code API bridge');
		assert.ok(
			html.includes("window.addEventListener('message', async (event) => {"),
			'webview must listen for VS Code messages'
		);
		assert.ok(
			html.includes("vscode.postMessage({ type: 'log', text });"),
			'webview must post log messages to extension host'
		);
		assert.ok(
			html.includes("vscode.postMessage({ type: 'ready' });"),
			'webview must notify the extension host when WASM initialization completes'
		);
		assert.ok(
			html.includes("if (data?.type !== 'start') {"),
			'webview must handle start commands sent from VS Code'
		);
	});
});
