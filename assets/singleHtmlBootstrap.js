(async function(global) {
	function base64ToUint8Array(base64) {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	}

	function normalizeVfsPath(relativePath) {
		if (typeof relativePath !== 'string') {
			return null;
		}

		const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
		const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
		if (segments.length === 0 || segments.includes('..')) {
			return null;
		}

		return segments.join('/');
	}

	function ensureVfsDirectory(fs, directoryPath) {
		const segments = directoryPath.split('/').filter(Boolean);
		let currentPath = '';

		for (const segment of segments) {
			currentPath += '/' + segment;
			try {
				fs.mkdir(currentPath);
			} catch {
			}
		}
	}

	function mountVfs(Module) {
		const vfs = global.__PICORUBY_VFS__;
		const fs = Module.FS;
		if (!vfs || typeof vfs !== 'object' || !fs || typeof fs.writeFile !== 'function') {
			return;
		}

		ensureVfsDirectory(fs, '/work');
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

			const directoryPath = ('/work/' + pathSegments.join('/')).replace(/\/$/, '');
			ensureVfsDirectory(fs, directoryPath);
			fs.writeFile(directoryPath + '/' + fileName, content, { encoding: 'utf8' });
		}

		if (typeof fs.chdir === 'function') {
			fs.chdir('/work');
		}
	}

	function normalizeResolvedVfsPath(value) {
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
	}

	function dirnameVfsPath(filePath) {
		const slashIndex = filePath.lastIndexOf('/');
		return slashIndex >= 0 ? filePath.slice(0, slashIndex) : '';
	}

	function resolveVfsRequirePath(request, importerPath, vfs) {
		if (!vfs || typeof vfs !== 'object' || typeof request !== 'string' || request === 'js') {
			return null;
		}

		const basePath = request.startsWith('./') || request.startsWith('../')
			? normalizeResolvedVfsPath(dirnameVfsPath(importerPath) + '/' + request)
			: normalizeResolvedVfsPath(request);

		if (!basePath) {
			return null;
		}

		for (const candidate of [basePath, basePath + '.rb', basePath + '/index.rb']) {
			if (typeof vfs[candidate] === 'string') {
				return candidate;
			}
		}

		return null;
	}

	function expandVfsRequires(code, vfs, importerPath = '__entrypoint__.rb', loadedPaths = new Set()) {
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
			return expandVfsRequires(vfs[resolvedPath], vfs, resolvedPath, loadedPaths);
		}).join('\n');
	}

	async function collectRubyScripts() {
		const rubyScripts = document.querySelectorAll('script[type="text/ruby"], script[type="text/picoruby"]');
		const taskPromises = Array.from(rubyScripts).map(async (script) => {
			if (script.src) {
				const response = await fetch(script.src);
				if (!response.ok) {
					throw new Error('Failed to load ' + script.src + ': ' + response.statusText);
				}
				const code = await response.text();
				const filename = script.src.split('/').pop() || script.src;
				return { code, filename };
			}
			return { code: script.textContent.trim(), filename: null };
		});
		return Promise.all(taskPromises);
	}

	async function collectMrbVMCode() {
		const mrbScripts = document.querySelectorAll('script[type="application/x-mrb"]');
		const taskPromises = Array.from(mrbScripts).map(async (script) => {
			if (!script.src) {
				return null;
			}
			const response = await fetch(script.src);
			if (!response.ok) {
				throw new Error('Failed to load ' + script.src + ': ' + response.statusText);
			}
			return response.arrayBuffer();
		});
		const results = await Promise.all(taskPromises);
		return results.filter(Boolean);
	}

	const { default: createModule } = await import(global.__PICORUBY_MODULE_URL__);
	const Module = await createModule({ wasmBinary: base64ToUint8Array(global.__PICORUBY_WASM_BASE64__) });
	global.picorubyModule = Module;

	Module.picorubyRun = function() {
		const MRB_TICK_UNIT = 4;
		const BATCH_DURATION = 16;
		const IDLE_DELAY = 4;
		const MAX_CATCHUP_TICKS = 10;
		const runStepStatus = Module._mrb_run_step_status || function() {
			const result = Module._mrb_run_step();
			return result < 0 ? -1 : 1;
		};
		const gcSchedulerPending = Module._mrb_gc_scheduler_pending_wasm || function() {
			return 0;
		};
		let lastTick = performance.now();
		function run() {
			const now = performance.now();
			let tickCount = 0;
			while (now - lastTick >= MRB_TICK_UNIT && tickCount < MAX_CATCHUP_TICKS) {
				Module._mrb_tick_wasm();
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
				if (status < 0 || status === 0) {
					break;
				}
				progressed = true;
			}
			setTimeout(run, progressed || gcSchedulerPending() === 1 ? 0 : IDLE_DELAY);
		}
		run();
	};

	mountVfs(Module);
	Module.ccall('picorb_init', 'number', [], []);

	try {
		const rubyTasks = await collectRubyScripts();
		rubyTasks.forEach((task) => {
			if (task.filename) {
				Module.ccall('picorb_create_task_with_filename', 'number', ['string', 'string'], [task.code, task.filename]);
			} else {
				Module.ccall('picorb_create_task', 'number', ['string'], [expandVfsRequires(task.code, global.__PICORUBY_VFS__)]);
			}
		});
	} catch (error) {
		console.error('Error loading Ruby tasks:', error);
	}

	try {
		const mrbTasks = await collectMrbVMCode();
		mrbTasks.forEach((buffer) => {
			const ptr = Module._malloc(buffer.byteLength);
			if (ptr === 0) {
				throw new Error('Failed to allocate memory in Wasm heap.');
			}
			try {
				Module.HEAPU8.set(new Uint8Array(buffer), ptr);
				const result = Module.ccall('picorb_create_task_from_mrb', 'number', ['number', 'number'], [ptr, buffer.byteLength]);
				if (result !== 0) {
					console.error('Failed to create task from mrb.');
				}
			} finally {
				Module._free(ptr);
			}
		});
	} catch (error) {
		console.error('Error loading MRB tasks:', error);
	}

	if (global.userTasks) {
		global.userTasks.forEach((task) => {
			Module.ccall('picorb_create_task', 'number', ['string'], [expandVfsRequires(typeof task === 'string' ? task : task.code, global.__PICORUBY_VFS__)]);
		});
	}

	Module.picorubyRun();
})(window).catch(console.error);