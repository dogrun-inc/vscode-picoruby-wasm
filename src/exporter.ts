import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
		void vscode.window.showErrorMessage(`Failed to export PicoRuby single HTML: ${message}`);
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

interface RubyScriptEntrypoint {
	code: string;
	filename: string;
}

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

function resolveRubyScriptEntrypoint(scriptTag: string, inlineCode: string, vfs: VfsMap): RubyScriptEntrypoint | undefined {
	const sourceMatch = scriptTag.match(/\bsrc=["']([^"']+)["']/i);
	if (!sourceMatch) {
		return { code: inlineCode.trim(), filename: '__entrypoint__.rb' };
	}

	const sourcePath = resolveVfsPath(sourceMatch[1], '', vfs);
	return sourcePath ? { code: vfs[sourcePath], filename: sourcePath } : undefined;
}

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

function normalizeVfsPath(filePath: string): string | undefined {
	const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
		return undefined;
	}

	return normalized.replace(/^\.\//, '');
}

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

async function compileRubyToMrb(context: vscode.ExtensionContext, source: string, filename: string): Promise<Buffer> {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'picoruby-mrbc-'));
	const sourcePath = path.join(temporaryDirectory, path.basename(filename) || 'entrypoint.rb');
	const outputPath = path.join(temporaryDirectory, 'entrypoint.mrb');
	const compilerPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'mrbc.js').fsPath;

	try {
		await writeFile(sourcePath, source, 'utf8');
		await execFile(process.execPath, [compilerPath, '-o', outputPath, sourcePath]);
		return await readFile(outputPath);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

/**
 * Resolves an HTML entrypoint from an explicit URI, the active editor, or a picker.
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
 */
async function readExtensionAsset(context: vscode.ExtensionContext, fileName: string, encoding?: BufferEncoding): Promise<Buffer | string> {
	const assetPath = vscode.Uri.joinPath(context.extensionUri, 'assets', fileName).fsPath;
	return readFile(assetPath, encoding ? { encoding } : undefined);
}

/**
 * Inlines safe local stylesheets while preserving external and unsafe references.
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