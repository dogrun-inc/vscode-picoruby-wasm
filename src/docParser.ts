/**
 * RDoc の行内装飾を Markdown に変換します。
 * 既存の Markdown を保護し、残りの部分だけを変換します。
 */
function convertRdocInlineMarkup(text: string): string {
	// 保護対象はコード、リンク、太字の順に判定します。
	// 開始の連続したバッククォートを記憶し、同じ個数の並びだけで閉じます。
	// 前後の境界判定により、長い並びの一部を開始・終了記号と見なしません。
	const markdownCode = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/y;
	const markdownLink = /\[[^\]]*\]\([^)]*\)/y;
	const markdownBold = /\*\*[^\n]*?\*\*/y;
	const protectedPatterns = [markdownCode, markdownLink, markdownBold];
	let result = '';
	let plainStart = 0;
	let position = 0;

	while (position < text.length) {
		let protectedText: string | undefined;
		for (const pattern of protectedPatterns) {
			// sticky フラグで、現在位置から始まる記法だけに一致させます。
			pattern.lastIndex = position;
			const match = pattern.exec(text);
			if (match) {
				protectedText = match[0];
				break;
			}
		}
		if (protectedText === undefined) {
			position++;
			continue;
		}
		result += convertRdocPlainText(text.slice(plainStart, position));
		result += protectedText;
		position += protectedText.length;
		plainStart = position;
	}
	return result + convertRdocPlainText(text.slice(plainStart));
}

/** +code+ の内容を保持し、その外側の太字・斜体だけを変換します。 */
function convertRdocPlainText(text: string): string {
	let result = '';
	let plainStart = 0;
	let position = 0;
	while (position < text.length) {
		if (text[position] !== '+') {
			position++;
			continue;
		}
		const closing = text.indexOf('+', position + 1);
		const content = text.slice(position + 1, closing);
		if (closing === -1 || !content || content.includes('\n')) {
			position++;
			continue;
		}
		result += convertRdocEmphasis(text.slice(plainStart, position));
		result += '`' + content + '`';
		position = closing + 1;
		plainStart = position;
	}
	return result + convertRdocEmphasis(text.slice(plainStart));
}

/** 太字の後に斜体を変換し、装飾が入れ子の場合も同じ順序で扱います。 */
function convertRdocEmphasis(text: string): string {
	const bold = convertDelimitedEmphasis(text, '*', '**');
	return convertDelimitedEmphasis(bold, '_', '*');
}

/**
 * 区切り文字に囲まれた装飾を変換します。
 * 単語内のアンダースコアや、リストの先頭の * は装飾と見なしません。
 */
function convertDelimitedEmphasis(text: string, delimiter: string, markdownDelimiter: string): string {
	let result = '';
	let position = 0;
	while (position < text.length) {
		const previous = text[position - 1];
		const canStart = previous === undefined || /\s/.test(previous) || previous === '(';
		if (text[position] !== delimiter || !canStart) {
			result += text[position++];
			continue;
		}
		const closing = text.indexOf(delimiter, position + 1);
		const content = text.slice(position + 1, closing);
		const following = text[closing + 1];
		const canEnd = following === undefined || /\s/.test(following) || ').,!?'.includes(following);
		const hasValidContent = content.length > 0 && content.trim() === content && !content.includes('\n');
		if (closing === -1 || !hasValidContent || !canEnd) {
			result += text[position++];
			continue;
		}
		result += markdownDelimiter + content + markdownDelimiter;
		position = closing + 1;
	}
	return result;
}

/** Ruby コードを、内容中のバッククォートと衝突しないフェンスで囲みます。 */
function codeBlock(lines: string[]): string {
	const nonempty = lines.filter(line => line.trim());
	const indent = nonempty.length ? Math.min(...nonempty.map(line => /^\s*/.exec(line)![0].length)) : 0;
	const code = lines.map(line => line.slice(indent)).join('\n').trimEnd();
	const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)));
	return `${fence}ruby\n${code}\n${fence}`;
}

interface DocSections {
	description: string[];
	params: string[];
	returns: string[];
	raises: string[];
	extras: string[];
}

/** 空行以外に共通する先頭スペースを、本文の基準位置として取り除きます。 */
function normalizeCommentIndentation(rawComment: string): string[] {
	const lines = rawComment.replace(/\r\n?/g, '\n').split('\n');
	let baseIndent = Infinity;
	for (const line of lines) {
		if (line.trim()) {
			baseIndent = Math.min(baseIndent, /^ */.exec(line)![0].length);
		}
	}
	return lines.map(line => line.trim() ? line.slice(baseIndent) : '');
}

/** 基準位置より2スペース以上深い本文を読み、コードの内容を変えずに囲みます。 */
function readIndentedCode(lines: string[], start: number): { markdown: string; end: number } {
	const code = [lines[start]];
	let end = start;
	while (end + 1 < lines.length) {
		const next = lines[end + 1];
		if (next.trim() && !next.startsWith('  ')) { break; }
		code.push(next);
		end++;
	}
	return { markdown: codeBlock(code), end };
}

/** 説明の一行、またはフェンス付きコードブロックを読み、最後に処理した行を返します。 */
function appendDescription(lines: string[], start: number, description: string[]): number {
	const fence = /^\s*(`{3,}|~{3,})/.exec(lines[start]);
	if (!fence) {
		const heading = lines[start].replace(/^(={2,6})\s+/, (_, marks: string) => '#'.repeat(marks.length) + ' ');
		description.push(convertRdocInlineMarkup(heading));
		return start;
	}
	// Markdown のコードブロックの中には装飾変換を適用しません。
	description.push(lines[start]);
	let end = start;
	while (++end < lines.length) {
		description.push(lines[end]);
		if (lines[end].trim().startsWith(fence[1])) { break; }
	}
	return end;
}

/** @example に続くコードを読み、整形結果と最後に処理した行を返します。 */
function readExample(lines: string[], start: number, title: string): { markdown: string; end: number } {
	const code: string[] = [];
	let end = start;
	while (end + 1 < lines.length && (/^\s+\S/.test(lines[end + 1]) || !lines[end + 1].trim())) {
		if (/^\s*@\w+/.test(lines[end + 1])) { break; }
		code.push(lines[++end]);
	}
	const heading = '**Example:**' + (title ? ' ' + convertRdocInlineMarkup(title) : '');
	return { markdown: heading + (code.length ? '\n\n' + codeBlock(code) : ''), end };
}

/** コード例以外の YARD タグを整形し、対応するセクションに追加します。 */
function appendYardTag(kind: string, content: string, sections: DocSections): void {
	if (kind === 'param') {
		const param = /^(\S+)(?:\s+\[([^\]]*)\])?(?:\s+(.*))?$/.exec(content);
		if (param) {
			sections.params.push('- `' + param[1] + '`' + (param[2] ? ' (`' + param[2] + '`)' : '') + (param[3] ? ' — ' + convertRdocInlineMarkup(param[3]) : ''));
		}
	} else if (kind === 'return' || kind === 'raise') {
		const typed = /^(?:\[([^\]]*)\]\s*)?(.*)$/.exec(content)!;
		const formatted = (typed[1] ? '`' + typed[1] + '`' : '') + (typed[1] && typed[2] ? ' — ' : '') + convertRdocInlineMarkup(typed[2]);
		if (kind === 'return') { sections.returns.push('**Returns:** ' + formatted); }
		else { sections.raises.push('- ' + formatted); }
	} else if (kind === 'note') {
		sections.extras.push('> **Note:** ' + convertRdocInlineMarkup(content));
	} else {
		// URL はリンクにし、Ruby の参照先はコードとして表示します。
		sections.extras.push('**See:** ' + (/^https?:\/\/[^\s<>]+$/.test(content) ? `<${content}>` : '`' + content + '`'));
	}
}

/**
 * # を除去した Ruby コメントを軽量な YARD / RDoc 規則で Markdown に変換します。
 * 本文の共通インデントを基準とし、2スペース以上深い本文はコードとして扱います。
 * YARD タグに続く継続行や @example の内容は、各タグの規則で処理します。
 * @param rawComment 抽出済みコメント本文。改行とコード例のインデントを保持します。
 * @returns 整形した本文。空コメントまたは :nodoc: を含む場合は空文字列。
 */
export function parseRubyDoc(rawComment: string): string {
	if (rawComment.includes(':nodoc:')) { return ''; }
	const lines = normalizeCommentIndentation(rawComment);
	const sections: DocSections = { description: [], params: [], returns: [], raises: [], extras: [] };
	for (let i = 0; i < lines.length; i++) {
		// 先頭が 2 スペース以上の行をコードとして扱います。
		// コード中の @param などをタグとして解釈しないよう、先に判定します。
		if (lines[i].trim() && lines[i].startsWith('  ')) {
			const code = readIndentedCode(lines, i);
			const lastLine = sections.description.at(-1);
			if (lastLine?.trim()) { sections.description.push(''); }
			sections.description.push(code.markdown, '');
			i = code.end;
			continue;
		}
		const tag = /^\s*@(param|return|raise|example|note|see)\b\s*(.*)$/.exec(lines[i]);
		if (!tag) {
			i = appendDescription(lines, i, sections.description);
			continue;
		}
		const [, kind, value] = tag;
		if (kind === 'example') {
			const example = readExample(lines, i, value);
			sections.extras.push(example.markdown);
			i = example.end;
			continue;
		}
		let content = value;
		// インデントされた説明の継続行を同じタグにまとめます。
		while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*@/.test(lines[i + 1])) {
			content += ' ' + lines[++i].trim();
		}
		appendYardTag(kind, content, sections);
	}
	const { description, params, returns, raises, extras } = sections;
	return [description.join('\n').trim(), params.length ? '**Parameters:**\n\n' + params.join('\n') : '', ...returns,
		raises.length ? '**Raises:**\n\n' + raises.join('\n') : '', ...extras].filter(Boolean).join('\n\n');
}
