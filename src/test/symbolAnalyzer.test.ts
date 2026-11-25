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
});
