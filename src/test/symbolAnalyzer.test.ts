import * as assert from 'assert';
import { analyzeHtmlRubySource, analyzeRubySource, ScopeNode, SymbolInfo } from '../symbolAnalyzer';

function child(scope: ScopeNode, type: ScopeNode['type'], name?: string): ScopeNode {
	const result = scope.children.find(candidate => candidate.type === type && (name === undefined || candidate.name === name));
	assert.ok(result, `missing ${type} scope${name ? ` ${name}` : ''}`);
	return result;
}

function findSymbol(scope: ScopeNode, name: string): SymbolInfo | undefined {
	const direct = scope.symbols.find(symbol => symbol.name === name);
	return direct ?? scope.children.map(item => findSymbol(item, name)).find(Boolean);
}

const testSuite = typeof suite === 'undefined' ? describe : suite;

testSuite('Symbol analyzer', () => {
	test('tracks nested scopes without treating strings or comments as code', () => {
		const source = [
			'class Counter',
			'  def run',
			'    message = "this is end"',
			'    # def fake',
			'    if message',
			'      inside_if = 1',
			'      items.each do |item|',
			'        inside_block = item',
			'      end',
			'    end',
			'  end',
			'end'
		].join('\n');

		const table = analyzeRubySource('counter.rb', source);
		const counter = child(table.rootScope, 'class', 'Counter');
		const run = child(counter, 'method', 'run');
		const block = child(run, 'block');

		assert.deepStrictEqual(run.symbols.map(symbol => symbol.name), ['message', 'inside_if']);
		assert.strictEqual(block.symbols[0].name, 'item');
		assert.ok(block.endLine > block.startLine);
		assert.strictEqual(counter.endLine, 12);
		assert.strictEqual(findSymbol(run, 'fake'), undefined);
	});

	test('returns a scope tree for incomplete source', () => {
		const table = analyzeRubySource('incomplete.rb', 'class Sample\ndef build\n  value = 1');
		const sample = child(table.rootScope, 'class', 'Sample');
		const build = child(sample, 'method', 'build');

		assert.strictEqual(sample.endLine, 3);
		assert.strictEqual(build.endLine, 3);
		assert.strictEqual(build.symbols.find(symbol => symbol.name === 'value')?.inferredType, 'Integer');
	});

	test('infers literals, constructors, and documented method returns', () => {
		const source = [
			'class Repository',
			'  # @return [User]',
			'  def current_user',
			'  end',
			'  @count = 0',
			'  db = SQLite3::Database.new(":memory:")',
			'  items = []',
			'  user = current_user',
			'end'
		].join('\n');
		const table = analyzeRubySource('repository.rb', source);

		assert.strictEqual(findSymbol(table.rootScope, '@count')?.inferredType, 'Integer');
		assert.strictEqual(findSymbol(table.rootScope, 'db')?.inferredType, 'SQLite3::Database');
		assert.strictEqual(findSymbol(table.rootScope, 'items')?.inferredType, 'Array');
		assert.strictEqual(findSymbol(table.rootScope, 'user')?.inferredType, 'User');
	});

	test('attaches contiguous comments to class and method definitions', () => {
		const source = [
			'# Account operations.',
			'# @note PicoRuby compatible',
			'class Account',
			'  # Withdraws money.',
			'  # @return [Integer]',
			'  def withdraw',
			'  end',
			'end'
		].join('\n');
		const table = analyzeRubySource('account.rb', source);
		const account = table.rootScope.symbols.find(symbol => symbol.name === 'Account');
		const withdraw = child(table.rootScope, 'class', 'Account').symbols.find(symbol => symbol.name === 'withdraw');

		assert.strictEqual(account?.rawComment, 'Account operations.\n@note PicoRuby compatible');
		assert.strictEqual(withdraw?.rawComment, 'Withdraws money.\n@return [Integer]');
		assert.deepStrictEqual(withdraw?.params, []);
	});

	test('preserves HTML line offsets across embedded Ruby scripts', () => {
		const table = analyzeHtmlRubySource('index.html', [
			'<html>',
			'<script type="text/ruby">',
			'class Embedded',
			'end',
			'</script>',
			'<script type="text/javascript">def ignored; end</script>',
			'<script data-kind="test" type=\'text/ruby\'>module Extra',
			'end</script>',
			'</html>'
		].join('\n'));

		const embedded = child(table.rootScope, 'class', 'Embedded');
		const extra = child(table.rootScope, 'module', 'Extra');
		assert.strictEqual(embedded.startLine, 3);
		assert.strictEqual(embedded.endLine, 4);
		assert.strictEqual(extra.startLine, 7);
		assert.strictEqual(extra.endLine, 8);
		assert.strictEqual(findSymbol(table.rootScope, 'ignored'), undefined);
	});

	test('tokenizes literals and ignores keywords inside strings, regexps, and comments', () => {
		const source = [
			'# opening comment',
			"class LiteralSample",
			"  def literals",
			"    single = 'escaped \\' end'",
			'    double = "escaped \\" def"',
			'    pattern = /end[\\/]def/ix',
			'    quotient = total / 2',
			'    label = :ready!',
			'    quoted = :"quoted symbol"',
			'    value = 0x10 + 0b11 + 0o7',
			'    exponent = 1.2e+3',
			'  end # def ignored',
			'end'
		].join('\r\n');
		const table = analyzeRubySource('literals.rb', source);
		const sample = child(table.rootScope, 'class', 'LiteralSample');
		const method = child(sample, 'method', 'literals');

		assert.deepStrictEqual(
			method.symbols.map(symbol => symbol.inferredType),
			['String', 'String', 'String', undefined, 'Symbol', 'Symbol', 'Integer', 'Float']
				.slice(0, method.symbols.length)
		);
		assert.strictEqual(method.endLine, 12);
		assert.strictEqual(findSymbol(table.rootScope, 'ignored'), undefined);
		assert.strictEqual(method.symbols.find(symbol => symbol.name === 'value')?.column, 4);
	});

	test('records definition variants, parameters, superclasses, and local variable kinds', () => {
		const source = [
			'class Base',
			'end',
			'module Models::Storage',
			'end',
			'class Child::Record < Models::Base',
			'  def parse(value = build(1), **options, &block)',
			'  end',
			'  def save! output, mode: nil',
			'  end',
			'  def self.find?',
			'  end',
			'  @@total = 1',
			'  @cache = {}',
			'  LIMIT = 10',
			'end',
			'class',
			'def',
			'ignored = true'
		].join('\n');
		const table = analyzeRubySource('definitions.rb', source);
		const recordSymbol = table.rootScope.symbols.find(symbol => symbol.name === 'Child::Record');
		const record = child(table.rootScope, 'class', 'Child::Record');

		assert.strictEqual(recordSymbol?.superClass, 'Models::Base');
		assert.deepStrictEqual(
			record.symbols.filter(symbol => symbol.kind === 'method').map(symbol => symbol.name),
			['parse', 'save!', 'self.find?']
		);
		assert.deepStrictEqual(record.symbols.find(symbol => symbol.name === 'parse')?.params, ['value', 'options', 'block']);
		assert.deepStrictEqual(record.symbols.find(symbol => symbol.name === 'save!')?.params, ['output', 'mode']);
		assert.strictEqual(record.symbols.find(symbol => symbol.name === '@@total')?.kind, 'cvar');
		assert.strictEqual(record.symbols.find(symbol => symbol.name === '@cache')?.kind, 'ivar');
		assert.strictEqual(record.symbols.find(symbol => symbol.name === 'LIMIT')?.kind, 'constant');
	});

	test('keeps multiline strings opaque through LF, CRLF, and escaped newlines', () => {
		const source = [
			'def render',
			'  first = "plain',
			'    end',
			'    def fake"',
			'  second = \'crlf',
			'    end\'',
			'  third = "continued\\',
			'    end still quoted"',
			'  fourth = "escaped \\"end\\" text"',
			'  @after = 1',
			'end'
		].join('\r\n');
		const table = analyzeRubySource('multiline-string.rb', source);
		const method = child(table.rootScope, 'method', 'render');

		assert.deepStrictEqual(method.symbols.map(symbol => symbol.name), [
			'first',
			'second',
			'third',
			'fourth',
			'@after'
		]);
		assert.ok(method.symbols.every(symbol => symbol.inferredType === 'String' || symbol.inferredType === 'Integer'));
		assert.strictEqual(method.endLine, 11);
		assert.strictEqual(method.children.length, 0);
	});

	test('keeps multiline regular expressions opaque through LF, CRLF, and escaped newlines', () => {
		const source = [
			'def match',
			'  first = /plain',
			'    end',
			'    def fake/im',
			'  second = /continued\\',
			'    end still quoted/x',
			'  third = /class[\\/]end',
			'    def still_quoted/',
			'  @after = 1',
			'end'
		].join('\r\n');
		const table = analyzeRubySource('multiline-regexp.rb', source);
		const method = child(table.rootScope, 'method', 'match');

		assert.deepStrictEqual(method.symbols.map(symbol => symbol.name), [
			'first',
			'second',
			'third',
			'@after'
		]);
		assert.strictEqual(method.endLine, 10);
		assert.strictEqual(method.children.length, 0);
		assert.strictEqual(method.symbols.find(symbol => symbol.name === 'fake'), undefined);
		assert.strictEqual(method.symbols.find(symbol => symbol.name === 'still_quoted'), undefined);
	});

	test('handles control structures without creating local scopes', () => {
		const source = [
			'def process(values)',
			'  if values',
			'    from_if = true',
			'  end',
			'  unless false',
			'    from_unless = 2',
			'  else',
			'    from_else = 3',
			'  end',
			'  while ready?',
			'    from_while = 4',
			'  end',
			'  until stopped?',
			'    from_until = 5',
			'  end',
			'  for item in values',
			'    from_for = item',
			'  end',
			'  begin',
			'    from_begin = 6',
			'  end',
			'  case status',
			'  when :open',
			'    from_case = 7',
			'  end',
			'  postfix = 8 if enabled',
			'end'
		].join('\n');
		const table = analyzeRubySource('controls.rb', source);
		const method = child(table.rootScope, 'method', 'process');

		assert.deepStrictEqual(method.children, []);
		assert.deepStrictEqual(
			method.symbols.filter(symbol => symbol.kind === 'lvar').map(symbol => symbol.name),
			['from_if', 'from_unless', 'from_else', 'from_while', 'from_until', 'from_for', 'from_begin', 'from_case', 'postfix']
		);
	});

	test('distinguishes brace blocks from hash and array delimiters', () => {
		const source = [
			'def transform(items)',
			'  hashes = {one: {nested: true}}',
			'  items.map { |item, @captured|',
			'    [item, {key: item}]',
			'  }',
			'  while ready? do',
			'    loop_value = 1',
			'  end',
			'end'
		].join('\n');
		const table = analyzeRubySource('blocks.rb', source);
		const method = child(table.rootScope, 'method', 'transform');
		const block = child(method, 'block');

		assert.strictEqual(method.children.length, 1);
		assert.deepStrictEqual(block.symbols.map(symbol => symbol.name), ['item', '@captured']);
		assert.strictEqual(block.endLine, 5);
		assert.ok(method.symbols.some(symbol => symbol.name === 'loop_value'));
		assert.strictEqual(method.symbols.find(symbol => symbol.name === 'hashes')?.inferredType, 'Hash');
	});

	test('infers every supported assignment form and defers documented returns', () => {
		const source = [
			'# @return [Product]',
			'def product',
			'end',
			'method_value = self.product',
			'float_value = 3.14',
			'string_value = "value"',
			'symbol_value = :value',
			'array_value = [1]',
			'hash_value = {}',
			'true_value = true',
			'false_value = false',
			'instance_value = Thing.new',
			'nil_value = nil',
			'# Constant documentation',
			'VALUE = 1'
		].join('\n');
		const table = analyzeRubySource('inference.rb', source);

		assert.strictEqual(findSymbol(table.rootScope, 'method_value')?.inferredType, 'Product');
		assert.strictEqual(findSymbol(table.rootScope, 'float_value')?.inferredType, 'Float');
		assert.strictEqual(findSymbol(table.rootScope, 'string_value')?.inferredType, 'String');
		assert.strictEqual(findSymbol(table.rootScope, 'symbol_value')?.inferredType, 'Symbol');
		assert.strictEqual(findSymbol(table.rootScope, 'array_value')?.inferredType, 'Array');
		assert.strictEqual(findSymbol(table.rootScope, 'hash_value')?.inferredType, 'Hash');
		assert.strictEqual(findSymbol(table.rootScope, 'true_value')?.inferredType, 'Boolean');
		assert.strictEqual(findSymbol(table.rootScope, 'false_value')?.inferredType, 'Boolean');
		assert.strictEqual(findSymbol(table.rootScope, 'instance_value')?.inferredType, 'Thing');
		assert.strictEqual(findSymbol(table.rootScope, 'nil_value')?.inferredType, undefined);
		assert.strictEqual(findSymbol(table.rootScope, 'VALUE')?.rawComment, 'Constant documentation');
	});

	test('handles empty source, stale comments, duplicate lines, and line offsets', () => {
		const table = analyzeRubySource('edge.rb', '# stale\n\nVALUE = 1; VALUE = 2', 4);
		const empty = analyzeRubySource('empty.rb', '');

		assert.strictEqual(empty.rootScope.startLine, 1);
		assert.strictEqual(empty.rootScope.endLine, 1);
		assert.deepStrictEqual(empty.rootScope.symbols, []);
		assert.deepStrictEqual(table.rootScope.symbols.map(symbol => symbol.name), ['VALUE']);
		assert.strictEqual(table.rootScope.symbols[0].line, 7);
		assert.strictEqual(table.rootScope.symbols[0].rawComment, undefined);
		assert.strictEqual(table.rootScope.endLine, 7);
	});

	test('indexes supported Ruby script types and ignores missing types', () => {
		const table = analyzeHtmlRubySource('scripts.html', [
			'<script>def ignored_without_type; end</script>',
			'<script type=text/picoruby>def ignored_other_type; end</script>',
			'<script type="TEXT/RUBY">',
			'module Embedded',
			'end',
			'</script>'
		].join('\n'));

		assert.strictEqual(table.rootScope.startLine, 1);
		assert.strictEqual(table.rootScope.endLine, 6);
		assert.deepStrictEqual(table.rootScope.children.map(scope => scope.name), ['ignored_other_type', 'Embedded']);
	});

	test('ignores script-looking text outside executable Ruby scripts', () => {
		const table = analyzeHtmlRubySource('contexts.html', [
			'<!-- <script type="text/ruby">class Commented; end</script> -->',
			'<textarea><script type="text/ruby">class Textarea; end</script></textarea>',
			'<style><script type="text/ruby">class Styled; end</script></style>',
			'<div data-template="<script type=&quot;text/ruby&quot;>class Attribute; end</script>">template</div>',
			'<script data-type="text/ruby">class DataType; end</script>',
			'<script type="text/ruby-extra">class Prefix; end</script>',
			'<script type="text/picoruby">class Executable; end</script>',
			'<plaintext><script type="text/ruby">class Plaintext; end</script>'
		].join('\n'));

		assert.deepStrictEqual(table.rootScope.children.map(scope => scope.name), ['Executable']);
		assert.strictEqual(findSymbol(table.rootScope, 'DataType'), undefined);
	});

	test('preserves embedded Ruby columns in the surrounding HTML', () => {
		const source = [
			'<div><script data-example="class Inline" type="text/ruby">  class Inline < Base',
			'  def call(argument)',
			'  end',
			'end</script></div>'
		].join('\n');
		const table = analyzeHtmlRubySource('inline.html', source);
		const inline = table.rootScope.symbols.find(symbol => symbol.name === 'Inline');
		const inlineScope = child(table.rootScope, 'class', 'Inline');
		const call = inlineScope.symbols.find(symbol => symbol.name === 'call');
		const param = child(inlineScope, 'method', 'call').symbols.find(symbol => symbol.name === 'argument');

		assert.strictEqual(inline?.line, 1);
		assert.strictEqual(inline?.column, source.lastIndexOf('class Inline') + 'class '.length);
		assert.strictEqual(call?.line, 2);
		assert.strictEqual(call?.column, 6);
		assert.strictEqual(param?.line, 2);
		assert.strictEqual(param?.column, 11);
	});
});
