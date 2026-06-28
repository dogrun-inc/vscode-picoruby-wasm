import * as assert from 'assert';
import * as vscode from 'vscode';

import { providePicoRubyCompletionsForLine } from '../completion/provider';

function labels(items: vscode.CompletionItem[]): string[] {
	return items.map((item) => item.label.toString());
}

suite('completion provider helpers', () => {
	test('default context returns classes and methods', () => {
		const items = providePicoRubyCompletionsForLine('pu');
		const names = labels(items);

		assert.ok(names.includes('Array'), 'default context should include classes');
		assert.ok(names.includes('puts'), 'default context should include methods');
		assert.ok(!names.includes('TRUE'), 'default context should not include constants');
	});

	test('double-colon context returns constants and module functions only', () => {
		const items = providePicoRubyCompletionsForLine('PicoRuby::');
		const names = labels(items);

		assert.ok(names.includes('TRUE'), ':: context should include constants');
		assert.ok(names.includes('require'), ':: context should include module functions');
		assert.ok(!names.includes('Array'), ':: context should not include classes');
		assert.ok(!names.includes('puts'), ':: context should not include regular methods');
	});

	test('dot context returns methods only', () => {
		const items = providePicoRubyCompletionsForLine('object.');
		const names = labels(items);

		assert.ok(names.includes('puts'), '. context should include methods');
		assert.ok(!names.includes('Array'), '. context should not include classes');
		assert.ok(!names.includes('TRUE'), '. context should not include constants');
	});

	test('line-head def prefix includes def snippet', () => {
		const items = providePicoRubyCompletionsForLine('de');
		const defItem = items.find((item) => item.label.toString() === 'def');

		assert.ok(defItem, 'def snippet must exist for line-head prefix');
		assert.strictEqual(defItem?.kind, vscode.CompletionItemKind.Snippet);
		assert.ok(defItem?.insertText instanceof vscode.SnippetString);
		assert.strictEqual(
			(defItem?.insertText as vscode.SnippetString).value,
			'def ${1:method_name}${2:(args)}\n\t${0}\nend'
		);
	});

	test('line-head class prefix includes class snippet', () => {
		const items = providePicoRubyCompletionsForLine('cla');
		const classItem = items.find((item) => item.label.toString() === 'class');

		assert.ok(classItem, 'class snippet must exist for line-head prefix');
		assert.strictEqual(classItem?.kind, vscode.CompletionItemKind.Snippet);
		assert.ok(classItem?.insertText instanceof vscode.SnippetString);
		assert.strictEqual(
			(classItem?.insertText as vscode.SnippetString).value,
			'class ${1:ClassName}\n\t${0}\nend'
		);
	});

	test('non line-head input does not include snippets', () => {
		const items = providePicoRubyCompletionsForLine('puts de');
		const snippetItems = items.filter(
			(item) => item.kind === vscode.CompletionItemKind.Snippet
		);

		assert.strictEqual(snippetItems.length, 0);
	});
});
