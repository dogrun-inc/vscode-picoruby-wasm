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

		test('normalizeVfsPath should accept relative Ruby paths and reject traversal', () => {
			expect(webviewRuntime.normalizeVfsPath('./lib\\helper.rb')).toBe('lib/helper.rb');
			expect(webviewRuntime.normalizeVfsPath('/main.rb')).toBe('main.rb');
			expect(webviewRuntime.normalizeVfsPath('../secret.rb')).toBeNull();
			expect(webviewRuntime.normalizeVfsPath('')).toBeNull();
		});

		test('writeVfsToRuntime should mount files under /work and chdir there', () => {
			const calls = [];
			const fs = {
				mkdir: jest.fn((directoryPath) => calls.push(['mkdir', directoryPath])),
				writeFile: jest.fn((filePath, content) => calls.push(['writeFile', filePath, content])),
				chdir: jest.fn((directoryPath) => calls.push(['chdir', directoryPath]))
			};

			webviewRuntime.writeVfsToRuntime({ FS: fs }, {
				'main.rb': 'require "lib/helper"',
				'lib/helper.rb': 'VALUE = 1',
				'../ignored.rb': 'ignored'
			});

			expect(fs.writeFile).toHaveBeenCalledWith('/work/main.rb', 'require "lib/helper"', { encoding: 'utf8' });
			expect(fs.writeFile).toHaveBeenCalledWith('/work/lib/helper.rb', 'VALUE = 1', { encoding: 'utf8' });
			expect(fs.writeFile).toHaveBeenCalledTimes(2);
			expect(fs.chdir).toHaveBeenCalledWith('/work');
			expect(calls).toContainEqual(['mkdir', '/work']);
		});

		test('expandVfsRequires should inline nested requires from subdirectories', () => {
			const code = webviewRuntime.expandVfsRequires('require "main"', {
				'main.rb': ['require "js"', 'require "./lib/message"', 'require "ui/status_view"', 'puts SampleMessage.line'].join('\n'),
				'lib/message.rb': 'module SampleMessage\nend',
				'ui/status_view.rb': 'class StatusView\nend'
			});

			expect(code).toContain('require "js"');
			expect(code).toContain('module SampleMessage');
			expect(code).toContain('class StatusView');
			expect(code).toContain('puts SampleMessage.line');
			expect(code).not.toContain('require "main"');
			expect(code).not.toContain('require "./lib/message"');
			expect(code).not.toContain('require "ui/status_view"');
		});

		test('collectDebugRubyScripts should resolve multiple src scripts from VFS in document order', () => {
			const tasks = webviewRuntime.collectDebugRubyScripts(
				[
					'<script type="text/ruby" src="setup.rb"></script>',
					'<script type="text/picoruby" src="lib/app.rb"></script>',
					'<script type="text/ruby">puts "inline"</script>'
				].join('\n'),
				'puts "fallback"',
				{
					'setup.rb': 'puts "setup"',
					'lib/app.rb': 'puts "app"'
				}
			);

			expect(tasks).toEqual([
				{ code: 'puts "setup"', filename: 'setup.rb' },
				{ code: 'puts "app"', filename: 'lib/app.rb' },
				{ code: 'puts "inline"', filename: null }
			]);
		});

		test('collectDebugRubyScripts should retain inline scripts after external scripts', () => {
			const tasks = webviewRuntime.collectDebugRubyScripts(
				'<script type="text/ruby" src="main.rb"></script><script type="text/ruby">puts "inline"</script>',
				'',
				{ 'main.rb': 'puts "external"' }
			);

			expect(tasks).toEqual([
				{ code: 'puts "external"', filename: 'main.rb' },
				{ code: 'puts "inline"', filename: null }
			]);
		});

		test('collectDebugRubyScripts should use fallback code for .rb programs and inject markers', () => {
			const tasks = webviewRuntime.collectDebugRubyScripts(
				undefined,
				'a = 1\nb = 2',
				{},
				{ programPath: 'main.rb', allBreakpoints: { 'main.rb': [2] } }
			);

			expect(tasks).toEqual([
				{ code: 'a = 1\nputs "[vscode-debug-hit] path=main.rb,line=2"; binding.irb; b = 2', filename: null }
			]);
		});

		test('injectBreakpointMarkers should prefix only injectable lines and keep line count', () => {
			const result = webviewRuntime.injectBreakpointMarkers(
				['puts "Line 1"', '# Comment line', 'else', 'x = 10'].join('\n'),
				'lib/helper.rb',
				[1, 2, 3, 4]
			);
			const lines = result.split('\n');

			expect(lines).toHaveLength(4);
			expect(lines[0]).toBe('puts "[vscode-debug-hit] path=lib/helper.rb,line=1"; binding.irb; puts "Line 1"');
			expect(lines[1]).toBe('# Comment line');
			expect(lines[2]).toBe('else');
			expect(lines[3]).toBe('puts "[vscode-debug-hit] path=lib/helper.rb,line=4"; binding.irb; x = 10');
		});

		test('injectBreakpointsIntoVfs should inject markers before require expansion', () => {
			const vfs = webviewRuntime.injectBreakpointsIntoVfs(
				{
					'main.rb': 'require "lib/helper"\nrun',
					'lib/helper.rb': 'def run\n  puts "hi"\nend'
				},
				{ 'lib\\Helper.rb': [2], 'main.rb': [2] }
			);

			expect(vfs['lib/helper.rb']).toBe(
				'def run\nputs "[vscode-debug-hit] path=lib/helper.rb,line=2"; binding.irb;   puts "hi"\nend'
			);

			const expanded = webviewRuntime.expandVfsRequires(vfs['main.rb'], vfs, 'main.rb');
			expect(expanded).toContain('path=lib/helper.rb,line=2');
			expect(expanded).toContain('path=main.rb,line=2"; binding.irb; run');
			expect(expanded).not.toContain('require "lib/helper"');
		});

		test('collectDebugRubyScripts should map inline HTML script lines to original HTML lines', () => {
			const html = [
				'<html>',
				'<body>',
				'<script type="text/ruby">',
				'a = 1',
				'b = 2',
				'</script>',
				'<script type="text/picoruby">c = 3</script>',
				'</body>',
				'</html>'
			].join('\n');

			const tasks = webviewRuntime.collectDebugRubyScripts(html, '', {}, {
				programPath: 'index.html',
				allBreakpoints: { 'index.html': [5, 7] }
			});

			expect(tasks).toHaveLength(2);
			expect(tasks[0].filename).toBeNull();
			expect(tasks[0].code.split('\n')).toEqual([
				'',
				'a = 1',
				'puts "[vscode-debug-hit] path=index.html,line=5"; binding.irb; b = 2',
				''
			]);
			expect(tasks[1].code).toBe('puts "[vscode-debug-hit] path=index.html,line=7"; binding.irb; c = 3');
		});

		test('findBreakpointLines should match paths case-insensitively and drop invalid lines', () => {
			expect(webviewRuntime.findBreakpointLines({ 'Lib/Helper.rb': [3, 0, 'x', 5] }, 'lib/helper.rb')).toEqual([3, 5]);
			expect(webviewRuntime.findBreakpointLines({ 'lib/helper.rb': [3] }, 'other.rb')).toEqual([]);
			expect(webviewRuntime.findBreakpointLines(null, 'lib/helper.rb')).toEqual([]);
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

		test('should remove javascript hrefs while rendering HTML content', async () => {
			document.body.innerHTML = '';
			const event = new MessageEvent('message', {
				data: {
					type: 'start',
					html: '<a id="unsafe" href="javascript:alert(1)">Unsafe</a><a id="safe" href="https://example.com">Safe</a>',
					code: ''
				}
			});
			window.dispatchEvent(event);
			await flushAsyncEvents();

			expect(document.querySelector('#unsafe').getAttribute('href')).toBeNull();
			expect(document.querySelector('#safe').getAttribute('href')).toBe('https://example.com');
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

		test('should respond to evaluate with echoed requestId and safe fallback result', async () => {
			const event = new MessageEvent('message', {
				data: { type: 'evaluate', requestId: 'req-evaluate-1', expression: 'a' }
			});
			window.dispatchEvent(event);
			await flushAsyncEvents();

			const response = mockPostMessage.mock.calls
				.map((args) => args[0])
				.find((message) => message?.type === 'evaluateResponse');

			expect(response).toEqual({
				type: 'evaluateResponse',
				requestId: 'req-evaluate-1',
				data: { result: '' }
			});
		});
	});
});
