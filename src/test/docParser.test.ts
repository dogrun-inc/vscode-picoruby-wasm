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

	test('formats the review sample with protected code and nested YARD types', () => {
		const sample = readFileSync(path.resolve(__dirname, '../../sample/doc_sample.rb'), 'utf8');
		const review = extractComments(sample).find(definition => definition.name === 'review_sample');
		assert.ok(review);
		for (const expected of [
			'``use `+value+` here``',
			'**強調** と `code`',
			'```ruby\nputs "+literal+ *value*"\n```',
			'```ruby\nif ready\n  puts "+literal+ *value*"\nend\n```',
			'- `values` (`Array[Integer]`) — 型を先に書いた整数の配列',
			'- `mapping` (`Hash[String, Array[Integer]]`) — 名前を先に書いた入れ子の型',
			'**Returns:** `Hash[String, Array[Integer]]` — 配列を含む結果',
			'**Example:** インスタンス変数を含むコード\n\n```ruby\n@balance = 1\n@param = "+literal+ *value*"\nif ready\n  puts @balance\nend\n```',
			'**Example:** 別のコード例\n\n```ruby\nputs "done"\n```'
		]) {
			assert.ok(review.description.includes(expected), expected);
		}
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

	test('protects two- and four-space code blocks including nested indentation', () => {
		for (const indent of ['  ', '    ']) {
			const source = ['Example:', '', indent + 'if ready', indent + '  puts "+literal+ *value*"', '', indent + 'end', '', '*After*'].join('\n');
			assert.strictEqual(parseRubyDoc(source), 'Example:\n\n```ruby\nif ready\n  puts "+literal+ *value*"\n\nend\n```\n\n**After**');
		}
	});

	test('measures indentation relative to the common comment margin', () => {
		assert.strictEqual(parseRubyDoc('  Example:\n\n    puts "+literal+"\n  *After*'),
			'Example:\n\n```ruby\nputs "+literal+"\n```\n\n**After**');
	});

	test('protects tag-looking code before parsing YARD tags', () => {
		const body = parseRubyDoc('Example:\n  @param = "+literal+"\n  @balance = 1\n@param amount [Integer] charge');
		assert.strictEqual(body, 'Example:\n\n```ruby\n@param = "+literal+"\n@balance = 1\n```\n\n**Parameters:**\n\n- `amount` (`Integer`) — charge');
	});

	test('keeps one-space indentation as prose', () => {
		assert.strictEqual(parseRubyDoc('Text\n *bold*'), 'Text\n **bold**');
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

	test('supports nested bracketed types for parameters, returns and raises', () => {
		const body = parseRubyDoc('@param [Array[Integer]] values list of values\n@param mapping [Hash[String, Array[Integer]]] nested values\n@param [String] title\n@param name display name\n@return [Array[Hash[String, Integer]]] calculated values\n@raise [ValidationError[ArgumentError]] if invalid');
		assert.strictEqual(body, '**Parameters:**\n\n- `values` (`Array[Integer]`) — list of values\n- `mapping` (`Hash[String, Array[Integer]]`) — nested values\n- `title` (`String`)\n- `name` — display name\n\n**Returns:** `Array[Hash[String, Integer]]` — calculated values\n\n**Raises:**\n\n- `ValidationError[ArgumentError]` — if invalid');
	});

	test('preserves example indentation, blank lines and literal decorations', () => {
		const body = parseRubyDoc('@example\n  if ready\n    puts "+literal+ *value*"\n\n    puts "done"\n  end\n@param value [String] input');
		assert.ok(body.includes('```ruby\nif ready\n  puts "+literal+ *value*"\n\n  puts "done"\nend\n```'));
		assert.ok(body.includes('- `value` (`String`) — input'));
	});

	test('keeps instance variables and tag-looking code inside examples', () => {
		const source = [
			'@example *Balance*',
			'  @balance = 1',
			'  @param = "+literal+"',
			'  if ready',
			'    @balance += 1',
			'',
			'    puts @balance',
			'  end',
			'@param amount [Integer] charge',
			'@example Next',
			'  puts "done"'
		].join('\n');
		assert.strictEqual(parseRubyDoc(source), [
			'**Parameters:**\n\n- `amount` (`Integer`) — charge',
			'**Example:** **Balance**\n\n```ruby\n@balance = 1\n@param = "+literal+"\nif ready\n  @balance += 1\n\n  puts @balance\nend\n```',
			'**Example:** Next\n\n```ruby\nputs "done"\n```'
		].join('\n\n'));
	});

	test('ends an indented example at tags at the same or shallower indentation', () => {
		const source = [
			'Description',
			' @example First',
			'   @balance = 1',
			' @example Second',
			'   @param = 2',
			'@return [Integer] result'
		].join('\n');
		assert.strictEqual(parseRubyDoc(source), [
			'Description',
			'**Returns:** `Integer` — result',
			'**Example:** First\n\n```ruby\n@balance = 1\n```',
			'**Example:** Second\n\n```ruby\n@param = 2\n```'
		].join('\n\n'));
	});

	test('preserves example code relative to a nonzero common comment margin', () => {
		const source = [
			'  @example',
			'    @balance = 1',
			'    puts @balance',
			'  @param amount [Integer] charge'
		].join('\n');
		assert.strictEqual(parseRubyDoc(source), [
			'**Parameters:**\n\n- `amount` (`Integer`) — charge',
			'**Example:**\n\n```ruby\n@balance = 1\nputs @balance\n```'
		].join('\n\n'));
	});

	test('preserves fenced Markdown code and handles CRLF and empty input', () => {
		assert.strictEqual(parseRubyDoc('```ruby\nputs "+literal+"\n```'), '```ruby\nputs "+literal+"\n```');
		assert.strictEqual(parseRubyDoc('== Title\r\ntext'), '## Title\ntext');
		assert.strictEqual(parseRubyDoc(' \n'), '');
		assert.strictEqual(parseRubyDoc('Hidden :nodoc:\n@param x docs'), '');
	});
});
