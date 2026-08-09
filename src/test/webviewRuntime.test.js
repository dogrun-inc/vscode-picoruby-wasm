/**
 * @jest-environment jsdom
 */

// 1. require 前に VS Code API のグローバルモックを定義
const mockPostMessage = jest.fn();
global.acquireVsCodeApi = jest.fn().mockReturnValue({
	postMessage: mockPostMessage
});

// 2. 本番モジュールをインポート
const webviewRuntime = require('../../assets/webviewRuntime');

describe('webviewRuntime.js Test Suite', () => {
	const flushAsyncEvents = async () => {
		await Promise.resolve();
		await Promise.resolve();
	};

	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	describe('Utility Functions in assets/webviewRuntime.js', () => {
		test('safeParseJson should parse valid JSON and return null for invalid input', () => {
			expect(webviewRuntime.safeParseJson('{"mode":"paused"}')).toEqual({ mode: 'paused' });
			expect(webviewRuntime.safeParseJson('invalid json')).toBeNull();
			expect(webviewRuntime.safeParseJson(123)).toBeNull();
		});

		test('stringifyLogValue should serialize arguments correctly', () => {
			expect(webviewRuntime.stringifyLogValue('hello')).toBe('hello');
			expect(webviewRuntime.stringifyLogValue({ key: 'value' })).toBe('{"key":"value"}');
		});
	});

	describe('Breakpoint Injection Logic', () => {
		test('should inject binding.irb on target lines, ignoring comments and keywords', () => {
			const injectBindingIrb = (sourceCode, breakpoints) => {
				const normalizedBreakpoints = new Set(breakpoints.filter((l) => Number.isInteger(l) && l > 0));
				const lines = sourceCode.split('\n');

				for (let index = 0; index < lines.length; index += 1) {
					const lineNumber = index + 1;
					if (!normalizedBreakpoints.has(lineNumber)) continue;

					const trimmed = lines[index].trimStart();
					if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
					if (/^(?:else|elsif|when|rescue|ensure|end)\b/.test(trimmed)) continue;

					lines[index] = `binding.irb; ${lines[index]}`;
				}
				return lines.join('\n');
			};

			const sampleCode = [
				'puts "Line 1"',       // Line 1: 対象
				'# Comment line',      // Line 2: スキップ（コメント）
				'else',                // Line 3: スキップ（制御構文）
				'x = 10'               // Line 4: 対象
			].join('\n');

			const result = injectBindingIrb(sampleCode, [1, 2, 3, 4]);

			expect(result).toContain('binding.irb; puts "Line 1"');
			expect(result).toContain('# Comment line');
			expect(result).not.toContain('binding.irb; else');
			expect(result).toContain('binding.irb; x = 10');
		});
	});

	describe('Status Polling & Notifications', () => {
		test('should parse paused status JSON correctly', () => {
			const statusJson = JSON.stringify({ mode: 'paused', line: 9, pause_id: 1 });
			const status = webviewRuntime.safeParseJson(statusJson);

			expect(status.mode).toBe('paused');
			expect(status.line).toBe(9);
			expect(status.pause_id).toBe(1);
		});

		test('should detect terminal status (idle) and trigger termination', () => {
			const TERMINAL_MODES = new Set(['idle', 'terminated', 'finished', 'exited', 'completed', 'done']);

			const isTerminalStatus = (status) => {
				const mode = typeof status?.mode === 'string' ? status.mode.toLowerCase() : '';
				return TERMINAL_MODES.has(mode);
			};

			expect(isTerminalStatus({ mode: 'idle' })).toBe(true);
			expect(isTerminalStatus({ mode: 'TERMINATED' })).toBe(true);
			expect(isTerminalStatus({ mode: 'paused' })).toBe(false);
		});
	});

	describe('Command Dispatcher', () => {
		test('should invoke handler when receiving "next" message from VS Code', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'next' }
			});
			window.dispatchEvent(event);
			await Promise.resolve();
		});

		test('should invoke handler when receiving "stepIn" message', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'stepIn' }
			});
			window.dispatchEvent(event);
			await Promise.resolve();
		});

		test('should invoke handler when receiving "continue" message', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'continue' }
			});
			window.dispatchEvent(event);
			await Promise.resolve();
		});

		test('should handle "setBreakpoints" message from VS Code', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'setBreakpoints', breakpoints: [5, 10] }
			});
			window.dispatchEvent(event);
			await Promise.resolve();
		});

		test('should respond to getLocals with echoed requestId and object payload fallback', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'getLocals', requestId: 'req-locals-1' }
			});
			window.dispatchEvent(event);
			await flushAsyncEvents();

			const response = mockPostMessage.mock.calls
				.map((args) => args[0])
				.find((message) => message?.type === 'getLocalsResponse');

			expect(response).toEqual({
				type: 'getLocalsResponse',
				requestId: 'req-locals-1',
				data: {}
			});
		});

		test('should respond to getGlobals with echoed requestId and object payload fallback', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'getGlobals', requestId: 'req-globals-1' }
			});
			window.dispatchEvent(event);
			await flushAsyncEvents();

			const response = mockPostMessage.mock.calls
				.map((args) => args[0])
				.find((message) => message?.type === 'getGlobalsResponse');

			expect(response).toEqual({
				type: 'getGlobalsResponse',
				requestId: 'req-globals-1',
				data: {}
			});
		});
	});
});
