import * as vscode from 'vscode';
import {
	PICORUBY_BUILTIN_CLASSES,
	PICORUBY_BUILTIN_CONSTANTS,
	PICORUBY_BUILTIN_METHODS
} from './builtins';

function classItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_CLASSES.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
		item.detail = 'PicoRuby built-in class';
		item.insertText = name;
		return item;
	});
}

function methodItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_METHODS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
		item.detail = 'PicoRuby built-in method';
		item.insertText = name;
		return item;
	});
}

function constantItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_CONSTANTS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
		item.detail = 'PicoRuby built-in constant';
		item.insertText = name;
		return item;
	});
}

export function registerPicoRubyCompletionProvider(): vscode.Disposable {
	const provider: vscode.CompletionItemProvider = {
		provideCompletionItems() {
			return [...classItems(), ...methodItems(), ...constantItems()];
		}
	};

	return vscode.languages.registerCompletionItemProvider(
		{ language: 'picoruby' },
		provider,
		'.',
		':'
	);
}
