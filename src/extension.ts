import * as vscode from 'vscode';
import { enablePicoRuby, disablePicoRuby } from './language/workspaceAssociation';
import { registerPicoRubyCompletionProvider } from './completion/provider';
import { registerPicoRubyWasmDebugging } from './debug/adapterFactory';
import { setPicoRubyWasmExtensionContext } from './debug/session';
import { exportPicoRubyMrbHtml, exportPicoRubySingleHtml } from './exporter';
import { PicoRubyHoverProvider } from './hoverProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('PicoRuby WASM extension is now active.');
	setPicoRubyWasmExtensionContext(context);
	const hoverProvider = new PicoRubyHoverProvider();

	context.subscriptions.push(
		vscode.languages.registerHoverProvider({ language: 'ruby' }, hoverProvider),
		vscode.languages.registerHoverProvider({ language: 'html' }, hoverProvider),
		vscode.languages.registerHoverProvider({ language: 'picoruby' }, hoverProvider),
		vscode.commands.registerCommand('picoruby.enable', () => enablePicoRuby()),
		vscode.commands.registerCommand('picoruby.disable', () => disablePicoRuby()),
		vscode.commands.registerCommand('picoruby.exportSingleHtml', (uri?: vscode.Uri) => exportPicoRubySingleHtml(context, uri)),
		vscode.commands.registerCommand('picoruby.exportMrbHtml', (uri?: vscode.Uri) => exportPicoRubyMrbHtml(context, uri)),
		registerPicoRubyCompletionProvider(),
		registerPicoRubyWasmDebugging(context)
	);
}

export function deactivate() {}
