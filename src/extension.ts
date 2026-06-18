import * as vscode from 'vscode';
import { enablePicoRuby, disablePicoRuby } from './language/workspaceAssociation';

export function activate(context: vscode.ExtensionContext) {
	console.log('PicoRuby WASM extension is now active.');

	context.subscriptions.push(
		vscode.commands.registerCommand('picoruby.enable', () => enablePicoRuby()),
		vscode.commands.registerCommand('picoruby.disable', () => disablePicoRuby()),
	);
}

export function deactivate() {}
