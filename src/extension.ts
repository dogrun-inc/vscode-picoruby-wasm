import * as vscode from 'vscode';
import { enablePicoRuby, disablePicoRuby } from './language/workspaceAssociation';
import { registerPicoRubyCompletionProvider } from './completion/provider';

export function activate(context: vscode.ExtensionContext) {
	console.log('PicoRuby WASM extension is now active.');

	context.subscriptions.push(
		vscode.commands.registerCommand('picoruby.enable', () => enablePicoRuby()),
		vscode.commands.registerCommand('picoruby.disable', () => disablePicoRuby()),
		registerPicoRubyCompletionProvider()
	);
}

export function deactivate() {}
