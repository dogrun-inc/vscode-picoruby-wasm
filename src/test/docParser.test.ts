import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseRubyDoc } from '../docParser';
import { extractComments } from '../commentExtractor';

suite('Ruby documentation parser', () => {
	test('formats the wallet sample with grouped tags and separate examples', () => {
		const sample = readFileSync(path.resolve(__dirname, '../../sample/doc_sample.rb'), 'utf8');
		const [deposit, internal] = extractComments(sample);
		const body = deposit.description;
		assert.ok(body.startsWith('ユーザーのウォレット残高'));
		for (const expected of ['## 注意事項', '**Parameters:**', '- `amount` (`Integer`) — チャージする金額 (`単位: 円`)',
			'- `dry_run` (`Boolean`)', '**Returns:** `Hash` — 更新後の状態 (`:balance` と `:updated_at`)',
			'**Raises:**\n\n- `ArgumentError` — `amount` が 0 以下の場合',
			'**Example:** 通常のチャージ\n\n```ruby\nwallet.deposit(1000)\n```',
			'**Example:** シミュレーション\n\n```ruby\nwallet.deposit(500, dry_run: true)\n```']) {
			assert.ok(body.includes(expected), expected);
		}
		assert.strictEqual(internal.description, '');
	});

	test('converts RDoc decoration without changing Markdown or identifiers', () => {
		assert.strictEqual(parseRubyDoc('=== Heading\n*bold* _italic_ +some_code+\n* item\n- other\nsnake_case **Markdown** `*literal*`'),
			'### Heading\n**bold** *italic* `some_code`\n* item\n- other\nsnake_case **Markdown** `*literal*`');
	});

	test('keeps Markdown and code contents while converting surrounding decorations', () => {
		assert.strictEqual(parseRubyDoc('*before* [*link*](https://example.com) _after_ **+bold+** `+code+` +*literal* _value_+'),
			'**before** [*link*](https://example.com) *after* **+bold+** `+code+` `*literal* _value_`');
	});

	test('protects code spans with matching backtick runs and converts surrounding text', () => {
		const spans = [
			'`+value+ *literal*`',
			'``use `+value+` here``',
			'```use ``+value+`` and `*literal*` here```',
			'``use ```+value+``` here``'
		];
		for (const span of spans) {
			assert.strictEqual(parseRubyDoc(`*before* ${span} +after+`), `**before** ${span} \`after\``);
		}
	});

	test('does not close a code span with a different number of backticks', () => {
		for (const text of ['Text: ``+value+`', 'Text: `+value+``', 'Text: ```+value+``']) {
			assert.strictEqual(parseRubyDoc(text), text.replace('+value+', '`value`'));
		}
	});

	test('distinguishes emphasis boundaries from lists, identifiers and unclosed delimiters', () => {
		assert.strictEqual(parseRubyDoc('* item *bold*\n(_italic_), *b*!\nname_value a*b* * spaced* _spaced _\n+unclosed *bold*'),
			'* item **bold**\n(*italic*), **b**!\nname_value a*b* * spaced* _spaced _\n+unclosed **bold**');
	});

	test('supports optional types, repeated raises, notes, references and continuation lines', () => {
		const body = parseRubyDoc('@param name display name\n  continued\n@return a result\n@raise [Error] failure\n@raise [Other] another\n@note Be *careful*\n@see https://example.com/docs\n@see Wallet#deposit');
		assert.ok(body.includes('- `name` — display name continued'));
		assert.ok(body.includes('**Returns:** a result'));
		assert.ok(body.includes('**Raises:**\n\n- `Error` — failure\n- `Other` — another'));
		assert.ok(body.includes('> **Note:** Be **careful**'));
		assert.ok(body.includes('**See:** <https://example.com/docs>'));
		assert.ok(body.includes('**See:** `Wallet#deposit`'));
	});

	test('preserves example indentation, blank lines and literal decorations', () => {
		const body = parseRubyDoc('@example\n  if ready\n    puts "+literal+ *value*"\n\n    puts "done"\n  end\n@param value [String] input');
		assert.ok(body.includes('```ruby\nif ready\n  puts "+literal+ *value*"\n\n  puts "done"\nend\n```'));
		assert.ok(body.includes('- `value` (`String`) — input'));
	});

	test('preserves fenced Markdown code and handles CRLF and empty input', () => {
		assert.strictEqual(parseRubyDoc('```ruby\nputs "+literal+"\n```'), '```ruby\nputs "+literal+"\n```');
		assert.strictEqual(parseRubyDoc('== Title\r\ntext'), '## Title\ntext');
		assert.strictEqual(parseRubyDoc(' \n'), '');
		assert.strictEqual(parseRubyDoc('Hidden :nodoc:\n@param x docs'), '');
	});
});
