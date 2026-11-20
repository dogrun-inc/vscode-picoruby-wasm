import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments } from '../commentExtractor';

suite('PicoRuby hover', () => {
	const token = new vscode.CancellationTokenSource();
	let BUILTIN_DOCS: typeof import('../docs/builtins').BUILTIN_DOCS;
	let TAG_DOCS: typeof import('../docs/builtins').TAG_DOCS;
	let PicoRubyHoverProvider: typeof import('../hoverProvider').PicoRubyHoverProvider;
	let rubyScriptRanges: typeof import('../hoverProvider').rubyScriptRanges;

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension('dogrun-inc.picoruby-wasm');
		assert.ok(extension);
		await extension.activate();
		({ BUILTIN_DOCS, TAG_DOCS } = await import('../docs/builtins.js'));
		({ PicoRubyHoverProvider, rubyScriptRanges } = await import('../hoverProvider.js'));
	});
	suiteTeardown(() => token.dispose());

	async function hover(text: string, word: string, language = 'ruby', provider = new PicoRubyHoverProvider(async () => ({}))) {
		const document = await vscode.workspace.openTextDocument({ content: text, language });
		return provider.provideHover(document, document.positionAt(text.indexOf(word) + 1), token.token);
	}

	test('extracts adjacent comments and definition headers', () => {
		const definitions = extractComments('# カウンターを1増やす\n# @param amount [Integer] 増加量\ndef increment(amount = 1)\nend\n# Detached\n\nclass Counter\nend\n# Module docs\nmodule Helpers\nend');
		assert.strictEqual(definitions[0].description, 'カウンターを1増やす\n\n**Parameters:**\n\n- `amount` (`Integer`) — 増加量');
		assert.strictEqual(definitions[0].signature, 'def increment(amount = 1)');
		assert.strictEqual(definitions[1].description, '');
		assert.strictEqual(definitions[2].name, 'Helpers');
	});

	test('preserves singleton method names and resolves their documentation by method name', async () => {
		for (const name of ['service.charge', 'Wallet::charge', 'Payments::Wallet::charge', 'self.charge']) {
			const signature = `def ${name}(amount)`;
			const text = `charge(100)\n# Charges the wallet\n${signature}\nend`;
			assert.deepStrictEqual(extractComments(text), [{
				name,
				signature,
				description: 'Charges the wallet'
			}]);
			const result = await hover(text, 'charge');
			assert.ok(result, name);
			const body = (result.contents[0] as vscode.MarkdownString).value;
			assert.ok(body.includes(signature), name);
			assert.ok(body.includes('Charges the wallet'), name);
		}
	});

	test('qualified APIs resolve at each segment', async () => {
		for (const [text, words] of [
			['SQLite3::Database.new(":memory:")', ['SQLite3', 'Database', 'new']],
			['Funicular::Component', ['Funicular', 'Component']],
			['JS.global', ['JS', 'global']]
		] as const) {
			for (const word of words) {
				const result = await hover(text, word);
				assert.ok(result);
				assert.ok((result.contents[0] as vscode.MarkdownString).value.includes(text.split('(')[0]));
			}
		}
	});

	test('supports Funicular helpers and SQLite execution', async () => {
		for (const word of ['patch', 'h1', 'execute', 'puts']) {
			assert.ok(await hover(word, word, 'picoruby'));
		}
	});

	test('localizes built-in and tag descriptions using the VS Code display language', async () => {
		const japanese = vscode.env.language.toLowerCase().split('-')[0] === 'ja';
		const putsDescription = japanese
			? '値を文字列として、末尾に改行を付けて出力します。'
			: 'Outputs values as strings, followed by a newline.';
		const tagDescription = japanese
			? 'Funicular の render 内で HTML の h1 要素を定義するタグヘルパーです。属性をキーワード引数で指定します。'
			: 'Defines an HTML h1 element in a Funicular render method. Specify attributes as keyword arguments.';
		assert.strictEqual(BUILTIN_DOCS.puts.description, putsDescription);
		assert.strictEqual(TAG_DOCS.h1.description, tagDescription);
		for (const docs of [...Object.values(BUILTIN_DOCS), ...Object.values(TAG_DOCS)]) {
			assert.strictEqual(/[\u3040-\u30ff\u3400-\u9fff]/.test(docs.description), japanese, docs.description);
		}
		const putsHover = await hover('puts', 'puts');
		const tagHover = await hover('h1', 'h1');
		assert.ok(putsHover);
		assert.ok(tagHover);
		assert.ok((putsHover.contents[0] as vscode.MarkdownString).value.includes(putsDescription));
		assert.ok((tagHover.contents[0] as vscode.MarkdownString).value.includes(tagDescription));

		const document = await vscode.workspace.openTextDocument({ content: 'puts', language: 'ruby' });
		const registeredHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider', document.uri, new vscode.Position(0, 1)
		);
		assert.ok(registeredHovers?.some(result => result.contents.some(content =>
			typeof content !== 'string' && content.value.includes(putsDescription)
		)));
	});

	test('HTML hover is limited to Ruby script bodies', async () => {
		const text = '<div>patch</div><!-- <script type="text/ruby">patch</script> --><script type="text/javascript">patch</script><SCRIPT data-note=">" TYPE = \'text/ruby\'>h1</SCRIPT>';
		assert.strictEqual(await hover(text, 'patch', 'html'), null);
		assert.ok(await hover(text, 'h1', 'html'));
		const ranges = rubyScriptRanges(text);
		assert.deepStrictEqual(ranges.map(range => text.slice(range.start, range.end)), ['h1']);
	});

	test('supports text/picoruby script bodies and definitions across Ruby scripts', async () => {
		const text = '<script type="text/ruby">increment(1)</script><SCRIPT TYPE="TEXT/PICORUBY">\n# Project docs\ndef increment(amount)\nend\nputs amount\n</SCRIPT>';
		const ranges = rubyScriptRanges(text);
		assert.deepStrictEqual(ranges.map(range => text.slice(range.start, range.end)), [
			'increment(1)', '\n# Project docs\ndef increment(amount)\nend\nputs amount\n'
		]);
		const definition = await hover(text, 'increment', 'html');
		assert.ok(definition);
		assert.ok((definition.contents[0] as vscode.MarkdownString).value.includes('Project docs'));
		assert.ok(await hover(text, 'puts', 'html'));

		const document = await vscode.workspace.openTextDocument({ content: text, language: 'html' });
		const registeredHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider', document.uri, document.positionAt(text.indexOf('puts') + 1)
		);
		assert.ok(registeredHovers?.some(result => result.contents.some(content =>
			typeof content !== 'string' && content.value.includes('puts(*objects)')
		)));
	});

	test('ignores text/picoruby outside actual script type attributes', async () => {
		const text = '<!-- <script type="text/picoruby">puts</script> --><textarea><script type="text/picoruby">puts</script></textarea><script data-type="text/picoruby">puts</script><script type="text/picoruby-extra">puts</script>';
		assert.deepStrictEqual(rubyScriptRanges(text), []);
		const document = await vscode.workspace.openTextDocument({ content: text, language: 'html' });
		const provider = new PicoRubyHoverProvider(async () => ({}));
		for (const match of text.matchAll(/puts/g)) {
			assert.strictEqual(await provider.provideHover(document, document.positionAt(match.index! + 1), token.token), null);
		}
	});

	test('ignores script-looking text in raw-text/RCDATA elements and quoted attributes', () => {
		const text = '<textarea><script type="text/ruby">puts</script></textarea><style><script type="text/ruby">puts</script></style><div data-template="<script type=\'text/ruby\'>puts</script>">patch</div><script type="text/ruby">h1</script>';
		const ranges = rubyScriptRanges(text);
		assert.ok(!ranges.some(range => text.indexOf('puts') >= range.start && text.indexOf('puts') < range.end));
		assert.deepStrictEqual(ranges.map(range => text.slice(range.start, range.end)), ['h1']);
	});

	test('limits an HTML document to the actual Ruby script', () => {
		const text = [
			'<textarea rows="2" cols="60"><script type="text/ruby">puts "textarea"</script></textarea>',
			'<div data-example=\'<script type="text/ruby">puts "attribute"</script>\'>attribute</div>',
			'<script type="text/ruby">\nclass App\n  def call\n    puts "hello from picoruby in html"\n  end\nend\n</script>',
			'<script>\nconsole.log("normal js block");\n</script>'
		].join('\n');
		const bodies = rubyScriptRanges(text).map(range => text.slice(range.start, range.end));
		assert.strictEqual(bodies.length, 1);
		assert.ok(bodies[0].includes('puts "hello from picoruby in html"'));
		assert.ok(!bodies[0].includes('puts "textarea"'));
		assert.ok(!bodies[0].includes('puts "attribute"'));
	});

	test('finds documentation defined in sibling files of the hovered document', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-hover-'));
		writeFileSync(path.join(directory, 'docs.rb'), '# Charges the wallet\ndef deposit(amount)\nend\n\n# Reviews values\ndef review_sample(values)\nend\n');
		writeFileSync(path.join(directory, 'main.rb'), 'deposit(100)\nreview_sample([])\n');
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'main.rb')));
		const provider = new PicoRubyHoverProvider();
		try {
			for (const word of ['deposit', 'review_sample']) {
				const result = await provider.provideHover(
					document, document.positionAt(document.getText().indexOf(word) + 1), token.token
				);
				assert.ok(result);
				assert.ok((result.contents[0] as vscode.MarkdownString).value.includes(`def ${word}`));
			}
		} finally {
			provider.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('local comments precede project definitions and render as Markdown', async () => {
		const result = await hover('# **Local** docs\ndef increment(amount = 1)\nend', 'increment');
		assert.ok(result);
		const markdown = result.contents[0] as vscode.MarkdownString;
		assert.ok(markdown.value.includes('def increment(amount = 1)'));
		assert.ok(markdown.value.includes('**Local** docs'));
		assert.ok(!markdown.isTrusted);
	});

	test('renders parsed documentation in HTML with a signature separator', async () => {
		const result = await hover('<script type="text/ruby">\n# == Details\n# @param value [Integer] +value+ to add\n# @example Usage\n#   deposit(1)\ndef deposit(value)\nend\n</script>', 'deposit', 'html');
		assert.ok(result);
		const body = (result.contents[0] as vscode.MarkdownString).value;
		assert.ok(body.includes('\n---\n\n## Details'));
		assert.ok(body.includes('- `value` (`Integer`) — `value` to add'));
		assert.ok(body.includes('```ruby\ndeposit(1)\n```'));
	});

	test('nodoc hides the comment body while retaining the definition signature', async () => {
		const result = await hover('# :nodoc:\n# Secret documentation\ndef hidden_method\nend', 'hidden_method');
		assert.ok(result);
		const body = (result.contents[0] as vscode.MarkdownString).value;
		assert.ok(body.includes('def hidden_method'));
		assert.ok(!body.includes('Secret'));
		assert.ok(!body.includes(':nodoc:'));
		assert.ok(!body.includes('---'));
	});

	test('searches VFS files and handles collection errors', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(__filename));
		const position = document.positionAt(document.getText().indexOf('assert'));
		const provider = new PicoRubyHoverProvider(async () => ({ 'helpers.rb': '# Project docs\ndef assert\nend' }));
		const result = await provider.provideHover(document, position, token.token);
		assert.ok(result);
		assert.ok((result.contents[0] as vscode.MarkdownString).value.includes('Project docs'));
		const failing = new PicoRubyHoverProvider(async () => { throw new Error('Unreadable'); });
		assert.strictEqual(await failing.provideHover(document, position, token.token), null);
	});
});
