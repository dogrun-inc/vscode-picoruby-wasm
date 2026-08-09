const vscode = typeof acquireVsCodeApi === 'function'
	? acquireVsCodeApi()
	: { postMessage: () => {} };

const IDLE_TIMEOUT_MS = 3000;

/**
 * Converts a console argument into a loggable string.
 *
 * @param {unknown} value Console argument value.
 * @returns {string} Serialized representation used for VS Code forwarding.
 */
const stringifyLogValue = (value) => {
	if (typeof value === 'string') {
		return value;
	}

	try {
		const json = JSON.stringify(value);
		return typeof json === 'string' ? json : String(value);
	} catch {
		return String(value);
	}
};

/**
 * Safely parses JSON strings.
 * 
 * @param {string} text JSON string to parse.
 * @returns {any|null} Parsed object or null if parsing fails.
 */
const safeParseJson = (text) => {
    if (typeof text !== 'string') {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * Forwards a single log line to the extension host.
 *
 * @param {string} text Log text.
 */
const forwardLogMessage = (text) => {
	vscode.postMessage({ type: 'log', text });
};

/**
 * Mirrors console.log output to the VS Code debug console.
 * This keeps browser-side logs and extension-side logs consistent.
 */
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
	originalConsoleLog(...args);
	forwardLogMessage(args.map(stringifyLogValue).join(' '));
};

/**
 * Mirrors console.error output to the VS Code debug console.
 */
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
	originalConsoleError(...args);
	forwardLogMessage(args.map(stringifyLogValue).join(' '));
};

/**
 * Dynamic import wrapper that handles Node/Jest test environment.
 */
const loadPicorubyModule = () => {
	// Jest (Node.js) テスト環境の場合は動的インポートを実行せずダミーを返す
	if (typeof process !== 'undefined' && (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test')) {
		return Promise.resolve({
			default: async () => ({
				ccall: () => {},
				_mrb_debug_get_status: () => null,
				picorubyDebugState: {}
			})
		});
	}

	// ブラウザ (Webview) 環境では相対パスで picoruby.js を動的インポートする
	return import('./picoruby.js');
};

/**
 * Shared module initialization promise.
 * The instance is created once and reused by incoming start requests.
 */
const moduleReady = loadPicorubyModule()
	.then(({ default: createModule }) => createModule({
		print: (text) => console.log(text),
		printErr: (text) => console.error(text)
	}))
	.then((instance) => {
		const runtimeState = {
			isPaused: true,
			breakpoints: [],
			debugPollInterval: null,
			pauseId: null,
			terminatedNotified: false,
			sessionStarted: false,
			lastProgressTime: performance.now()
		};
		instance.picorubyDebugState = runtimeState;

		const injectBindingIrb = (sourceCode, breakpoints) => {
			const normalizedBreakpoints = new Set(
				(Array.isArray(breakpoints) ? breakpoints : [])
					.filter((line) => Number.isInteger(line) && line > 0)
			);
			const lines = sourceCode.split('\n');

			for (let index = 0; index < lines.length; index += 1) {
				const lineNumber = index + 1;
				if (!normalizedBreakpoints.has(lineNumber)) {
					continue;
				}

				const trimmed = lines[index].trimStart();
				if (trimmed.length === 0 || trimmed.startsWith('#')) {
					continue;
				}

				if (/^(?:else|elsif|when|rescue|ensure|end)\b/.test(trimmed)) {
					continue;
				}

				lines[index] = `binding.irb; ${lines[index]}`;
			}

			return lines.join('\n');
		};

		const TERMINAL_MODES = new Set(['terminated', 'finished', 'exited', 'completed', 'done']);

		const notifyStoppedFromStatus = (status) => {
			const currentPauseId = status.pause_id ?? `line:${status.line}`;
			runtimeState.pauseId = currentPauseId;
			runtimeState.isPaused = true;
			runtimeState.lastProgressTime = performance.now();

			const line = Number.isInteger(status?.line) && status.line > 0 ? status.line : undefined;
			vscode.postMessage({ type: 'stopped', reason: 'breakpoint', line });
		};

		const notifyTerminatedOnce = () => {
			if (runtimeState.terminatedNotified) {
				return;
			}

			runtimeState.terminatedNotified = true;
			runtimeState.sessionStarted = false;
			runtimeState.isPaused = true;
			runtimeState.lastProgressTime = performance.now();
			vscode.postMessage({ type: 'terminated' });
		};

		const isTerminalStatus = (status) => {
			const mode = typeof status?.mode === 'string' ? status.mode.toLowerCase() : '';
			return TERMINAL_MODES.has(mode);
		};

		const pollDebugStatus = () => {
			try {
				if (runtimeState.debugPollInterval === null || !runtimeState.sessionStarted) {
					return;
				}

				if (typeof instance.ccall !== 'function' || typeof instance._mrb_debug_get_status === 'undefined') {
					return;
				}

				const jsonStatus = instance.ccall('mrb_debug_get_status', 'string', [], []);
				const status = safeParseJson(jsonStatus);
                if (!status || typeof status !== 'object') {
					return;
				}

				if (isTerminalStatus(status)) {
					notifyTerminatedOnce();
					return;
				}

				if (status.mode !== 'paused') {
					return;
				}

				const currentPauseId = status.pause_id ?? `line:${status.line}`;
				if (currentPauseId === runtimeState.pauseId) {
                    return;
                }

				notifyStoppedFromStatus(status);
			} catch (error) {
				console.error('mrb_debug_get_status polling failed', error);
			}
		};

		const startDebugPolling = () => {
			if (runtimeState.debugPollInterval !== null) {
				return;
			}

			runtimeState.debugPollInterval = setInterval(pollDebugStatus, 200);
		};

		instance.ccall('picorb_init', 'number', [], []);
		instance.picorubyRun = function() {
			const MRB_TICK_UNIT = 4;
			const BATCH_DURATION = 16;
			const IDLE_DELAY = 4;
			const MAX_CATCHUP_TICKS = 10;
			const runStepStatus = instance._mrb_run_step_status || function() {
				const result = instance._mrb_run_step();
				return result < 0 ? -1 : 1;
			};
			const gcSchedulerPending = instance._mrb_gc_scheduler_pending_wasm || function() {
				return 0;
			};

			let lastTick = performance.now();

			/**
			 * Executes one scheduler slice and re-schedules itself.
			 */
			function run() {
				if (runtimeState.isPaused) {
					return;
				}

				const now = performance.now();
				let tickCount = 0;

				while (now - lastTick >= MRB_TICK_UNIT && tickCount < MAX_CATCHUP_TICKS) {
					instance._mrb_tick_wasm();
					lastTick += MRB_TICK_UNIT;
					tickCount += 1;
				}

				if (now - lastTick >= MRB_TICK_UNIT) {
					lastTick = now;
				}

				const sliceStart = performance.now();
				let progressed = false;
				while (performance.now() - sliceStart < BATCH_DURATION) {
					const status = runStepStatus();
					if (status < 0) {
						break;
					}
					if (status === 0) {
						break;
					}
					progressed = true;
				}

				// 進捗がない場合の完走・停止チェック
				if (!progressed && runtimeState.sessionStarted) {
					try {
						if (typeof instance.ccall === 'function' && typeof instance._mrb_debug_get_status !== 'undefined') {
							const jsonStatus = instance.ccall('mrb_debug_get_status', 'string', [], []);
							const status = safeParseJson(jsonStatus);
							
							if (status && typeof status === 'object') {
								// ブレークポイント等で一時停止した場合
								if (status.mode === 'paused') {
									const currentPauseId = status.pause_id ?? `line:${status.line}`;
									if (currentPauseId !== runtimeState.pauseId) {
									notifyStoppedFromStatus(status);
									}
									return;
								}

								// 明確な終了ステータス（terminated 等）の判定
								if (isTerminalStatus(status)) {
									notifyTerminatedOnce();
									return;
								}
							}
						}
					} catch (error) {
						console.error('run-loop status check failed', error);
					}

					// sleep 中（タイマー待機中）は進捗時刻をリセットして待機を継続
					if (gcSchedulerPending() === 1) {
						runtimeState.lastProgressTime = performance.now();
					} else if (performance.now() - runtimeState.lastProgressTime >= IDLE_TIMEOUT_MS) {
						// 実時間で IDLE_TIMEOUT_MS 以上無応答の場合のみ完走とみなす
						notifyTerminatedOnce();
						return;
					}
				} else if (progressed) {
					runtimeState.lastProgressTime = performance.now();
				}

				const delay = progressed ? 0 : IDLE_DELAY;
				setTimeout(run, delay);
			}

			instance.picorubyResume = () => {
				runtimeState.isPaused = false;
				run();
			};

			run();
		};
		instance.picorubyRun();
		startDebugPolling();
		console.log('PicoRuby WASM in WebView Loaded!');
		vscode.postMessage({ type: 'ready' });
		instance.picorubyInjectBreakpoints = injectBindingIrb;
		return instance;
	})
	.catch((error) => {
		console.error('Failed to load PicoRuby WASM in WebView', error);
		throw error;
	});

/**
 * Receives launch requests from the extension host and creates PicoRuby tasks.
 */
window.addEventListener('message', async (event) => {
	const data = event.data;

	const executeDebugCommand = (instance, commandName, exportName) => {
		console.log(`[debugger] received command ${commandName}`);
		if (typeof instance.ccall !== 'function' || typeof instance[exportName] === 'undefined') {
			return;
		}

		try {
			instance.ccall(commandName, 'string', [], []);
		} catch (error) {
			console.log(`${commandName} raised`, error);
		}

		const runtimeState = instance.picorubyDebugState;
		runtimeState.pauseId = null;
		runtimeState.terminatedNotified = false;
		runtimeState.lastProgressTime = performance.now();
		runtimeState.isPaused = false;

		if (typeof instance.picorubyResume === 'function') {
			instance.picorubyResume();
		}
	};

	if (data?.type === 'setBreakpoints') {
		const instance = await moduleReady;
		instance.picorubyDebugState.breakpoints = Array.isArray(data.breakpoints)
			? data.breakpoints.filter((line) => Number.isInteger(line) && line > 0)
			: [];
		return;
	}

	if (data?.type === 'continue') {
		const instance = await moduleReady;
		executeDebugCommand(instance, 'mrb_debug_continue', '_mrb_debug_continue');
		return;
	}

	if (data?.type === 'next') {
		const instance = await moduleReady;
		executeDebugCommand(instance, 'mrb_debug_next', '_mrb_debug_next');
		return;
	}

	if (data?.type === 'stepIn') {
		const instance = await moduleReady;
		executeDebugCommand(instance, 'mrb_debug_step', '_mrb_debug_step');
		return;
	}

	if (data?.type === 'terminate') {
		location.reload();
		return;
	}

	if (data?.type === 'getLocals') {
		const instance = await moduleReady;
		let localsJson = '{}';
		try {
			if (typeof instance.ccall === 'function' && typeof instance._mrb_debug_get_locals !== 'undefined') {
				localsJson = instance.ccall('mrb_debug_get_locals', 'string', [], []);
			}
		} catch (e) {
			console.error('mrb_debug_get_locals failed', e);
		}
		vscode.postMessage({
			type: 'getLocalsResponse',
			requestId: data.requestId,
			data: safeParseJson(localsJson) || {}
		});
		return;
	}

	if (data?.type === 'getGlobals') {
		const instance = await moduleReady;
		let globalsJson = '{}';
		try {
			if (typeof instance.ccall === 'function' && typeof instance._mrb_get_globals_json !== 'undefined') {
				globalsJson = instance.ccall('mrb_get_globals_json', 'string', [], []);
			}
		} catch (e) {
			console.error('mrb_get_globals_json failed', e);
		}
		vscode.postMessage({
			type: 'getGlobalsResponse',
			requestId: data.requestId,
			data: safeParseJson(globalsJson) || {}
		});
		return;
	}

	if (data?.type !== 'start') {
		return;
	}

	console.log('[debugger] webview message type=start');

	const instance = await moduleReady;
	const receivedCode = typeof data.code === 'string' ? data.code : String(data.code ?? '');
	const runtimeBreakpoints = Array.isArray(data.breakpoints)
		? data.breakpoints.filter((line) => Number.isInteger(line) && line > 0)
		: instance.picorubyDebugState.breakpoints;

	instance.picorubyDebugState.pauseId = null;
	instance.picorubyDebugState.terminatedNotified = false;
	instance.picorubyDebugState.sessionStarted = false;
	instance.picorubyDebugState.lastProgressTime = performance.now();
	instance.picorubyDebugState.breakpoints = runtimeBreakpoints;

	const patchedCode = typeof instance.picorubyInjectBreakpoints === 'function'
		? instance.picorubyInjectBreakpoints(receivedCode, runtimeBreakpoints)
		: receivedCode;

	console.log('Received start command from VS Code.');
	console.log(patchedCode);
	try {
		instance.ccall('picorb_create_task', 'number', ['string'], [patchedCode]);
		instance.picorubyDebugState.sessionStarted = true;
		if (typeof instance.picorubyResume === 'function') {
			instance.picorubyResume();
		}
	} catch (error) {
		instance.picorubyDebugState.sessionStarted = false;
		console.error('Failed to evaluate Ruby code in PicoRuby WASM', error);
	}
});

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		stringifyLogValue,
		safeParseJson
	};
}
