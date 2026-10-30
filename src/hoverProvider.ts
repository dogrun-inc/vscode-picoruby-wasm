import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments } from './commentExtractor';
import { BUILTIN_DOCS, Documentation, TAG_DOCS } from './docs/builtins';
import { collectVfsFiles, VfsMap } from './vfsCollector';

/**
 * HTML 内の `type="text/ruby"` を持つ script 要素から、本文の範囲を取得します。
 * HTML コメント内の script 要素は対象に含めません。
 *
 * @param html 解析対象の HTML 全文。
 * @returns 元の文字列に対する開始オフセットと終了オフセット（終了位置は含まない）。
 */
export function rubyScriptRanges(html: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const scripts = /<!--[^]*?-->|<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([^]*?)(?:<\/script\s*>|$)/gi;
	for (const match of html.matchAll(scripts)) {
		if (!match[1]) { continue; }
		const attributes = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
		const type = [...match[1].matchAll(attributes)].find(attribute => attribute[1].toLowerCase() === 'type');
		if ((type?.[2] ?? type?.[3] ?? type?.[4] ?? '').toLowerCase() !== 'text/ruby') { continue; }
		const start = match.index! + '<script'.length + match[1].length + 1;
		ranges.push({ start, end: start + match[2].length });
	}
	return ranges;
}

/**
 * Ruby コードの組み込み API 仕様や、ユーザー定義のヘッダーとコメントを表示します。
 * HTML ドキュメントでは Ruby の script 本文内だけを対象にします。
 */
export class PicoRubyHoverProvider implements vscode.HoverProvider {
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
		const find = (texts: string[]) => texts.flatMap(extractComments).find(definition => definition.name === word || definition.name.split(/::|\./).pop() === word);
		let definition = find(sources);
		if (!definition && document.uri.scheme === 'file') {
			try {
				const files = await this.collect(document.uri.fsPath);
				if (token.isCancellationRequested) { return null; }
				const root = path.dirname(document.uri.fsPath);
				const projectSources = Object.entries(files).filter(([file]) => path.resolve(root, file) !== document.uri.fsPath).map(([file, source]) => {
					const open = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === path.resolve(root, file));
					return open?.getText() ?? source;
				});
				definition = find(projectSources);
			} catch {
				// Missing or unreadable project files must not break editor hovers.
			}
		}
		return definition && !token.isCancellationRequested ? this.hover(definition, range) : null;
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
		if (docs.description) { markdown.appendMarkdown('\n' + docs.description); }
		if (docs.example) { markdown.appendCodeblock(docs.example, 'ruby'); }
		return new vscode.Hover(markdown, range);
	}
}
