import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments } from '../commentExtractor';
import { PicoRubyHoverProvider, rubyScriptRanges } from '../hoverProvider';

suite('PicoRuby hover', () => {
	const token = new vscode.CancellationTokenSource();
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

	test('HTML hover is limited to Ruby script bodies', async () => {
		const text = '<div>patch</div><!-- <script type="text/ruby">patch</script> --><script type="text/javascript">patch</script><SCRIPT data-note=">" TYPE = \'text/ruby\'>h1</SCRIPT>';
		assert.strictEqual(await hover(text, 'patch', 'html'), null);
		assert.ok(await hover(text, 'h1', 'html'));
		const ranges = rubyScriptRanges(text);
		assert.deepStrictEqual(ranges.map(range => text.slice(range.start, range.end)), ['h1']);
	});

	test('ignores script-looking text in raw-text/RCDATA elements and quoted attributes', () => {
		const text = '<textarea><script type="text/ruby">puts</script></textarea><style><script type="text/ruby">puts</script></style><div data-template="<script type=\'text/ruby\'>puts</script>">patch</div><script type="text/ruby">h1</script>';
		const ranges = rubyScriptRanges(text);
		assert.ok(!ranges.some(range => text.indexOf('puts') >= range.start && text.indexOf('puts') < range.end));
		assert.deepStrictEqual(ranges.map(range => text.slice(range.start, range.end)), ['h1']);
	});

	test('limits the HTML sample to the actual Ruby script', () => {
		const text = readFileSync(path.resolve(__dirname, '../../sample/picoruby_injection.html'), 'utf8');
		const bodies = rubyScriptRanges(text).map(range => text.slice(range.start, range.end));
		assert.strictEqual(bodies.length, 1);
		assert.ok(bodies[0].includes('puts "hello from picoruby in html"'));
		assert.ok(!bodies[0].includes('puts "textarea"'));
		assert.ok(!bodies[0].includes('puts "attribute"'));
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
