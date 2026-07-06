import * as vscode from 'vscode';
import { enablePicoRuby, disablePicoRuby } from './language/workspaceAssociation';
import { registerPicoRubyCompletionProvider } from './completion/provider';
import { registerPicoRubyWasmDebugging } from './debug/adapterFactory';

export function activate(context: vscode.ExtensionContext) {
	console.log('PicoRuby WASM extension is now active.');

	context.subscriptions.push(
		vscode.commands.registerCommand('picoruby.enable', () => enablePicoRuby()),
		vscode.commands.registerCommand('picoruby.disable', () => disablePicoRuby()),
		registerPicoRubyCompletionProvider(),
		registerPicoRubyWasmDebugging(context)
	);
}

export function deactivate() {}
