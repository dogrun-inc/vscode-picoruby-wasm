const vscode = typeof acquireVsCodeApi === 'function'
	? acquireVsCodeApi()
	: { postMessage: () => {} };

const IDLE_TIMEOUT_MS = 10000;

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
 * Converts runtime variable values into display-safe strings.
 *
 * @param {unknown} value Runtime value.
 * @returns {string} String representation for evaluate responses.
 */
const toEvaluationResultString = (value) => {
	if (typeof value === 'string') {
		return value;
	}

	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}

	try {
		const json = JSON.stringify(value);
		return typeof json === 'string' ? json : '';
	} catch {
		return '';
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
				_mrb_tick_wasm: () => {},
				_mrb_run_step: () => 0,
				_mrb_debug_get_status: () => null,
				FS: null,
				picorubyDebugState: {}
			})
		});
	}

	// ブラウザ (Webview) 環境では相対パスで picoruby.js を動的インポートする
	return import('./picoruby.js');
};

/**
 * Normalizes a collected VFS key and rejects paths that escape the VFS root.
 * @param {unknown} relativePath Relative path received from the extension host.
 * @returns {string|null} Safe POSIX-style path, or null for invalid input.
 */
const normalizeVfsPath = (relativePath) => {
	if (typeof relativePath !== 'string') {
		return null;
	}

	const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
	const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
	if (segments.length === 0 || segments.includes('..')) {
		return null;
	}

	return segments.join('/');
};

/**
 * Creates all directory components needed for a path in Emscripten FS.
 * @param {object} fs Emscripten filesystem API.
 * @param {string} directoryPath Absolute virtual directory path.
 */
const ensureVfsDirectory = (fs, directoryPath) => {
	const segments = directoryPath.split('/').filter(Boolean);
	let currentPath = '';

	for (const segment of segments) {
		currentPath += `/${segment}`;
		try {
			fs.mkdir(currentPath);
		} catch {
			// Existing directories are fine.
		}
	}
};

/**
 * Writes collected Ruby files into the runtime VFS under /work.
 * @param {object} instance Initialized or initializing PicoRuby module.
 * @param {object} vfs Map of normalized relative paths to Ruby source text.
 */
const writeVfsToRuntime = (instance, vfs) => {
	if (!vfs || typeof vfs !== 'object') {
		return;
	}

	const fs = instance?.FS;
	if (!fs || typeof fs.writeFile !== 'function') {
		console.log('[vfs] runtime FS is not available; skipped Ruby file mount');
		return;
	}

	ensureVfsDirectory(fs, '/work');

	let count = 0;
	for (const [rawPath, content] of Object.entries(vfs)) {
		const relativePath = normalizeVfsPath(rawPath);
		if (!relativePath || typeof content !== 'string') {
			continue;
		}

		const pathSegments = relativePath.split('/');
		const fileName = pathSegments.pop();
		if (!fileName) {
			continue;
		}

		const directoryPath = `/work/${pathSegments.join('/')}`.replace(/\/$/, '');
		ensureVfsDirectory(fs, directoryPath);
		fs.writeFile(`${directoryPath}/${fileName}`, content, { encoding: 'utf8' });
		count += 1;
	}

	if (typeof fs.chdir === 'function') {
		fs.chdir('/work');
	}

	console.log(`[vfs] mounted ${count} Ruby file(s) under /work`);
};

/**
 * Normalizes a require target while resolving dot segments safely.
 * @param {string} value VFS-relative path to normalize.
 * @returns {string|null} Normalized path, or null when traversal escapes the root.
 */
const normalizeResolvedVfsPath = (value) => {
	const segments = [];
	for (const segment of value.replace(/\\/g, '/').split('/')) {
		if (segment.length === 0 || segment === '.') {
			continue;
		}

		if (segment === '..') {
			if (segments.length === 0) {
				return null;
			}
			segments.pop();
			continue;
		}

		segments.push(segment);
	}

	return segments.length > 0 ? segments.join('/') : null;
};

/**
 * Returns the directory portion of a normalized VFS path.
 * @param {string} filePath VFS-relative file path.
 * @returns {string} Parent directory, or an empty string for a root-level file.
 */
const dirnameVfsPath = (filePath) => {
	const slashIndex = filePath.lastIndexOf('/');
	return slashIndex >= 0 ? filePath.slice(0, slashIndex) : '';
};

/**
 * Resolves a Ruby require request against collected VFS entries.
 * @param {unknown} request Require name from Ruby source.
 * @param {string} importerPath VFS path of the source containing the require.
 * @param {object} vfs Map of VFS paths to source text.
 * @returns {string|null} Matching VFS path, or null for runtime/bad requests.
 */
const resolveVfsRequirePath = (request, importerPath, vfs) => {
	if (!vfs || typeof vfs !== 'object' || typeof request !== 'string' || request === 'js') {
		return null;
	}

	const basePath = request.startsWith('./') || request.startsWith('../')
		? normalizeResolvedVfsPath(`${dirnameVfsPath(importerPath)}/${request}`)
		: normalizeResolvedVfsPath(request);

	if (!basePath) {
		return null;
	}

	for (const candidate of [basePath, `${basePath}.rb`, `${basePath}/index.rb`]) {
		if (typeof vfs[candidate] === 'string') {
			return candidate;
		}
	}

	return null;
};

/**
 * Resolves a Ruby script src attribute against collected VFS entries.
 * @param {unknown} request Script src attribute value.
 * @param {object} vfs Map of VFS paths to source text.
 * @returns {string|null} Matching VFS path, or null when no entry exists.
 */
const resolveVfsScriptPath = (request, vfs) => {
	if (typeof request !== 'string') {
		return null;
	}

	return resolveVfsRequirePath(request.split(/[?#]/, 1)[0], '__entrypoint__.rb', vfs);
};

/**
 * Prefix of the stdout line emitted right before an injected binding.irb pauses execution.
 * The extension host intercepts this line to map the stop back to the original file/line.
 */
const DEBUG_HIT_MARKER = '[vscode-debug-hit]';

/**
 * Returns whether a source line can safely receive a breakpoint prefix.
 * Mirrors isInjectableBreakpointLine in src/debug/session.ts.
 * @param {unknown} sourceLine Raw source line.
 * @returns {boolean} false for comments, blank lines, and continuation keywords.
 */
const isInjectableBreakpointLine = (sourceLine) => {
	if (typeof sourceLine !== 'string') {
		return false;
	}

	const trimmed = sourceLine.trimStart();
	if (trimmed.length === 0 || trimmed.startsWith('#')) {
		return false;
	}

	return !/^(?:else|elsif|when|rescue|ensure|end)\b/.test(trimmed);
};

/**
 * Looks up breakpoint lines for a source path, ignoring separator and case differences.
 * @param {unknown} allBreakpoints Map of VFS-relative paths to 1-based line numbers.
 * @param {unknown} sourcePath VFS-relative source path.
 * @returns {number[]} Valid breakpoint lines, or an empty array.
 */
const findBreakpointLines = (allBreakpoints, sourcePath) => {
	if (!allBreakpoints || typeof allBreakpoints !== 'object' || typeof sourcePath !== 'string') {
		return [];
	}

	const wanted = sourcePath.toLowerCase();
	for (const [rawPath, lines] of Object.entries(allBreakpoints)) {
		const normalized = normalizeVfsPath(rawPath);
		if (normalized && normalized.toLowerCase() === wanted && Array.isArray(lines)) {
			return lines.filter((line) => Number.isInteger(line) && line > 0);
		}
	}

	return [];
};

/**
 * Builds the Ruby statement that reports the original location and then pauses.
 * @param {string} sourcePath Path reported in the marker.
 * @param {number} line 1-based line reported in the marker.
 * @returns {string} Semicolon-terminated Ruby statement.
 */
const createBreakpointStatement = (sourcePath, line) => {
	const escapedPath = sourcePath.replace(/[\\"#]/g, '\\$&');
	return `puts "${DEBUG_HIT_MARKER} path=${escapedPath},line=${line}"; binding.irb;`;
};

/**
 * Prefixes breakpoint lines with a location marker and binding.irb.
 * The prefix stays on the same line so the expanded script keeps its line count.
 * @param {string} code Ruby source text.
 * @param {string} sourcePath Path reported in the marker.
 * @param {number[]} lines 1-based line numbers in the original document.
 * @param {number} lineOffset Original document line of code line 1, minus 1.
 * @returns {string} Ruby source with markers injected.
 */
const injectBreakpointMarkers = (code, sourcePath, lines, lineOffset = 0) => {
	if (typeof code !== 'string' || !Array.isArray(lines) || lines.length === 0) {
		return code;
	}

	const targets = new Set(lines);
	return code.split('\n').map((line, index) => {
		const originalLine = index + 1 + lineOffset;
		if (!targets.has(originalLine) || !isInjectableBreakpointLine(line)) {
			return line;
		}

		return `${createBreakpointStatement(sourcePath, originalLine)} ${line}`;
	}).join('\n');
};

/**
 * Injects breakpoint markers into every VFS entry before require expansion.
 * @param {object} vfs Map of VFS paths to source text.
 * @param {object} allBreakpoints Map of VFS-relative paths to 1-based line numbers.
 * @returns {object} New VFS map with markers injected.
 */
const injectBreakpointsIntoVfs = (vfs, allBreakpoints) => {
	if (!vfs || typeof vfs !== 'object') {
		return vfs;
	}

	const result = {};
	for (const [rawPath, content] of Object.entries(vfs)) {
		const vfsPath = normalizeVfsPath(rawPath) ?? rawPath;
		result[rawPath] = injectBreakpointMarkers(content, vfsPath, findBreakpointLines(allBreakpoints, vfsPath));
	}

	return result;
};

/**
 * Recursively expands local require statements before Ruby task creation.
 * @param {string} code Ruby source to expand.
 * @param {object} vfs Map of VFS paths to source text.
 * @param {string} importerPath VFS path of the current source.
 * @param {Set<string>} loadedPaths Paths already expanded in this task.
 * @returns {string} Ruby source with resolvable local requires inlined.
 */
const expandVfsRequires = (code, vfs, importerPath = '__entrypoint__.rb', loadedPaths = new Set()) => {
	if (!vfs || typeof vfs !== 'object') {
		return code;
	}

	return code.split('\n').map((line) => {
		const match = line.match(/^\s*require\s+['"]([^'"]+)['"]\s*(?:#.*)?$/);
		if (!match) {
			return line;
		}

		const resolvedPath = resolveVfsRequirePath(match[1], importerPath, vfs);
		if (!resolvedPath) {
			return line;
		}

		if (loadedPaths.has(resolvedPath)) {
			return '';
		}

		loadedPaths.add(resolvedPath);
		console.log(`[vfs] expanded require '${match[1]}' from ${resolvedPath}`);
		return expandVfsRequires(vfs[resolvedPath], vfs, resolvedPath, loadedPaths);
	}).join('\n');
};

/** Matches `<script ...>...</script>` pairs; group 1 is the attribute text, group 2 the content. */
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/** Matches a Ruby script type attribute inside a script tag's attribute text. */
const RUBY_SCRIPT_TYPE_PATTERN = /\btype\s*=\s*["']?(?:text\/ruby|text\/picoruby)\b/i;
/** Matches a src attribute inside a script tag's attribute text (quoted or bare). */
const SCRIPT_SRC_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Collects all Ruby script tags from the debug HTML and resolves local src files from VFS.
 * Inline scripts receive breakpoint markers using their original HTML line numbers, so the
 * raw HTML (not a CSS-inlined copy) must be passed for accurate mapping.
 * @param {unknown} html Debug HTML sent by the extension host.
 * @param {string} fallbackCode Program source used when no HTML is available (.rb programs).
 * @param {object} vfs Map of VFS paths to source text (already marker-injected).
 * @param {{ programPath?: string|null, allBreakpoints?: object }} debugOptions Marker injection settings.
 * @returns {Array<{ code: string, filename: string | null }>} Ruby task sources in document order.
 */
const collectDebugRubyScripts = (html, fallbackCode, vfs, debugOptions = {}) => {
	const programPath = typeof debugOptions.programPath === 'string' ? debugOptions.programPath : null;
	const programBreakpoints = programPath ? findBreakpointLines(debugOptions.allBreakpoints, programPath) : [];
	const injectProgramMarkers = (code, lineOffset) =>
		programPath ? injectBreakpointMarkers(code, programPath, programBreakpoints, lineOffset) : code;

	if (typeof html !== 'string') {
		return fallbackCode.length > 0 ? [{ code: injectProgramMarkers(fallbackCode, 0), filename: null }] : [];
	}

	const tasks = [];
	const pattern = new RegExp(SCRIPT_TAG_PATTERN.source, 'gi');
	let match;
	while ((match = pattern.exec(html)) !== null) {
		const [, attributes, content] = match;
		if (!RUBY_SCRIPT_TYPE_PATTERN.test(attributes)) {
			continue;
		}

		const srcMatch = SCRIPT_SRC_PATTERN.exec(attributes);
		if (srcMatch) {
			const vfsPath = resolveVfsScriptPath(srcMatch[1] ?? srcMatch[2] ?? srcMatch[3], vfs);
			if (vfsPath) {
				tasks.push({ code: vfs[vfsPath], filename: vfsPath });
			}
			continue;
		}

		if (content.trim().length === 0) {
			continue;
		}

		// Content starts right after `<script` + attributes + `>`.
		const contentStartIndex = match.index + '<script'.length + attributes.length + 1;
		const lineOffset = (html.slice(0, contentStartIndex).match(/\n/g) || []).length;
		tasks.push({ code: injectProgramMarkers(content, lineOffset), filename: null });
	}

	return tasks;
};

/**
 * Initializes PicoRuby once, mounting VFS files before WASI setup.
 * @param {object} instance PicoRuby module instance.
 * @param {object} vfs Map of collected Ruby files.
 */
const ensurePicorubyInitialized = (instance, vfs) => {
	if (instance.picorubyInitialized) {
		return;
	}

	writeVfsToRuntime(instance, vfs);
	instance.ccall('picorb_init', 'number', [], []);
	instance.picorubyInitialized = true;
	instance.picorubyRun();
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

		const stopDebugPolling = () => {
			if (runtimeState.debugPollInterval !== null) {
				clearInterval(runtimeState.debugPollInterval);
				runtimeState.debugPollInterval = null;
			}
		};
		instance.startDebugPolling = startDebugPolling;
		instance.stopDebugPolling = stopDebugPolling;

		instance.picorubyRun = function() {
			const MRB_TICK_UNIT = 4;
			const BATCH_DURATION = 16;
			stopDebugPolling();
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
				if (!runtimeState.sessionStarted) {
					return;
				}

				runtimeState.isPaused = false;
				run();
			};

			run();
		};
		console.log('PicoRuby WASM in WebView Loaded!');
		vscode.postMessage({ type: 'ready' });
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

	if (data?.type === 'evaluate') {
		const instance = await moduleReady;
		const expression = typeof data.expression === 'string' ? data.expression.trim() : '';
		let result = '';

		if (expression.length > 0) {
			let localsData = {};
			let globalsData = {};
			let foundInLocals = false;

			try {
				if (typeof instance.ccall === 'function' && typeof instance._mrb_debug_get_locals !== 'undefined') {
					const localsJson = instance.ccall('mrb_debug_get_locals', 'string', [], []);
					localsData = safeParseJson(localsJson) || {};
				}
			} catch (error) {
				console.error('mrb_debug_get_locals failed during evaluate', error);
			}

			if (
				typeof localsData === 'object' &&
				localsData !== null &&
				Object.prototype.hasOwnProperty.call(localsData, expression)
			) {
				result = toEvaluationResultString(localsData[expression]);
				foundInLocals = true;
			}

			if (!foundInLocals) {
				try {
					if (typeof instance.ccall === 'function' && typeof instance._mrb_get_globals_json !== 'undefined') {
						const globalsJson = instance.ccall('mrb_get_globals_json', 'string', [], []);
						globalsData = safeParseJson(globalsJson) || {};
					}
				} catch (error) {
					console.error('mrb_get_globals_json failed during evaluate', error);
				}
			}

			if (
				!foundInLocals &&
				typeof globalsData === 'object' &&
				globalsData !== null &&
				Object.prototype.hasOwnProperty.call(globalsData, expression)
			) {
				result = toEvaluationResultString(globalsData[expression]);
			} else if (
				!foundInLocals &&
				typeof globalsData === 'object' &&
				globalsData !== null &&
				Object.prototype.hasOwnProperty.call(globalsData, `$${expression}`)
			) {
				result = toEvaluationResultString(globalsData[`$${expression}`]);
			} else if (!foundInLocals && typeof instance.ccall === 'function') {
				const nativeEvaluateCandidates = [
					{ command: 'mrb_debug_eval', exportName: '_mrb_debug_eval' },
					{ command: 'mrb_debug_evaluate', exportName: '_mrb_debug_evaluate' }
				];

				for (const candidate of nativeEvaluateCandidates) {
					if (typeof instance[candidate.exportName] === 'undefined') {
						continue;
					}

					try {
						const nativeResult = instance.ccall(candidate.command, 'string', ['string'], [expression]);
						result = toEvaluationResultString(nativeResult);
						break;
					} catch (error) {
						console.error(`${candidate.command} failed during evaluate`, error);
					}
				}
			}
		}

		vscode.postMessage({
			type: 'evaluateResponse',
			requestId: data.requestId,
			data: { result }
		});
		return;
	}

	if (data?.type !== 'start') {
		return;
	}

	console.log('[debugger] webview message type=start');

	if (data.html) {
        try {
            console.log('[debugger] Rendering HTML DOM with styles...');
            const parser = new DOMParser();
            const doc = parser.parseFromString(data.html, 'text/html');

            // <script type="text/ruby"> タグをカット
            const rubyScripts = doc.querySelectorAll('script[type="text/ruby"], script[type="text/picoruby"]');
            rubyScripts.forEach((script) => script.remove());

			doc.querySelectorAll('[href]').forEach((element) => {
				if (/^\s*javascript\s*:/i.test(element.getAttribute('href') || '')) {
					element.removeAttribute('href');
				}
			});

            // 以前追加されたインラインスタイルがあればクリア（再実行時の重複防止）
            document.querySelectorAll('style[data-runtime-injected="true"]').forEach((s) => s.remove());

            // HTML内のすべての <style> タグ（<head>・<body>問わず）の内容をアクティブな document.head へ確実に注入
            const styleElements = doc.querySelectorAll('style');
            styleElements.forEach((styleTag) => {
                const newStyle = document.createElement('style');
                newStyle.setAttribute('data-runtime-injected', 'true');
                newStyle.textContent = styleTag.textContent;
                document.head.appendChild(newStyle);
            });

            // body 内の HTML 要素を Webview 画面に描画
            document.body.innerHTML = doc.body.innerHTML;
        } catch (e) {
            console.error('Failed to render HTML content', e);
        }
    }

	const instance = await moduleReady;
	const allBreakpoints = data.allBreakpoints && typeof data.allBreakpoints === 'object' ? data.allBreakpoints : {};
	const programPath = typeof data.programPath === 'string' ? data.programPath : null;
	// Inject markers into each VFS file before any require expansion so original lines are preserved.
	const debugVfs = injectBreakpointsIntoVfs(data.vfs, allBreakpoints);
	ensurePicorubyInitialized(instance, debugVfs);
	const receivedCode = typeof data.code === 'string' ? data.code : String(data.code ?? '');
	const rubyTasks = collectDebugRubyScripts(
		typeof data.sourceHtml === 'string' ? data.sourceHtml : data.html,
		receivedCode,
		debugVfs,
		{ programPath, allBreakpoints }
	);
	const runtimeBreakpoints = Array.isArray(data.breakpoints)
		? data.breakpoints.filter((line) => Number.isInteger(line) && line > 0)
		: instance.picorubyDebugState.breakpoints;

	instance.picorubyDebugState.pauseId = null;
	instance.picorubyDebugState.terminatedNotified = false;
	instance.picorubyDebugState.sessionStarted = false;
	instance.picorubyDebugState.lastProgressTime = performance.now();
	instance.picorubyDebugState.breakpoints = runtimeBreakpoints;

	console.log('Received start command from VS Code.');
	console.log(`[debugger] creating ${rubyTasks.length} Ruby task(s)`);
	try {
		for (const task of rubyTasks) {
			console.log(`[debugger] creating Ruby task${task.filename ? ` from ${task.filename}` : ''}`);
			const code = expandVfsRequires(task.code, debugVfs, task.filename || '__entrypoint__.rb');
			if (task.filename) {
				if (typeof instance._picorb_create_task_with_filename === 'undefined') {
					throw new Error('picorb_create_task_with_filename is not exported by PicoRuby WASM');
				}

				instance.ccall('picorb_create_task_with_filename', 'number', ['string', 'string'], [code, task.filename]);
			} else {
				instance.ccall('picorb_create_task', 'number', ['string'], [code]);
			}
		}
		instance.picorubyDebugState.sessionStarted = rubyTasks.length > 0;
			if (instance.picorubyDebugState.sessionStarted) {
				instance.startDebugPolling();
			}
			if (instance.picorubyDebugState.sessionStarted && typeof instance.picorubyResume === 'function') {
			instance.picorubyResume();
		}
	} catch (error) {
		instance.picorubyDebugState.sessionStarted = false;
		const message = error instanceof Error ? error.message : String(error);
		console.error('Failed to evaluate Ruby code in PicoRuby WASM', message);
	}
});

if (typeof module !== 'undefined' && module.exports) {
	module.exports = {
		stringifyLogValue,
		safeParseJson,
		normalizeVfsPath,
		writeVfsToRuntime,
		resolveVfsRequirePath,
		resolveVfsScriptPath,
		collectDebugRubyScripts,
		expandVfsRequires,
		injectBreakpointMarkers,
		injectBreakpointsIntoVfs,
		findBreakpointLines
	};
}
