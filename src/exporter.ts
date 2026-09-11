import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { collectVfsFiles, VfsMap } from './vfsCollector';

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
	try {
		const targetHtmlPath = await resolveTargetHtmlPath(sourceUri);
		if (!targetHtmlPath) {
			return;
		}

		const outputPath = path.join(path.dirname(targetHtmlPath), 'dist', 'index.html');
		const html = await buildPicoRubySingleHtml(context, targetHtmlPath);

		await mkdir(path.dirname(outputPath), { recursive: true });
		await writeFile(outputPath, html, 'utf8');
		void vscode.window.showInformationMessage(`PicoRuby single HTML exported: ${outputPath}`);
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
	const [sourceHtml, vfs, picorubyScript, picorubyWasm, bootstrapScript] = await Promise.all([
		readFile(targetHtmlPath, 'utf8'),
		collectVfsFiles(targetHtmlPath),
		readExtensionAsset(context, 'picoruby.js', 'utf8'),
		readExtensionAsset(context, 'picoruby.wasm'),
		readExtensionAsset(context, 'singleHtmlBootstrap.js', 'utf8')
	]);

	const htmlWithCss = await inlineExternalCss(sourceHtml, targetHtmlPath);
	return injectSingleHtmlRuntime(htmlWithCss, {
		vfs,
		picorubyScript: picorubyScript.toString(),
		picorubyWasmBase64: Buffer.from(picorubyWasm).toString('base64'),
		bootstrapScript: bootstrapScript.toString()
	});
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
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}