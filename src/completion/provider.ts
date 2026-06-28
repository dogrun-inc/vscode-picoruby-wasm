import * as vscode from 'vscode';
import {
	PICORUBY_BUILTIN_CLASSES,
	PICORUBY_BUILTIN_CONSTANTS,
	PICORUBY_BUILTIN_METHODS,
	PICORUBY_MODULE_FUNCTIONS
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

function moduleFunctionItems(): vscode.CompletionItem[] {
	return PICORUBY_MODULE_FUNCTIONS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
		item.detail = 'PicoRuby module function';
		item.insertText = name;
		return item;
	});
}

function lineHeadSnippetItems(linePrefix: string): vscode.CompletionItem[] {
	if (!/^\s*[A-Za-z_]*$/.test(linePrefix)) {
		return [];
	}

	const items: vscode.CompletionItem[] = [];
	const typedWord = linePrefix.trim();

	if (typedWord.length === 0 || 'def'.startsWith(typedWord)) {
		const defSnippet = new vscode.CompletionItem('def', vscode.CompletionItemKind.Snippet);
		defSnippet.detail = 'PicoRuby snippet';
		defSnippet.insertText = new vscode.SnippetString(
			'def ${1:method_name}${2:(args)}\n\t${0}\nend'
		);
		items.push(defSnippet);
	}

	if (typedWord.length === 0 || 'class'.startsWith(typedWord)) {
		const classSnippet = new vscode.CompletionItem('class', vscode.CompletionItemKind.Snippet);
		classSnippet.detail = 'PicoRuby snippet';
		classSnippet.insertText = new vscode.SnippetString(
			'class ${1:ClassName}\n\t${0}\nend'
		);
		items.push(classSnippet);
	}

	return items;
}

function contextItems(linePrefix: string): vscode.CompletionItem[] {
	if (/::\w*$/.test(linePrefix)) {
		return [...constantItems(), ...moduleFunctionItems()];
	}

	if (/\.\w*$/.test(linePrefix)) {
		return methodItems();
	}

	return [...classItems(), ...methodItems()];
}

export function registerPicoRubyCompletionProvider(): vscode.Disposable {
	const provider: vscode.CompletionItemProvider = {
		provideCompletionItems(document, position) {
			const range = new vscode.Range(position.with(undefined, 0), position);
			const linePrefix = document.getText(range);

			const snippetItems = lineHeadSnippetItems(linePrefix);
			const regularItems = contextItems(linePrefix);

			return [...snippetItems, ...regularItems];
		}
	};

	return vscode.languages.registerCompletionItemProvider(
		{ language: 'picoruby' },
		provider,
		'.',
		':'
	);
}
