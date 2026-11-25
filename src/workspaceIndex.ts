import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeHtmlRubySource, analyzeRubySource, FileSymbolTable, ScopeNode, SymbolInfo } from './symbolAnalyzer';

export { analyzeHtmlRubySource } from './symbolAnalyzer';

const UPDATE_DELAY_MS = 250;

function fileKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function extensionOf(filePath: string): string {
	return path.extname(filePath).toLowerCase();
}

function rubyDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && ['.rb', '.html'].includes(extensionOf(document.uri.fsPath));
}

/** Shared workspace cache for Ruby symbols and embedded Ruby script blocks. */
export class WorkspaceIndex implements vscode.Disposable {
	private readonly tables = new Map<string, FileSymbolTable>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly pending = new Map<string, NodeJS.Timeout>();
	private initialization: Promise<void> | undefined;
	private disposed = false;

	async initialize(): Promise<void> {
		if (this.initialization) {
			return this.initialization;
		}
		this.initialization = this.initializeInternal();
		return this.initialization;
	}

	private async initializeInternal(): Promise<void> {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.{rb,html}');
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(event => this.scheduleDocument(event.document)),
			vscode.workspace.onDidOpenTextDocument(document => {
				if (extensionOf(document.uri.fsPath) === '.html') {
					this.scheduleDocument(document);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => this.documentClosed(document)),
			vscode.workspace.onDidCreateFiles(event => {
				for (const uri of event.files) {
					if (extensionOf(uri.fsPath) === '.rb') {
						void this.updateFile(uri);
					}
				}
			}),
			vscode.workspace.onDidDeleteFiles(event => {
				for (const uri of event.files) {
					this.remove(uri.fsPath);
				}
			}),
			vscode.workspace.onDidRenameFiles(event => {
				for (const { oldUri, newUri } of event.files) {
					this.remove(oldUri.fsPath);
					if (extensionOf(newUri.fsPath) === '.rb') {
						void this.updateFile(newUri);
					}
				}
			}),
			watcher,
			watcher.onDidCreate(uri => {
				const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
				if (openDocument) {
					this.scheduleDocument(openDocument);
				} else if (extensionOf(uri.fsPath) === '.rb') {
					void this.updateFile(uri);
				}
			}),
			watcher.onDidChange(uri => {
				const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
				if (openDocument) {
					this.scheduleDocument(openDocument);
				} else if (extensionOf(uri.fsPath) === '.rb') {
					void this.updateFile(uri);
				}
			}),
			watcher.onDidDelete(uri => this.remove(uri.fsPath))
		);

		const rubyUris = await vscode.workspace.findFiles('**/*.rb');
		const openHtml = vscode.workspace.textDocuments.filter(document =>
			rubyDocument(document) && extensionOf(document.uri.fsPath) === '.html');
		await Promise.all([
			...rubyUris.map(uri => this.updateFile(uri)),
			...openHtml.map(document => this.updateDocument(document))
		]);
	}

	/** Returns the containing scopes, from global to the most specific child. */
	getScopeAt(filePath: string, line: number): ScopeNode[] {
		const root = this.tables.get(fileKey(filePath))?.rootScope;
		if (!root || line < root.startLine || line > root.endLine) {
			return [];
		}
		const scopes = [root];
		let children = root.children;
		while (true) {
			const child = children
				.filter(candidate => candidate.startLine <= line && candidate.endLine >= line)
				.sort((left, right) => right.startLine - left.startLine || left.endLine - right.endLine)[0];
			if (!child) {
				break;
			}
			scopes.push(child);
			children = child.children;
		}
		return scopes;
	}

	/**
	 * Resolves a name in lexical order, then in the rest of the current file and
	 * finally in other indexed files.
	 */
	findSymbol(filePath: string, line: number, name: string): SymbolInfo | undefined {
		const key = fileKey(filePath);
		const table = this.tables.get(key);
		if (!table) {
			return undefined;
		}
		const scopes = this.getScopeAt(filePath, line);
		const symbolKinds: SymbolKind[] = name.startsWith('@@')
			? ['cvar']
			: name.startsWith('@')
				? ['ivar']
				: /^[A-Z]/.test(name)
					? ['constant', 'class', 'module']
					: ['param', 'lvar', 'method'];

		for (const scope of [...scopes].reverse()) {
			const symbol = this.findByKind(scope.symbols, name, symbolKinds);
			if (symbol) {
				return symbol;
			}
		}
		const sharedKinds = name.startsWith('@@')
			? (['cvar'] as const)
			: name.startsWith('@')
				? (['ivar'] as const)
				: /^[A-Z]/.test(name)
					? (['constant', 'class', 'module'] as const)
					: (['method'] as const);
		const currentFileSymbol = this.findInTree(table.rootScope, name, [...sharedKinds]);
		if (currentFileSymbol) {
			return currentFileSymbol;
		}
		for (const [otherKey, otherTable] of this.tables) {
			if (otherKey === key) {
				continue;
			}
			const publicKinds = sharedKinds.filter(kind => !['ivar', 'cvar'].includes(kind));
			const symbol = this.findInTree(otherTable.rootScope, name, publicKinds);
			if (symbol) {
				return symbol;
			}
		}
		return undefined;
	}

	private findByKind(symbols: SymbolInfo[], name: string, kinds: SymbolInfo['kind'][]): SymbolInfo | undefined {
		for (const kind of kinds) {
			const symbol = [...symbols].reverse().find(candidate => candidate.name === name && candidate.kind === kind);
			if (symbol) {
				return symbol;
			}
		}
		return undefined;
	}

	private findInTree(scope: ScopeNode, name: string, kinds: SymbolInfo['kind'][]): SymbolInfo | undefined {
		const direct = this.findByKind(scope.symbols, name, kinds);
		if (direct) {
			return direct;
		}
		for (const child of scope.children) {
			const nested = this.findInTree(child, name, kinds);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	}

	private scheduleDocument(document: vscode.TextDocument): void {
		if (!rubyDocument(document) || this.disposed) {
			return;
		}
		const key = fileKey(document.uri.fsPath);
		const existing = this.pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.pending.set(key, setTimeout(() => {
			this.pending.delete(key);
			void this.updateDocument(document);
		}, UPDATE_DELAY_MS));
	}

	private async updateDocument(document: vscode.TextDocument): Promise<void> {
		if (!rubyDocument(document) || this.disposed) {
			return;
		}
		const extension = extensionOf(document.uri.fsPath);
		this.tables.set(
			fileKey(document.uri.fsPath),
			extension === '.html'
				? analyzeHtmlRubySource(document.uri.fsPath, document.getText())
				: analyzeRubySource(document.uri.fsPath, document.getText())
		);
	}

	private async updateFile(uri: vscode.Uri): Promise<void> {
		if (uri.scheme !== 'file' || this.disposed) {
			return;
		}
		const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		if (openDocument) {
			await this.updateDocument(openDocument);
			return;
		}
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (!this.disposed) {
			this.tables.set(fileKey(uri.fsPath), analyzeRubySource(uri.fsPath, Buffer.from(bytes).toString('utf8')));
		}
	}

	private documentClosed(document: vscode.TextDocument): void {
		if (document.uri.scheme !== 'file') {
			return;
		}
		const extension = extensionOf(document.uri.fsPath);
		if (extension === '.html') {
			this.remove(document.uri.fsPath);
		} else if (extension === '.rb') {
			void this.updateFile(document.uri);
		}
	}

	private remove(filePath: string): void {
		const key = fileKey(filePath);
		const timer = this.pending.get(key);
		if (timer) {
			clearTimeout(timer);
			this.pending.delete(key);
		}
		this.tables.delete(key);
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.pending.values()) {
			clearTimeout(timer);
		}
		this.pending.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.tables.clear();
	}
}

type SymbolKind = SymbolInfo['kind'];
