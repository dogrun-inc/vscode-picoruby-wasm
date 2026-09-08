import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { collectVfsFiles, VfsMap } from './vfsCollector';

export async function exportPicoRubySingleHtml(context: vscode.ExtensionContext, sourceUri?: vscode.Uri): Promise<void> {
	const targetHtmlPath = await resolveTargetHtmlPath(sourceUri);
	if (!targetHtmlPath) {
		return;
	}

	const outputPath = path.join(path.dirname(targetHtmlPath), 'dist', 'index.html');
	const html = await buildPicoRubySingleHtml(context, targetHtmlPath);

	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, html, 'utf8');
	void vscode.window.showInformationMessage(`PicoRuby single HTML exported: ${outputPath}`);
}

export async function buildPicoRubySingleHtml(context: vscode.ExtensionContext, targetHtmlPath: string): Promise<string> {
	const [sourceHtml, vfs, picorubyScript, picorubyWasm] = await Promise.all([
		readFile(targetHtmlPath, 'utf8'),
		collectVfsFiles(targetHtmlPath),
		readExtensionAsset(context, 'picoruby.js', 'utf8'),
		readExtensionAsset(context, 'picoruby.wasm')
	]);

	const htmlWithCss = await inlineExternalCss(sourceHtml, targetHtmlPath);
	return injectSingleHtmlRuntime(htmlWithCss, {
		vfs,
		picorubyScript: picorubyScript.toString(),
		picorubyWasmBase64: Buffer.from(picorubyWasm).toString('base64')
	});
}

async function resolveTargetHtmlPath(sourceUri?: vscode.Uri): Promise<string | undefined> {
	if (sourceUri?.scheme === 'file') {
		return sourceUri.fsPath;
	}

	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri?.scheme === 'file' && /\.html?$/i.test(activeUri.fsPath)) {
		return activeUri.fsPath;
	}

	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { HTML: ['html', 'htm'] },
		openLabel: 'Export PicoRuby HTML'
	});

	return picked?.[0]?.fsPath;
}

async function readExtensionAsset(context: vscode.ExtensionContext, fileName: string, encoding?: BufferEncoding): Promise<Buffer | string> {
	const assetPath = vscode.Uri.joinPath(context.extensionUri, 'assets', fileName).fsPath;
	return readFile(assetPath, encoding ? { encoding } : undefined);
}

async function inlineExternalCss(htmlContent: string, htmlPath: string): Promise<string> {
	const htmlDir = path.dirname(htmlPath);
	const linkRegex = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>|<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;
	let resolvedHtml = htmlContent;
	let match: RegExpExecArray | null;

	while ((match = linkRegex.exec(htmlContent)) !== null) {
		const cssHref = match[1] || match[2];
		if (!cssHref || cssHref.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(cssHref)) {
			continue;
		}

		const cssPath = path.resolve(htmlDir, cssHref);
		const cssContent = await readFile(cssPath, 'utf8');
		const safeCssContent = cssContent.replace(/<\/style/gi, '<\\/style');
		resolvedHtml = resolvedHtml.replace(match[0], `<style>\n/* inlined: ${cssHref} */\n${safeCssContent}\n</style>`);
	}

	return resolvedHtml;
}

function injectSingleHtmlRuntime(html: string, payload: {
	vfs: VfsMap;
	picorubyScript: string;
	picorubyWasmBase64: string;
}): string {
	const runtimeScript = [
		'<script>',
		`window.__PICORUBY_VFS__ = ${jsonForHtmlScript(payload.vfs)};`,
		`window.__PICORUBY_WASM_BASE64__ = ${jsonForHtmlScript(payload.picorubyWasmBase64)};`,
		`window.__PICORUBY_MODULE_SOURCE__ = ${jsonForHtmlScript(payload.picorubyScript)};`,
		'window.__PICORUBY_MODULE_URL__ = URL.createObjectURL(new Blob([window.__PICORUBY_MODULE_SOURCE__], { type: "text/javascript" }));',
		'</script>',
		'<script type="module">',
		createSingleHtmlBootstrapScript(),
		'</script>'
	].join('\n');

	const htmlWithoutLocalInit = html.replace(/<script\b[^>]*\bsrc=["'][^"']*init\.iife\.js["'][^>]*>\s*<\/script>/gi, '');

	if (/<\/body>/i.test(htmlWithoutLocalInit)) {
		return htmlWithoutLocalInit.replace(/<\/body>/i, `${runtimeScript}\n</body>`);
	}

	return `${htmlWithoutLocalInit}\n${runtimeScript}`;
}

function createSingleHtmlBootstrapScript(): string {
	return `
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

		const normalized = relativePath.replace(/\\\\/g, '/').replace(/^\\.\\//, '').replace(/^\\/+/, '');
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

			const directoryPath = ('/work/' + pathSegments.join('/')).replace(/\\/$/, '');
			ensureVfsDirectory(fs, directoryPath);
			fs.writeFile(directoryPath + '/' + fileName, content, { encoding: 'utf8' });
		}

		if (typeof fs.chdir === 'function') {
			fs.chdir('/work');
		}
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
				Module.ccall('picorb_create_task', 'number', ['string'], [task.code]);
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
			Module.ccall('picorb_create_task', 'number', ['string'], [typeof task === 'string' ? task : task.code]);
		});
	}

	Module.picorubyRun();
})(window).catch(console.error);
`.trim();
}

function jsonForHtmlScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}