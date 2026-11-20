import { FSWatcher, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments, UserDefinition } from './commentExtractor';
import { VfsMap } from './vfsCollector';

type Collector = (file: string, signal?: AbortSignal) => Promise<VfsMap>;

interface IndexedFile {
	definitions: UserDefinition[];
	openDocument?: vscode.TextDocument;
	openVersion?: number;
	openDefinitions?: UserDefinition[];
}

interface PendingChange {
	version: number;
}

function fileKey(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** ホバー対象の親ディレクトリ以下のRuby定義を保持します。 */
export class HoverDefinitionIndex implements vscode.Disposable {
	private readonly files = new Map<string, IndexedFile>();
	private readonly definitions = new Map<string, Array<{ file: string; definition: UserDefinition }>>();
	private readonly changes = new Map<string, PendingChange>();
	private readonly watcher: FSWatcher;
	private watcherError: Error | undefined;
	private generation = 0;
	private initialized = false;
	private rebuild = false;
	private lookupDirty = true;
	private flight: { promise: Promise<void>; controller: AbortController; waiters: number } | undefined;

	constructor(private readonly target: string, private readonly collect: Collector) {
		const root = path.dirname(target);
		this.watcher = watch(root, { recursive: true }, (event, name) => this.changed(event, name));
		this.watcher.on('error', error => { this.watcherError = error; });
	}

	private changed(event: string, name: string | null): void {
		if (!name) {
			this.generation++;
			this.rebuild = true;
			return;
		}
		const file = fileKey(path.resolve(path.dirname(this.target), name));
		if (path.extname(file).toLowerCase() !== '.rb' && event !== 'rename') { return; }
		this.generation++;
		if (path.extname(file).toLowerCase() === '.rb') {
			this.changes.set(file, { version: this.generation });
		} else {
			// A directory event may add or remove a whole subtree.
			this.rebuild = true;
		}
	}

	private async refresh(signal: AbortSignal): Promise<void> {
		do {
			signal.throwIfAborted();
			if (!this.initialized || this.rebuild) {
				const generation = this.generation;
				const files = await this.collect(this.target, signal);
				signal.throwIfAborted();
				const parsed = new Map<string, IndexedFile>();
				for (const [file, text] of Object.entries(files)) {
					signal.throwIfAborted();
					parsed.set(fileKey(path.resolve(path.dirname(this.target), file)), { definitions: extractComments(text) });
				}
				if (generation !== this.generation) {
					continue;
				}
				this.files.clear();
				for (const [file, entry] of parsed) { this.files.set(file, entry); }
				this.changes.clear();
				this.lookupDirty = true;
				this.initialized = true;
				this.rebuild = false;
			}
			for (const [file, change] of this.changes) {
				signal.throwIfAborted();
				let text: string | undefined;
				try {
					text = await readFile(file, { encoding: 'utf8', signal });
				} catch (error) {
					if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error; }
				}
				signal.throwIfAborted();
				if (this.changes.get(file)?.version !== change.version) { continue; }
				if (text === undefined) { this.files.delete(file); }
				else { this.files.set(file, { definitions: extractComments(text) }); }
				this.changes.delete(file);
				this.lookupDirty = true;
			}
		} while (this.rebuild || this.changes.size > 0);
	}

	/** 進行中の更新を共有し、呼び出し元のキャンセルに応じて待機を終了します。 */
	async find(name: string, currentFile: string, token: vscode.CancellationToken): Promise<UserDefinition | undefined> {
		if (token.isCancellationRequested) { return undefined; }
		if (this.watcherError) { throw this.watcherError; }
		if (!this.flight && (!this.initialized || this.rebuild || this.changes.size > 0)) {
			const controller = new AbortController();
			const flight = { controller, waiters: 0, promise: Promise.resolve() };
			flight.promise = this.refresh(controller.signal).finally(() => {
				if (this.flight === flight) { this.flight = undefined; }
			});
			this.flight = flight;
		}
		const flight = this.flight;
		if (flight) {
			flight.waiters++;
			let subscription: vscode.Disposable | undefined;
			try {
				await Promise.race([
					flight.promise,
					new Promise<void>(resolve => {
						subscription = token.onCancellationRequested(() => resolve());
						if (token.isCancellationRequested) { resolve(); }
					})
				]);
			} finally {
				subscription?.dispose();
				flight.waiters--;
				if (flight.waiters === 0 && token.isCancellationRequested && this.flight === flight) {
					this.flight = undefined;
					flight.controller.abort();
				}
			}
		}
		if (token.isCancellationRequested) { return undefined; }
		if (this.watcherError) { throw this.watcherError; }

		const openFiles = new Map(vscode.workspace.textDocuments
			.filter(document => document.uri.scheme === 'file')
			.map(document => [fileKey(document.uri.fsPath), document]));
		for (const [file, entry] of this.files) {
			const document = openFiles.get(file);
			if (document && (entry.openDocument !== document || entry.openVersion !== document.version)) {
				entry.openDocument = document;
				entry.openVersion = document.version;
				entry.openDefinitions = extractComments(document.getText());
				this.lookupDirty = true;
			}
			if (!document && entry.openDocument) {
				entry.openDocument = undefined;
				entry.openVersion = undefined;
				entry.openDefinitions = undefined;
				this.lookupDirty = true;
			}
		}
		if (this.lookupDirty) {
			this.definitions.clear();
			for (const [file, entry] of this.files) {
				for (const definition of entry.openDefinitions ?? entry.definitions) {
					const shortName = definition.name.split(/::|\./).pop()!;
					for (const key of new Set([definition.name, shortName])) {
						const items = this.definitions.get(key) ?? [];
						items.push({ file, definition });
						this.definitions.set(key, items);
					}
				}
			}
			this.lookupDirty = false;
		}
		return this.definitions.get(name)?.find(item => item.file !== fileKey(currentFile))?.definition;
	}

	dispose(): void {
		this.flight?.controller.abort();
		this.watcher.close();
	}
}
