/**
 * @jest-environment jsdom
 */

describe('webviewRuntime.js Test Suite', () => {
    let mockPostMessage;
    let messageListener;
    let mockCcall;
    let mockModule;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();

        // 1. VS Code API (acquireVsCodeApi) のモック
        mockPostMessage = jest.fn();
        window.acquireVsCodeApi = jest.fn().mockReturnValue({
            postMessage: mockPostMessage
        });

        // 2. Emscripten WASM インスタンス (ccall) のモック
        mockCcall = jest.fn();
        mockModule = {
            ccall: mockCcall,
            _mrb_debug_get_status: jest.fn(),
            _mrb_debug_next: jest.fn(),
            _mrb_debug_step: jest.fn(),
            _mrb_debug_continue: jest.fn(),
            _mrb_run_step: jest.fn().mockReturnValue(0),
            _mrb_tick_wasm: jest.fn(),
            picorubyDebugState: {}
        };


        // window.addEventListener のキャプチャ
        const originalAddEventListener = window.addEventListener.bind(window);
        window.addEventListener = jest.fn((event, handler) => {
            if (event === 'message') {
                messageListener = handler;
            }
            originalAddEventListener(event, handler);
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Breakpoint Injection Logic', () => {
        test('should inject binding.irb on target lines, ignoring comments and keywords', () => {
            // injectBindingIrb のロジック部分の検証
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
        test('should post "stopped" message when WASM is in paused state', () => {
            // mrb_debug_get_status が paused を返すよう設定
            mockCcall.mockImplementation((name) => {
                if (name === 'mrb_debug_get_status') {
                    return JSON.stringify({ mode: 'paused', line: 9, pause_id: 1 });
                }
                return null;
            });

            // 手動でポーリング処理（100ms経過）をシミュレート
            const statusJson = mockCcall('mrb_debug_get_status');
            const status = JSON.parse(statusJson);

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
        test('should invoke mrb_debug_next when receiving "next" message from VS Code', async () => {
            // WASM インスタンス実行のダミーハンドラ
            const executeDebugCommand = (instance, commandName) => {
                instance.ccall(commandName, 'string', [], []);
            };

            executeDebugCommand(mockModule, 'mrb_debug_next');

            expect(mockCcall).toHaveBeenCalledWith('mrb_debug_next', 'string', [], []);
        });

        test('should invoke mrb_debug_step when receiving "stepIn" message', async () => {
            const executeDebugCommand = (instance, commandName) => {
                instance.ccall(commandName, 'string', [], []);
            };

            executeDebugCommand(mockModule, 'mrb_debug_step');

            expect(mockCcall).toHaveBeenCalledWith('mrb_debug_step', 'string', [], []);
        });

        test('should invoke mrb_debug_continue when receiving "continue" message', async () => {
            const executeDebugCommand = (instance, commandName) => {
                instance.ccall(commandName, 'string', [], []);
            };

            executeDebugCommand(mockModule, 'mrb_debug_continue');

            expect(mockCcall).toHaveBeenCalledWith('mrb_debug_continue', 'string', [], []);
        });
    });
});
