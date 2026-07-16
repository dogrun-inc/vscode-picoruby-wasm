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
			hasSentStopped: false
		};
		instance.picorubyDebugState = runtimeState;

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
		console.log('PicoRuby WASM in WebView Loaded!');
		vscode.postMessage({ type: 'ready' });
		if (!runtimeState.hasSentStopped) {
			runtimeState.hasSentStopped = true;
			vscode.postMessage({ type: 'stopped' });
		}
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
	if (data?.type === 'continue') {
		const instance = await moduleReady;
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
	console.log('Received start command from VS Code.');
	console.log(receivedCode);
	try {
		instance.ccall('picorb_create_task', 'number', ['string'], [receivedCode]);
	} catch (error) {
		console.error('Failed to evaluate Ruby code in PicoRuby WASM', error);
	}
});
