import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments } from './commentExtractor';
import { BUILTIN_DOCS, Documentation, TAG_DOCS } from './docs/builtins';
import { collectVfsFiles, VfsMap } from './vfsCollector';
import { HoverDefinitionIndex } from './hoverDefinitionIndex';
import { rubyScriptRanges } from './htmlRubyScanner';

export { rubyScriptRanges } from './htmlRubyScanner';

/**
 * Ruby コードの組み込み API 仕様や、ユーザー定義のヘッダーとコメントを表示します。
 * HTML ドキュメントでは Ruby の script 本文内だけを対象にします。
 */
export class PicoRubyHoverProvider implements vscode.HoverProvider, vscode.Disposable {
	private readonly indexes = new Map<string, HoverDefinitionIndex>();
	/**
	 * @param collect 対象ファイルと同じディレクトリ配下の Ruby ソースを収集する関数。
	 * テスト時には任意の VFS 収集関数に差し替えられます。
	 */
	constructor(private readonly collect: (file: string) => Promise<VfsMap> = collectVfsFiles) {}

	/**
	 * カーソル位置の識別子から、ホバーに表示するドキュメントを検索します。
	 * 組み込み辞書を優先し、続いて同一ドキュメント内のユーザー定義を探します。
	 * 見つからない場合は、file URI のドキュメントに限り VFS 内も検索します。
	 * VFS 内で開いているファイルは、保存済みの内容より編集中の内容を優先します。
	 *
	 * @param document ホバー対象のドキュメント。
	 * @param position ドキュメント内のカーソル位置。
	 * @param token VS Code から渡されるキャンセル通知。
	 * @returns シグネチャと説明を含むホバー。対象外・該当なし・キャンセル時は null。
	 */
	async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
		if (token.isCancellationRequested) { return null; }
		const text = document.getText();
		let sources = [text];
		if (document.languageId === 'html') {
			const ranges = rubyScriptRanges(text);
			const offset = document.offsetAt(position);
			if (!ranges.some(range => offset >= range.start && offset < range.end)) { return null; }
			sources = ranges.map(range => text.slice(range.start, range.end));
		}
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*[!?=]?/);
		if (!range) { return null; }
		const word = document.getText(range);
		const line = document.lineAt(position.line).text;
		// Prefer qualified API names, including when hovering a namespace segment.
		let docs: Documentation | undefined;
		for (const match of line.matchAll(/[A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*/g)) {
			if (range.start.character >= match.index! && range.end.character <= match.index! + match[0].length) {
				docs = Object.hasOwn(BUILTIN_DOCS, match[0]) ? BUILTIN_DOCS[match[0]] : undefined;
				break;
			}
		}
		docs ??= Object.hasOwn(BUILTIN_DOCS, word) ? BUILTIN_DOCS[word] : Object.hasOwn(TAG_DOCS, word) ? TAG_DOCS[word] : undefined;
		if (docs) { return this.hover(docs, range); }
		const find = (texts: string[]) => {
			return texts.flatMap(extractComments).find(definition => definition.name === word || definition.name.split(/::|\./).pop() === word);
		};
		let definition = find(sources);
		if (!definition && document.uri.scheme === 'file') {
			const root = path.dirname(document.uri.fsPath);
			let index = this.indexes.get(root);
			try {
				if (!index) {
					index = new HoverDefinitionIndex(document.uri.fsPath, this.collect);
					this.indexes.set(root, index);
				}
				definition = await index.find(word, document.uri.fsPath, token);
			} catch (error) {
				if (!token.isCancellationRequested) {
					console.error('Failed to index Ruby documentation:', error);
					if (index && this.indexes.get(root) === index) {
						index.dispose();
						this.indexes.delete(root);
					}
				}
			}
		}
		return definition && !token.isCancellationRequested ? this.hover(definition, range) : null;
	}

	dispose(): void {
		for (const index of this.indexes.values()) { index.dispose(); }
		this.indexes.clear();
	}

	/**
	 * シグネチャ、Markdown の説明、任意の使用例をホバー用に整形します。
	 * シグネチャと使用例は Ruby のコードブロックとして表示します。
	 *
	 * @param docs 表示するドキュメントデータ。
	 * @param range ホバーの対象となる識別子の範囲。
	 * @returns 整形済みの Markdown を含むホバー。
	 */
	private hover(docs: Documentation, range: vscode.Range): vscode.Hover {
		const markdown = new vscode.MarkdownString();
		markdown.appendCodeblock(docs.signature, 'ruby');
		if (docs.description) { markdown.appendMarkdown('\n---\n\n' + docs.description); }
		if (docs.example) { markdown.appendCodeblock(docs.example, 'ruby'); }
		return new vscode.Hover(markdown, range);
	}
}
