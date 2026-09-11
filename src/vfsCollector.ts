import * as path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

/**
 * Maps POSIX-style relative Ruby paths to their UTF-8 source text.
 */
export interface VfsMap {
	[relativePath: string]: string;
}

/**
 * Recursively collects `.rb` files under the target HTML directory.
 *
 * Files are keyed relative to the directory containing `targetHtmlPath`, so
 * nested files can be resolved consistently by the WebView runtime and exporter.
 * Filesystem errors are intentionally propagated to the caller.
 *
 * @param targetHtmlPath Absolute or relative path to the HTML entrypoint.
 * @returns Promise resolving to the collected relative-path/source map.
 */
export async function collectVfsFiles(targetHtmlPath: string): Promise<VfsMap> {
	const rootDirectory = path.dirname(targetHtmlPath);
	const rootStat = await stat(rootDirectory);
	if (!rootStat.isDirectory()) {
		return {};
	}

	const files: VfsMap = {};
	await collectRubyFiles(rootDirectory, rootDirectory, files);
	return files;
}

/**
 * Traverses one directory and appends Ruby files to the shared result map.
 */
async function collectRubyFiles(rootDirectory: string, currentDirectory: string, files: VfsMap): Promise<void> {
	const entries = await readdir(currentDirectory, { withFileTypes: true });

	for (const entry of entries) {
		const entryPath = path.join(currentDirectory, entry.name);

		if (entry.isDirectory()) {
			await collectRubyFiles(rootDirectory, entryPath, files);
			continue;
		}

		if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.rb') {
			continue;
		}

		const relativePath = path.relative(rootDirectory, entryPath).split(path.sep).join('/');
		files[relativePath] = await readFile(entryPath, 'utf8');
	}
}