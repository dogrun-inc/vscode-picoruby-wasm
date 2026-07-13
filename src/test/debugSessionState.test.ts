import * as assert from 'assert';
import * as path from 'path';

import { picoRubyWasmWebviewTestHooks } from '../debug/session';

suite('debug session state', () => {
	test('stores normalized breakpoint lines', () => {
		const harness = picoRubyWasmWebviewTestHooks.createMockSessionStateHarness();

		harness.setBreakpoints({
			breakpoints: [
				{ line: 8 },
				{ line: 3 },
				{ line: 8 },
				{ line: 0 },
				{}
			]
		});

		assert.deepStrictEqual(harness.getBreakpointLines(), [3, 8]);
	});

	test('maps first runtime stop to entry and updates stack frame line', () => {
		const harness = picoRubyWasmWebviewTestHooks.createMockSessionStateHarness();
		const programPath = path.resolve('sample', 'picoruby.rb');

		harness.configureExecutionForTest(programPath, true);

		assert.strictEqual(harness.recordRuntimeStop(12), 'entry');

		const [frame] = harness.createStackFrames();
		assert.strictEqual(frame.line, 12);
		assert.strictEqual(frame.source.path, programPath);
		assert.strictEqual(frame.source.name, 'picoruby.rb');
	});

	test('maps subsequent runtime stops to breakpoint', () => {
		const harness = picoRubyWasmWebviewTestHooks.createMockSessionStateHarness();

		harness.configureExecutionForTest(path.resolve('sample', 'puts.rb'), true);
		assert.strictEqual(harness.recordRuntimeStop(1), 'entry');
		assert.strictEqual(harness.recordRuntimeStop(19), 'breakpoint');
		assert.strictEqual(harness.createStackFrames()[0].line, 19);
	});
});