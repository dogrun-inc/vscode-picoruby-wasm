interface HtmlTag {
	name: string;
	closing: boolean;
	start: number;
	end: number;
	attributes: string;
}

/** Finds the first `>` outside a quoted attribute value. */
function findTagEnd(html: string, start: number): number {
	let quote = '';
	for (let index = start; index < html.length; index++) {
		const character = html[index];
		if (quote) {
			if (character === quote) {
				quote = '';
			}
		} else if (character === '"' || character === '\'') {
			quote = character;
		} else if (character === '>') {
			return index;
		}
	}
	return -1;
}

/** Parses an HTML start or end tag at the given `<` offset. */
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

/** Returns an HTML attribute by exact name, ignoring ASCII case. */
function getHtmlAttribute(attributes: string, name: string): string {
	const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	for (const match of attributes.matchAll(pattern)) {
		if (match[1].toLowerCase() === name) {
			return match[2] ?? match[3] ?? match[4] ?? '';
		}
	}
	return '';
}

/** Finds the matching end tag for an HTML raw-text or RCDATA element. */
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
 * Scans HTML and returns the body ranges of executable Ruby script elements.
 *
 * Script-looking text in comments, quoted attributes, and raw-text/RCDATA
 * elements is skipped. The `type` attribute must be matched by its full name.
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
		if (tag.name === 'script') {
			const type = getHtmlAttribute(tag.attributes, 'type').toLowerCase();
			if (type === 'text/ruby' || type === 'text/picoruby') {
				ranges.push({ start: tag.end, end: endTag?.start ?? html.length });
			}
		}
		position = endTag?.end ?? html.length;
	}
	return ranges;
}
