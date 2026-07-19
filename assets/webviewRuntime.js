const vscode = acquireVsCodeApi();

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
 * Resolves the PicoRuby ESM bundle relative to this runtime module.
 */
const picorubyScriptUri = new URL('./picoruby.js', import.meta.url).toString();

/**
 * Shared module initialization promise.
 * The instance is created once and reused by incoming start requests.
 */
const moduleReady = import(picorubyScriptUri)
	.then(({ default: createModule }) => createModule({
		print: (text) => console.log(text),
		printErr: (text) => console.error(text)
	}))
	.then((instance) => {
		const runtimeState = {
			isPaused: true,
			breakpoints: [],
			debugPollInterval: null,
			lastReportedPauseKey: null
		};
		instance.picorubyDebugState = runtimeState;

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

				lines[index] = `binding.irb; ${lines[index]}`;
			}

			return lines.join('\n');
		};

		const pollDebugStatus = () => {
			try {
				if (runtimeState.debugPollInterval === null) {
					return;
				}

				if (typeof instance.ccall !== 'function' || typeof instance._mrb_debug_get_status === 'undefined') {
					return;
				}

				const jsonStatus = instance.ccall('mrb_debug_get_status', 'string', [], []);
				const status = safeParseJson(jsonStatus);
				if (!status || typeof status !== 'object' || status.mode !== 'paused') {
					return;
				}

				const line = Number.isInteger(status.line) && status.line > 0 ? status.line : undefined;
				const pauseKey = Number.isInteger(status.pause_id)
					? `pause:${status.pause_id}`
					: `line:${line ?? 'unknown'}`;
				if (pauseKey === runtimeState.lastReportedPauseKey) {
					return;
				}

				runtimeState.lastReportedPauseKey = pauseKey;
				runtimeState.isPaused = true;
				vscode.postMessage({ type: 'stopped', reason: 'breakpoint', line });
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

		/**
		 * Initializes PicoRuby and starts a cooperative scheduler loop.
		 * The loop keeps running in idle mode and immediately processes queued tasks.
		 */
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
						console.error('mrb_run_step_status returned', status, '- scheduler continues');
						break;
					}
					if (status === 0) {
						break;
					}
					progressed = true;
				}

				const delay = progressed || gcSchedulerPending() === 1 ? 0 : IDLE_DELAY;
				setTimeout(run, delay);
			}

			instance.picorubyResume = () => {
				if (!runtimeState.isPaused) {
					return;
				}

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
	if (data?.type === 'setBreakpoints') {
		const instance = await moduleReady;
		instance.picorubyDebugState.breakpoints = Array.isArray(data.breakpoints)
			? data.breakpoints.filter((line) => Number.isInteger(line) && line > 0)
			: [];
		return;
	}

	if (data?.type === 'continue') {
		const instance = await moduleReady;
		if (typeof instance.ccall === 'function' && typeof instance._mrb_debug_continue !== 'undefined') {
			try {
				instance.ccall('mrb_debug_continue', 'string', [], []);
			} catch (error) {
				console.error('mrb_debug_continue failed', error);
			}
		}

		instance.picorubyDebugState.lastReportedPauseKey = null;
		if (typeof instance.picorubyResume === 'function') {
			instance.picorubyResume();
		}
		return;
	}

	if (data?.type !== 'start') {
		return;
	}

	const instance = await moduleReady;
	const receivedCode = typeof data.code === 'string' ? data.code : String(data.code ?? '');
	const runtimeBreakpoints = Array.isArray(data.breakpoints)
		? data.breakpoints.filter((line) => Number.isInteger(line) && line > 0)
		: instance.picorubyDebugState.breakpoints;
	instance.picorubyDebugState.breakpoints = runtimeBreakpoints;
	const patchedCode = typeof instance.picorubyInjectBreakpoints === 'function'
		? instance.picorubyInjectBreakpoints(receivedCode, runtimeBreakpoints)
		: receivedCode;
	console.log('Received start command from VS Code.');
	console.log(patchedCode);
	try {
		instance.ccall('picorb_create_task', 'number', ['string'], [patchedCode]);
		if (typeof instance.picorubyResume === 'function') {
			instance.picorubyResume();
		}
	} catch (error) {
		console.error('Failed to evaluate Ruby code in PicoRuby WASM', error);
	}
});
