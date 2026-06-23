import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	const repoRoot = path.resolve(__dirname, '..', '..');

	const readJson = (relativePath: string): any => {
		const filePath = path.join(repoRoot, relativePath);
		const content = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(content);
	};

	test('package.json registers picoruby grammars', () => {
		const pkg = readJson('package.json');
		const grammars = pkg.contributes?.grammars as any[];

		assert.ok(Array.isArray(grammars), 'contributes.grammars must be an array');

		const picorubyGrammar = grammars.find(
			(g) => g.language === 'picoruby' && g.scopeName === 'source.picoruby'
		);
		assert.ok(picorubyGrammar, 'picoruby base grammar must be registered');
		assert.strictEqual(
			picorubyGrammar.path,
			'./syntaxes/picoruby.tmLanguage.json',
			'picoruby base grammar path must match'
		);

		const htmlInjection = grammars.find(
			(g) => g.scopeName === 'text.html.picoruby.injection'
		);
		assert.ok(htmlInjection, 'html injection grammar must be registered');
		assert.strictEqual(
			htmlInjection.path,
			'./syntaxes/picoruby-in-html.tmLanguage.json',
			'html injection grammar path must match'
		);
		assert.ok(
			Array.isArray(htmlInjection.injectTo) &&
				htmlInjection.injectTo.includes('text.html.basic') &&
				htmlInjection.injectTo.includes('text.html.derivative'),
			'html injection must target text.html.basic and text.html.derivative'
		);
		assert.strictEqual(
			htmlInjection.embeddedLanguages?.['meta.embedded.block.picoruby'],
			'picoruby',
			'embedded language mapping must point to picoruby language id'
		);
	});

	test('picoruby base grammar structure is valid', () => {
		const grammar = readJson('syntaxes/picoruby.tmLanguage.json');

		assert.strictEqual(grammar.scopeName, 'source.picoruby');
		assert.ok(Array.isArray(grammar.patterns), 'patterns must be an array');
		assert.ok(
			grammar.patterns.some((p: any) => p.include === 'source.ruby'),
			'base grammar must include source.ruby'
		);
	});

	test('html injection grammar captures script type text/ruby', () => {
		const injection = readJson('syntaxes/picoruby-in-html.tmLanguage.json');

		assert.strictEqual(injection.scopeName, 'text.html.picoruby.injection');
		assert.ok(
			typeof injection.injectionSelector === 'string' &&
				injection.injectionSelector.includes('L:text.html'),
			'injection selector must target html scopes'
		);

		const firstPattern = injection.patterns?.[0];
		assert.ok(firstPattern, 'injection must define at least one pattern');
		assert.ok(
			typeof firstPattern.begin === 'string' && firstPattern.begin.includes('text/ruby'),
			'begin regex must match script type text/ruby'
		);
		assert.strictEqual(
			firstPattern.contentName,
			'meta.embedded.block.picoruby',
			'contentName must match package embeddedLanguages key'
		);
		assert.ok(
			Array.isArray(firstPattern.patterns) &&
				firstPattern.patterns.some((p: any) => p.include === 'source.picoruby'),
			'injected content must include source.picoruby'
		);
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
