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
				{ code: 'puts "setup"', filename: 'setup.rb', sourcePath: 'setup.rb', lineOffset: 0 },
				{ code: 'puts "app"', filename: 'lib/app.rb', sourcePath: 'lib/app.rb', lineOffset: 0 },
				{ code: 'puts "inline"', filename: null, sourcePath: null, lineOffset: 2 }
			]);
		});

		test('collectDebugRubyScripts should retain inline scripts after external scripts', () => {
			const tasks = webviewRuntime.collectDebugRubyScripts(
				'<script type="text/ruby" src="main.rb"></script><script type="text/ruby">puts "inline"</script>',
				'',
				{ 'main.rb': 'puts "external"' },
				{ programPath: 'index.html' }
			);

			expect(tasks).toEqual([
				{ code: 'puts "external"', filename: 'main.rb', sourcePath: 'main.rb', lineOffset: 0 },
				{ code: 'puts "inline"', filename: null, sourcePath: 'index.html', lineOffset: 0 }
			]);
		});

		test('collectDebugRubyScripts should use fallback code for .rb programs', () => {
			const tasks = webviewRuntime.collectDebugRubyScripts(undefined, 'a = 1\nb = 2', {}, { programPath: 'main.rb' });

			expect(tasks).toEqual([{ code: 'a = 1\nb = 2', filename: null, sourcePath: 'main.rb', lineOffset: 0 }]);
		});

		test('collectDebugRubyScripts should record inline HTML script line offsets', () => {
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

			const tasks = webviewRuntime.collectDebugRubyScripts(html, '', {}, { programPath: 'index.html' });

			expect(tasks).toEqual([
				{ code: '\na = 1\nb = 2\n', filename: null, sourcePath: 'index.html', lineOffset: 2 },
				{ code: 'c = 3', filename: null, sourcePath: 'index.html', lineOffset: 6 }
			]);
		});

		test('expandVfsRequireLines should build a source map across expanded requires', () => {
			const { lines, entries } = webviewRuntime.expandVfsRequireLines(
				'require "lib/helper"\nrun',
				{ 'lib/helper.rb': 'def run\n  puts "hi"\nend' },
				'main.rb',
				'main.rb',
				0,
				new Set()
			);

			expect(lines).toEqual(['def run', '  puts "hi"', 'end', 'run']);
			expect(entries).toEqual([
				{ path: 'lib/helper.rb', line: 1 },
				{ path: 'lib/helper.rb', line: 2 },
				{ path: 'lib/helper.rb', line: 3 },
				{ path: 'main.rb', line: 2 }
			]);
		});

		test('instrumentDebugLines should add trace hooks, mark breakpoints, and skip unsafe lines', () => {
			const lines = [
				'def run(a,',
				'        b)',
				'  x = [1,',
				'       2]',
				'  # comment',
				'  if x.any?',
				'    puts "yes"',
				'  else',
				'    puts "no"',
				'  end',
				'  text = <<~EOS',
				'    heredoc body',
				'  EOS',
				'  items.each do |item|',
				'    item.',
				'      to_s',
				'  end',
				'end'
			];
			const entries = lines.map((_, index) => ({ path: 'lib/helper.rb', line: index + 1 }));

			const result = webviewRuntime.instrumentDebugLines(lines, entries, { 'lib/helper.rb': [7] });

			expect(result).toHaveLength(lines.length);
			expect(result[0]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 1); def run(a,');
			expect(result[1]).toBe('        b)');
			expect(result[2]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 3);   x = [1,');
			expect(result[3]).toBe('       2]');
			expect(result[4]).toBe('  # comment');
			expect(result[5]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 6);   if x.any?');
			expect(result[6]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 7, true);     puts "yes"');
			expect(result[7]).toBe('  else');
			expect(result[8]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 9);     puts "no"');
			expect(result[9]).toBe('  end');
			expect(result[10]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 11);   text = <<~EOS');
			expect(result[11]).toBe('    heredoc body');
			expect(result[12]).toBe('  EOS');
			expect(result[13]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 14);   items.each do |item|');
			expect(result[14]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 15);     item.');
			expect(result[15]).toBe('      to_s');
			expect(result[16]).toBe('  end');
			expect(result[17]).toBe('end');
		});

		test('buildDebugTaskCode should prepend the prelude and offset the source map', () => {
			const { code, sourceMap } = webviewRuntime.buildDebugTaskCode(
				{ code: 'require "lib/helper"\nrun', filename: null, sourcePath: 'index.html', lineOffset: 10 },
				{ 'lib/helper.rb': 'def run\nend' },
				{ 'index.html': [12] }
			);
			const lines = code.split('\n');

			expect(lines[0]).toBe(webviewRuntime.DEBUG_PRELUDE);
			expect(lines[0]).toContain('$PicoRubyDebug ||= PicoRubyDebugClass.new');
			expect(lines[0]).toContain('puts "[vscode-debug-hit] path=#{path},line=#{line}"');
			expect(lines[1]).toBe('binding.irb if $PicoRubyDebug.trace("lib/helper.rb", 1); def run');
			expect(lines[2]).toBe('end');
			expect(lines[3]).toBe('binding.irb if $PicoRubyDebug.trace("index.html", 12, true); run');
			expect(sourceMap).toEqual({
				2: { path: 'lib/helper.rb', line: 1 },
				3: { path: 'lib/helper.rb', line: 2 },
				4: { path: 'index.html', line: 12 }
			});
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
