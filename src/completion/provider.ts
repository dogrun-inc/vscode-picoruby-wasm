import * as vscode from 'vscode';
import {
	PICORUBY_BUILTIN_CLASSES,
	PICORUBY_BUILTIN_CONSTANTS,
	PICORUBY_BUILTIN_METHODS,
	PICORUBY_MODULE_FUNCTIONS
} from './builtins';

/**
 * Builds completion items for PicoRuby built-in class names.
 */
function classItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_CLASSES.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
		item.detail = 'PicoRuby built-in class';
		item.insertText = name;
		return item;
	});
}

/**
 * Builds completion items for PicoRuby built-in methods.
 */
function methodItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_METHODS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
		item.detail = 'PicoRuby built-in method';
		item.insertText = name;
		return item;
	});
}

/**
 * Builds completion items for PicoRuby built-in constants.
 */
function constantItems(): vscode.CompletionItem[] {
	return PICORUBY_BUILTIN_CONSTANTS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
		item.detail = 'PicoRuby built-in constant';
		item.insertText = name;
		return item;
	});
}

/**
 * Builds completion items for PicoRuby module-level functions.
 */
function moduleFunctionItems(): vscode.CompletionItem[] {
	return PICORUBY_MODULE_FUNCTIONS.map((name) => {
		const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
		item.detail = 'PicoRuby module function';
		item.insertText = name;
		return item;
	});
}

/**
 * Returns line-head snippet candidates for `def` and `class`.
 *
 * Snippets are offered only when the current line prefix is composed of
 * optional leading spaces plus an identifier fragment.
 */
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

/**
 * Selects regular completion candidates by simple line-prefix regex matching.
 *
 * - `::` context: constants and module functions
 * - `.` context: methods only
 * - default: classes and methods
 */
function contextItems(linePrefix: string): vscode.CompletionItem[] {
	if (/::\w*$/.test(linePrefix)) {
		return [...constantItems(), ...moduleFunctionItems()];
	}

	if (/\.\w*$/.test(linePrefix)) {
		return methodItems();
	}

	return [...classItems(), ...methodItems()];
}

/**
 * Produces all completion items for a line prefix by merging snippet and
 * context-aware regular candidates.
 */
export function providePicoRubyCompletionsForLine(
	linePrefix: string
): vscode.CompletionItem[] {
	const snippetItems = lineHeadSnippetItems(linePrefix);
	const regularItems = contextItems(linePrefix);

	return [...snippetItems, ...regularItems];
}

/**
 * Registers the PicoRuby completion provider for the `picoruby` language.
 */
export function registerPicoRubyCompletionProvider(): vscode.Disposable {
	const provider: vscode.CompletionItemProvider = {
		/**
		 * Returns completion items for the current cursor position.
		 */
		provideCompletionItems(document, position) {
			const range = new vscode.Range(position.with(undefined, 0), position);
			const linePrefix = document.getText(range);

			return providePicoRubyCompletionsForLine(linePrefix);
		}
	};

	return vscode.languages.registerCompletionItemProvider(
		{ language: 'picoruby' },
		provider,
		'.',
		':'
	);
}
