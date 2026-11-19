import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { collectVfsFiles, VfsMap } from './vfsCollector';

const execFile = promisify(execFileCallback);

/**
 * Exports the selected PicoRuby HTML entrypoint as a self-contained HTML file.
 *
 * The output is written to a `dist/index.html` directory next to the source
 * entrypoint and includes the PicoRuby runtime, WASM binary, and collected VFS.
 *
 * @param context Extension context used to resolve bundled runtime assets.
 * @param sourceUri Optional HTML file selected from an Explorer context menu.
 */
export async function exportPicoRubySingleHtml(context: vscode.ExtensionContext, sourceUri?: vscode.Uri): Promise<void> {
	await exportPicoRubyHtml(context, sourceUri, 'source');
}

/**
 * Exports the selected PicoRuby HTML entrypoint with compiled MRB script tasks.
 *
 * @param context Extension context used to resolve bundled compiler and runtime assets.
 * @param sourceUri Optional HTML file selected from an Explorer context menu.
 */
export async function exportPicoRubyMrbHtml(context: vscode.ExtensionContext, sourceUri?: vscode.Uri): Promise<void> {
	await exportPicoRubyHtml(context, sourceUri, 'mrb');
}

/**
 * Resolves the selected HTML entrypoint, builds the requested export, and writes it under `dist`.
 *
 * Reports export failures to the user through a VS Code error message.
 *
 * @param context Extension context used to resolve bundled assets.
 * @param sourceUri Optional HTML file selected from an Explorer context menu.
 * @param mode Determines whether Ruby source or compiled MRB bytecode is embedded.
 */
async function exportPicoRubyHtml(
	context: vscode.ExtensionContext,
	sourceUri: vscode.Uri | undefined,
	mode: 'source' | 'mrb'
): Promise<void> {
	try {
		const targetHtmlPath = await resolveTargetHtmlPath(sourceUri);
		if (!targetHtmlPath) {
			return;
		}

		const outputFileName = mode === 'mrb' ? 'index.mrb.html' : 'index.html';
		const outputPath = path.join(path.dirname(targetHtmlPath), 'dist', outputFileName);
		const html = mode === 'mrb'
			? await buildPicoRubyMrbHtml(context, targetHtmlPath)
			: await buildPicoRubySingleHtml(context, targetHtmlPath);

		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, html, 'utf8');
		void vscode.window.showInformationMessage(`PicoRuby ${mode} HTML exported: ${outputPath}`);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Failed to export PicoRuby ${mode === 'mrb' ? 'MRB' : 'single'} HTML: ${message}`);
	}
}

/**
 * Builds the complete single-file HTML document without writing it to disk.
 *
 * @param context Extension context used to resolve bundled runtime assets.
 * @param targetHtmlPath Absolute path to the HTML entrypoint.
 * @returns HTML containing the source document and an embedded PicoRuby runtime.
 */
export async function buildPicoRubySingleHtml(context: vscode.ExtensionContext, targetHtmlPath: string): Promise<string> {
	const [sourceHtml, vfs] = await Promise.all([
		readFile(targetHtmlPath, 'utf8'),
		collectVfsFiles(targetHtmlPath)
	]);

	const htmlWithCss = await inlineExternalCss(sourceHtml, targetHtmlPath);
	return buildSingleHtmlRuntime(context, targetHtmlPath, htmlWithCss, vfs);
}

/**
 * Builds a self-contained HTML document that executes compiled MRB script tasks.
 * @param context Extension context used to resolve bundled compiler and runtime assets.
 * @param targetHtmlPath Absolute path to the HTML entrypoint.
 * @returns HTML with every PicoRuby script replaced by embedded MRB bytecode.
 */
export async function buildPicoRubyMrbHtml(context: vscode.ExtensionContext, targetHtmlPath: string): Promise<string> {
	const [sourceHtml, vfs] = await Promise.all([
		readFile(targetHtmlPath, 'utf8'),
		collectVfsFiles(targetHtmlPath)
	]);
	const htmlWithCss = await inlineExternalCss(sourceHtml, targetHtmlPath);
	const mrbHtml = await replaceRubyScriptsWithMrb(context, htmlWithCss, vfs);
	return buildSingleHtmlRuntime(context, targetHtmlPath, mrbHtml, vfs);
}

/**
 * Embeds the runtime assets and VFS in the supplied HTML document.
 *
 * @param context Extension context used to resolve bundled runtime assets.
 * @param targetHtmlPath Absolute path to the HTML entrypoint.
 * @param sourceHtml HTML document with external stylesheets already processed.
 * @param vfs Collected Ruby files to make available to the runtime.
 * @returns HTML containing the embedded single-file runtime.
 */
async function buildSingleHtmlRuntime(
	context: vscode.ExtensionContext,
	targetHtmlPath: string,
	sourceHtml: string,
	vfs: VfsMap
): Promise<string> {
	const [picorubyScript, picorubyWasm, bootstrapScript] = await Promise.all([
		readExtensionAsset(context, 'picoruby.js', 'utf8'),
		readExtensionAsset(context, 'picoruby.wasm'),
		readExtensionAsset(context, 'singleHtmlBootstrap.js', 'utf8')
	]);

	return injectSingleHtmlRuntime(sourceHtml, {
		vfs,
		picorubyScript: picorubyScript.toString(),
		picorubyWasmBase64: Buffer.from(picorubyWasm).toString('base64'),
		bootstrapScript: bootstrapScript.toString()
	});
}

/** Describes Ruby source code and its VFS path for compilation. */
interface RubyScriptEntrypoint {
	code: string;
	filename: string;
}

/**
 * Replaces each Ruby script element in the HTML with an element containing compiled MRB bytecode.
 *
 * @param context Extension context used to locate the MRB compiler.
 * @param html HTML document whose `text/ruby` and `text/picoruby` scripts are compiled.
 * @param vfs Collected Ruby files used to resolve script sources and `require` statements.
 * @returns HTML with the Ruby script elements replaced by compiled bytecode.
 * @throws If a script's `src` does not resolve to a Ruby file in the VFS or compilation fails.
 */
async function replaceRubyScriptsWithMrb(
	context: vscode.ExtensionContext,
	html: string,
	vfs: VfsMap
): Promise<string> {
	const rubyScriptRegex = /<script\b(?=[^>]*\btype=["'](?:text\/ruby|text\/picoruby)["'])[^>]*>([\s\S]*?)<\/script>/gi;
	const replacements: Array<{ source: string; replacement: string }> = [];
	let match: RegExpExecArray | null;

	while ((match = rubyScriptRegex.exec(html)) !== null) {
		const entrypoint = resolveRubyScriptEntrypoint(match[0], match[1], vfs);
		if (!entrypoint) {
			throw new Error('A Ruby script src must reference a .rb file collected into the VFS.');
		}

		const bundledCode = expandVfsRequires(entrypoint.code, vfs, entrypoint.filename);
		const mrb = await compileRubyToMrb(context, bundledCode, entrypoint.filename);
		replacements.push({
			source: match[0],
			replacement: `<script type="application/x-mrb" data-picoruby-mrb="${mrb.toString('base64')}"></script>`
		});
	}

	return replacements.reduce(
		(result, { source, replacement }) => result.replace(source, replacement),
		html
	);
}

/**
 * Resolves a Ruby script element to inline code or a Ruby file in the VFS.
 *
 * @param scriptTag Complete script element, used to read its optional `src` attribute.
 * @param inlineCode Source text inside the script element.
 * @param vfs Collected Ruby files.
 * @returns The entrypoint code and filename, or `undefined` if its `src` cannot be resolved.
 */
function resolveRubyScriptEntrypoint(scriptTag: string, inlineCode: string, vfs: VfsMap): RubyScriptEntrypoint | undefined {
	const sourceMatch = scriptTag.match(/\bsrc=["']([^"']+)["']/i);
	if (!sourceMatch) {
		return { code: inlineCode.trim(), filename: '__entrypoint__.rb' };
	}

	const sourcePath = resolveVfsPath(sourceMatch[1], '', vfs);
	return sourcePath ? { code: vfs[sourcePath], filename: sourcePath } : undefined;
}

/**
 * Resolves a requested path against the VFS, including `.rb` and `index.rb` candidates.
 *
 * Relative requests are based on the importing file; other requests are based at the VFS root.
 *
 * @param request Requested Ruby path, optionally containing a query or fragment.
 * @param importerPath VFS path of the file containing the request.
 * @param vfs Collected Ruby files.
 * @returns The matching VFS key, or `undefined` when no candidate exists.
 */
function resolveVfsPath(request: string, importerPath: string, vfs: VfsMap): string | undefined {
	const pathWithoutSuffix = request.split(/[?#]/, 1)[0].replace(/^\/+/, '');
	const basePath = request.startsWith('./') || request.startsWith('../')
		? normalizeVfsPath(path.posix.join(path.posix.dirname(importerPath), pathWithoutSuffix))
		: normalizeVfsPath(pathWithoutSuffix);

	if (!basePath) {
		return undefined;
	}

	return [basePath, `${basePath}.rb`, `${basePath}/index.rb`].find((candidate) => typeof vfs[candidate] === 'string');
}

/**
 * Normalizes a VFS path and rejects paths that escape the VFS root.
 *
 * @param filePath Path to normalize.
 * @returns A normalized relative POSIX path, or `undefined` if it is outside the root.
 */
function normalizeVfsPath(filePath: string): string | undefined {
	const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
		return undefined;
	}

	return normalized.replace(/^\.\//, '');
}

/**
 * Replaces resolvable Ruby `require` lines with their VFS source, recursively.
 *
 * Already-loaded files are omitted to prevent repeated inclusion and recursive cycles.
 *
 * @param code Ruby source to expand.
 * @param vfs Collected Ruby files.
 * @param importerPath VFS path of the source currently being expanded.
 * @param loadedPaths VFS paths already included during this expansion.
 * @returns Source with resolvable `require` lines expanded.
 */
function expandVfsRequires(code: string, vfs: VfsMap, importerPath: string, loadedPaths = new Set<string>()): string {
	return code.split('\n').map((line) => {
		const match = line.match(/^\s*require\s+['"]([^'"]+)['"]\s*(?:#.*)?$/);
		if (!match || match[1] === 'js') {
			return line;
		}

		const resolvedPath = resolveVfsPath(match[1], importerPath, vfs);
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

/**
 * Compiles Ruby source to MRB bytecode using the extension's bundled compiler.
 *
 * The temporary source and output files are removed whether compilation succeeds or fails.
 *
 * @param context Extension context used to locate the compiler.
 * @param source Ruby source code to compile.
 * @param filename Source filename supplied for the temporary input file.
 * @returns Compiled MRB bytecode.
 * @throws If the compiler cannot be executed or does not produce readable output.
 */
async function compileRubyToMrb(context: vscode.ExtensionContext, source: string, filename: string): Promise<Buffer> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'picoruby-mrbc-'));
	const sourcePath = path.join(temporaryDirectory, path.basename(filename) || 'entrypoint.rb');
	const outputPath = path.join(temporaryDirectory, 'entrypoint.mrb');
	const compilerPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'mrbc.js').fsPath;
	const nodeExecutable = await resolveNodeExecutable();

	try {
		await writeFile(sourcePath, source, 'utf8');
		await execFile(nodeExecutable, [compilerPath,
			'-o',
			outputPath,
			sourcePath
		]);
		return await readFile(outputPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

/**
 * Finds a Node.js executable that can run the bundled compiler from the current host.
 *
 * In Electron, separate Node.js candidates are checked first, with the current process
 * executable as the final fallback.
 *
 * @returns Executable path or command name for Node.js.
 */
async function resolveNodeExecutable(): Promise<string> {
	if (!process.versions.electron) {
		return process.execPath;
	}

	const candidates = [
		process.env.npm_node_execpath,
		process.env.NODE,
		process.platform === 'win32'
			? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
			: 'node'
	].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

	for (const candidate of candidates) {
		try {
			if (candidate === 'node') {
				return candidate;
			}
			await access(candidate);
			return candidate;
		} catch {
			continue;
		}
	}

	return process.execPath;
}

/**
 * Resolves an HTML entrypoint from an explicit URI, the active editor, or a picker.
 *
 * @param sourceUri Optional file URI supplied by an Explorer command.
 * @returns The selected HTML file path, or `undefined` if no file was selected.
 */
async function resolveTargetHtmlPath(sourceUri?: vscode.Uri): Promise<string | undefined> {
	if (sourceUri?.scheme === 'file' && /\.html?$/i.test(sourceUri.fsPath)) {
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

/**
 * Reads a runtime asset shipped with the extension package.
 *
 * @param context Extension context used to locate the asset directory.
 * @param fileName Asset filename relative to the package's `assets` directory.
 * @param encoding Optional text encoding; omitted to read binary data.
 * @returns Asset contents as a string when encoded, otherwise as a buffer.
 */
async function readExtensionAsset(context: vscode.ExtensionContext, fileName: string, encoding?: BufferEncoding): Promise<Buffer | string> {
	const assetPath = vscode.Uri.joinPath(context.extensionUri, 'assets', fileName).fsPath;
	return readFile(assetPath, encoding ? { encoding } : undefined);
}

/**
 * Inlines safe local stylesheets while preserving external and unsafe references.
 *
 * Stylesheet paths that leave the HTML directory are not read or inlined.
 *
 * @param htmlContent HTML document containing stylesheet links.
 * @param htmlPath Filesystem path of the HTML document.
 * @returns HTML with readable, safe local stylesheets inlined.
 */
async function inlineExternalCss(htmlContent: string, htmlPath: string): Promise<string> {
	const htmlDir = path.dirname(htmlPath);
	const linkRegex = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>|<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;
	let resolvedHtml = htmlContent;
	let match: RegExpExecArray | null;

	while ((match = linkRegex.exec(htmlContent)) !== null) {
		const originalHref = match[1] || match[2];
		if (!originalHref || originalHref.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(originalHref)) {
			continue;
		}

		const cssHref = originalHref.split(/[?#]/, 1)[0].replace(/^\/+/, '');
		if (!cssHref) {
			continue;
		}

		const cssPath = path.resolve(htmlDir, cssHref);
		const relativeCssPath = path.relative(htmlDir, cssPath);
		if (relativeCssPath.startsWith('..' + path.sep) || path.isAbsolute(relativeCssPath)) {
			continue;
		}

		try {
			const cssContent = await readFile(cssPath, 'utf8');
			const safeCssContent = cssContent.replace(/<\/style/gi, '<\\/style');
			resolvedHtml = resolvedHtml.replace(match[0], `<style>\n/* inlined: ${cssHref} */\n${safeCssContent}\n</style>`);
		} catch {
			continue;
		}
	}

	return resolvedHtml;
}

/**
 * Injects serialized runtime data and the packaged bootstrap into the HTML document.
 *
 * Removes script elements loading the local `init.iife.js`, then inserts the runtime before
 * the closing body tag, or appends it when the document has no body tag.
 *
 * @param html Source HTML document.
 * @param payload VFS, runtime module, WASM binary, and bootstrap to embed.
 * @returns HTML document containing the embedded single-file runtime.
 */
function injectSingleHtmlRuntime(html: string, payload: {
	vfs: VfsMap;
	picorubyScript: string;
	picorubyWasmBase64: string;
	bootstrapScript: string;
}): string {
	const runtimeScript = [
		'<script>',
		`window.__PICORUBY_VFS__ = ${jsonForHtmlScript(payload.vfs)};`,
		`window.__PICORUBY_WASM_BASE64__ = ${jsonForHtmlScript(payload.picorubyWasmBase64)};`,
		`window.__PICORUBY_MODULE_SOURCE__ = ${jsonForHtmlScript(payload.picorubyScript)};`,
		'window.__PICORUBY_MODULE_URL__ = URL.createObjectURL(new Blob([window.__PICORUBY_MODULE_SOURCE__], { type: "text/javascript" }));',
		'</script>',
		'<script type="module">',
		payload.bootstrapScript.trim(),
		'</script>'
	].join('\n');

	const htmlWithoutLocalInit = html.replace(/<script\b[^>]*\bsrc=["'][^"']*init\.iife\.js["'][^>]*>\s*<\/script>/gi, '');

	if (/<\/body>/i.test(htmlWithoutLocalInit)) {
		return htmlWithoutLocalInit.replace(/<\/body>/i, `${runtimeScript}\n</body>`);
	}

	return `${htmlWithoutLocalInit}\n${runtimeScript}`;
}

/**
 * Escapes JSON characters that could terminate or alter an inline script element.
 *
 * @param value Value to serialize for inclusion in an inline script.
 * @returns JSON text safe to embed in an HTML script element.
 */
function jsonForHtmlScript(value: unknown): string {
	const serialized = JSON.stringify(value);
	return (serialized ?? 'null')
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
