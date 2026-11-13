import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractComments } from './commentExtractor';
import { BUILTIN_DOCS, Documentation, TAG_DOCS } from './docs/builtins';
import { collectVfsFiles, VfsMap } from './vfsCollector';
import { HoverDefinitionIndex } from './hoverDefinitionIndex';

interface HtmlTag {
	name: string;
	closing: boolean;
	start: number;
	end: number;
	attributes: string;
}

/**
 * 引用符で囲まれた属性値を考慮して、開始位置以降で最初の `>` を探します。
 * @param html 解析対象のHTML全文。
 * @param start タグ内容の開始オフセット。
 * @returns `>` のオフセット。見つからない場合は `-1`。
 */
function findTagEnd(html: string, start: number): number {
	let quote = '';
	for (let i = start; i < html.length; i++) {
		const char = html[i];
		if (quote) {
			if (char === quote) {
				quote = '';
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === '>') {
			return i;
		}
	}
	return -1;
}

/**
 * 指定位置のHTML開始タグまたは終了タグを解析します。
 * @param html 解析対象のHTML全文。
 * @param start `<` のオフセット。
 * @returns タグ名、属性、範囲を含むタグ。位置がタグでないか、閉じ `>` がない場合は `undefined`。
 */
function parseHtmlTag(html: string, start: number): HtmlTag | undefined {
	if (html[start] !== '<') {
		return undefined;
	}
	let cursor = start + 1;
	const closing = html[cursor] === '/';
	if (closing) {
		cursor++;
	}
	if (!/[A-Za-z]/.test(html[cursor] ?? '')) {
		return undefined;
	}
	const nameStart = cursor;
	while (/[A-Za-z0-9:-]/.test(html[cursor] ?? '')) {
		cursor++;
	}
	if (html[cursor] && !/[\t\n\f\r />]/.test(html[cursor])) {
		return undefined;
	}
	const tagEnd = findTagEnd(html, cursor);
	if (tagEnd < 0) {
		return undefined;
	}
	return {
		name: html.slice(nameStart, cursor).toLowerCase(),
		closing,
		start,
		end: tagEnd + 1,
		attributes: closing ? '' : html.slice(cursor, tagEnd)
	};
}

/**
 * 属性名を大文字・小文字を区別せずに検索して値を返します。
 * @param attributes タグから切り出した属性文字列。
 * @param name 検索する属性名。
 * @returns 属性値。属性がない場合や値を持たない場合は空文字列。
 */
function getHtmlAttribute(attributes: string, name: string): string {
	const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	for (const match of attributes.matchAll(pattern)) {
		if (match[1].toLowerCase() === name) {
			return match[2] ?? match[3] ?? match[4] ?? '';
		}
	}
	return '';
}

/**
 * raw-text/RCDATA 要素本文から、対応する終了タグを探します。
 * @param html 解析対象のHTML全文。
 * @param name 要素名。
 * @param start 本文の開始オフセット。
 * @returns 見つかった終了タグ。存在しない場合は `undefined`。
 */
function findRawTextEndTag(html: string, name: string, start: number): HtmlTag | undefined {
	const endTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
	endTag.lastIndex = start;
	const match = endTag.exec(html);
	if (!match) {
		return undefined;
	}
	const tag = parseHtmlTag(html, match.index);
	return tag?.closing ? tag : undefined;
}

/**
 * HTML をタグ単位で走査し、Ruby script 本文の範囲を取得します。
 * コメント、属性値、raw-text/RCDATA 要素内の見かけ上のタグは対象にしません。
 *
 * @param html 解析対象の HTML 全文。
 * @returns 元の文字列に対する開始オフセットと終了オフセット（終了位置は含まない）。
 */
export function rubyScriptRanges(html: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const rawTextElements = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'style', 'textarea', 'title', 'xmp']);
	let position = 0;
	while (position < html.length) {
		const start = html.indexOf('<', position);
		if (start < 0) {
			break;
		}
		if (html.startsWith('<!--', start)) {
			const commentEnd = html.indexOf('-->', start + 4);
			position = commentEnd < 0 ? html.length : commentEnd + 3;
			continue;
		}
		if (html.startsWith('<!', start) || html.startsWith('<?', start)) {
			const declarationEnd = findTagEnd(html, start + 2);
			position = declarationEnd < 0 ? html.length : declarationEnd + 1;
			continue;
		}
		const tag = parseHtmlTag(html, start);
		if (!tag) {
			position = start + 1;
			continue;
		}
		position = tag.end;
		if (tag.closing) {
			continue;
		}
		if (tag.name === 'plaintext') {
			break;
		}
		if (tag.name !== 'script' && !rawTextElements.has(tag.name)) {
			continue;
		}

		const endTag = findRawTextEndTag(html, tag.name, tag.end);
		if (tag.name === 'script' && getHtmlAttribute(tag.attributes, 'type').toLowerCase() === 'text/ruby') {
			ranges.push({ start: tag.end, end: endTag?.start ?? html.length });
		}
		position = endTag?.end ?? html.length;
	}
	return ranges;
}

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
		const find = (texts: string[]) => texts.flatMap(extractComments).find(definition => definition.name === word || definition.name.split(/::|\./).pop() === word);
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
