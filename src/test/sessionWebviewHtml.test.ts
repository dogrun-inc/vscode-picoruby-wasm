import * as assert from 'assert';
import * as vscode from 'vscode';

import { picoRubyWasmWebviewTestHooks } from '../debug/session';

suite('session webview html', () => {
	test('createPicoRubyWasmWebviewHtmlWithExtensionUri emits nonce and runtime module script', () => {
		const extensionUri = vscode.Uri.parse('file:///extension-root');
		const expectedRuntimeScriptUri = vscode.Uri.joinPath(extensionUri, 'assets', 'webviewRuntime.js');
		const requestedScriptUris: string[] = [];

		const webview = {
			cspSource: 'https://test.webview.source',
			asWebviewUri(uri: vscode.Uri): vscode.Uri {
				requestedScriptUris.push(uri.toString());
				return vscode.Uri.parse(`https://test.webview.source${uri.path}`);
			}
		} as unknown as vscode.Webview;

		const html = picoRubyWasmWebviewTestHooks.createPicoRubyWasmWebviewHtmlWithExtensionUri(webview, extensionUri);

		assert.ok(
			requestedScriptUris.includes(expectedRuntimeScriptUri.toString()),
			'runtime script path must be resolved from extensionUri/assets/webviewRuntime.js'
		);

		const runtimeModuleScriptMatch = html.match(/<script\b[^>]*type="module"[^>]*src="https:\/\/test\.webview\.source\/extension-root\/assets\/webviewRuntime\.js"[^>]*><\/script>/);
		assert.ok(runtimeModuleScriptMatch, 'module script must load webviewRuntime.js');
		const nonceMatch = runtimeModuleScriptMatch?.[0].match(/\bnonce="([a-f0-9]{32})"/);
		assert.ok(nonceMatch, 'module script must include a nonce generated from random bytes');
		assert.ok(html.includes("script-src 'nonce-"), 'CSP must include nonce-based script-src');
		assert.ok(html.includes("'wasm-unsafe-eval'"), 'CSP must allow wasm-unsafe-eval');
		assert.ok(!html.includes("'unsafe-eval'"), 'CSP must not allow unsafe-eval');
	});
});
