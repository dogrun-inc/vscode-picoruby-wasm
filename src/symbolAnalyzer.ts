export type SymbolKind = 'class' | 'module' | 'method' | 'ivar' | 'cvar' | 'lvar' | 'constant' | 'param';

export interface SymbolInfo {
	name: string;
	kind: SymbolKind;
	line: number;
	column: number;
	inferredType?: string;
	superClass?: string;
	params?: string[];
	rawComment?: string;
}

export interface ScopeNode {
	type: 'global' | 'class' | 'module' | 'method' | 'block';
	name?: string;
	startLine: number;
	endLine: number;
	symbols: SymbolInfo[];
	children: ScopeNode[];
}

export interface FileSymbolTable {
	filePath: string;
	rootScope: ScopeNode;
}

type TokenKind = 'identifier' | 'constant' | 'variable' | 'number' | 'string' | 'symbol' | 'comment' | 'operator' | 'newline';

interface Token {
	kind: TokenKind;
	value: string;
	line: number;
	column: number;
}

interface ScopeFrame {
	scope: ScopeNode;
	closer: 'end' | 'brace';
	createsScope: boolean;
	openedOnLine: number;
}

const CONTROL_KEYWORDS = new Set(['if', 'unless', 'while', 'until', 'for', 'begin', 'case']);
const METHOD_RETURNS = /(?:^|\n)\s*@return\s+\[([^\]]+)\]/;

function isIdentifierStart(character: string | undefined): boolean {
	return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
	return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function regexCanStart(previous: Token | undefined): boolean {
	if (!previous || previous.kind === 'newline' || previous.kind === 'operator' && ![')', ']', '}'].includes(previous.value)) {
		return true;
	}
	return previous.kind === 'identifier' && ['return', 'break', 'next', 'raise'].includes(previous.value);
}

function tokenize(source: string, lineOffset: number): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let line = 1;
	let column = 0;
	let previous: Token | undefined;

	const add = (kind: TokenKind, value: string, tokenLine = line, tokenColumn = column): Token => {
		const token = { kind, value, line: tokenLine + lineOffset, column: tokenColumn };
		tokens.push(token);
		if (kind !== 'comment' && (kind !== 'newline' || value === '\n')) {
			previous = token;
		}
		return token;
	};

	while (index < source.length) {
		const character = source[index];
		const tokenLine = line;
		const tokenColumn = column;

		if (character === '\r' || character === '\n') {
			add('newline', '\n', tokenLine, tokenColumn);
			if (character === '\r' && source[index + 1] === '\n') {
				index += 2;
			} else {
				index++;
			}
			line++;
			column = 0;
			continue;
		}
		if (character === ' ' || character === '\t' || character === '\f' || character === '\v') {
			index++;
			column++;
			continue;
		}
		if (character === '#') {
			const start = index + 1;
			while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
				index++;
				column++;
			}
			const comment = source.slice(start, index);
			add('comment', comment.startsWith(' ') ? comment.slice(1) : comment, tokenLine, tokenColumn);
			continue;
		}
		if (character === '\'' || character === '"') {
			const quote = character;
			index++;
			column++;
			while (index < source.length) {
				if (source[index] === '\r' || source[index] === '\n') {
					break;
				}
				if (source[index] === '\\') {
					index += Math.min(2, source.length - index);
					column += 2;
					continue;
				}
				const current = source[index++];
				column++;
				if (current === quote) {
					break;
				}
			}
			add('string', quote, tokenLine, tokenColumn);
			continue;
		}
		if (character === '/' && regexCanStart(previous)) {
			index++;
			column++;
			let characterClass = false;
			while (index < source.length) {
				const current = source[index++];
				column++;
				if (current === '\r' || current === '\n') {
					line++;
					column = 0;
					break;
				}
				if (current === '\\') {
					if (index < source.length) {
						index++;
						column++;
					}
				} else if (current === '[') {
					characterClass = true;
				} else if (current === ']') {
					characterClass = false;
				} else if (current === '/' && !characterClass) {
					while (/[a-z]/i.test(source[index] ?? '')) {
						index++;
						column++;
					}
					break;
				}
			}
			add('string', '/', tokenLine, tokenColumn);
			continue;
		}
		if (character === ':' && ![':'].includes(source[index + 1] ?? '')) {
			let end = index + 1;
			let quote: string | undefined;
			if (source[end] === '\'' || source[end] === '"') {
				quote = source[end++];
				while (end < source.length && source[end] !== quote) {
					end += source[end] === '\\' ? 2 : 1;
				}
				if (source[end] === quote) {
					end++;
				}
			} else {
				while (isIdentifierPart(source[end]) || source[end] === '?' || source[end] === '!') {
					end++;
				}
			}
			if (end > index + 1) {
				const value = source.slice(index, end);
				const length = end - index;
				index = end;
				column += length;
				add('symbol', value, tokenLine, tokenColumn);
				continue;
			}
		}
		if (character === '@') {
			const atCount = source[index + 1] === '@' ? 2 : 1;
			let end = index + atCount;
			while (isIdentifierPart(source[end])) {
				end++;
			}
			const value = source.slice(index, end);
			index = end;
			column += value.length;
			add('variable', value, tokenLine, tokenColumn);
			continue;
		}
		if (isIdentifierStart(character)) {
			let end = index + 1;
			while (isIdentifierPart(source[end])) {
				end++;
			}
			const value = source.slice(index, end);
			index = end;
			column += value.length;
			add(/^[A-Z]/.test(value) ? 'constant' : 'identifier', value, tokenLine, tokenColumn);
			continue;
		}
		if (/[0-9]/.test(character) || character === '.' && /[0-9]/.test(source[index + 1] ?? '')) {
			let end = index;
			if (source[index] === '0' && /[xXbBoO]/.test(source[index + 1] ?? '')) {
				end += 2;
				while (/[0-9A-Fa-f_]/.test(source[end] ?? '')) {
					end++;
				}
			} else {
				while (/[0-9_]/.test(source[end] ?? '')) {
					end++;
				}
				if (source[end] === '.') {
					end++;
					while (/[0-9_]/.test(source[end] ?? '')) {
						end++;
					}
				}
				if (/[eE]/.test(source[end] ?? '')) {
					end++;
					if (/[+-]/.test(source[end] ?? '')) {
						end++;
					}
					while (/[0-9_]/.test(source[end] ?? '')) {
						end++;
					}
				}
			}
			const value = source.slice(index, end);
			index = end;
			column += value.length;
			add('number', value, tokenLine, tokenColumn);
			continue;
		}

		const pair = source.slice(index, index + 2);
		if (['::', '=>', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/='].includes(pair)) {
			index += 2;
			column += 2;
			add('operator', pair, tokenLine, tokenColumn);
			continue;
		}
		index++;
		column++;
		add('operator', character, tokenLine, tokenColumn);
	}
	return tokens;
}

function isNameToken(token: Token | undefined): boolean {
	return token?.kind === 'identifier' || token?.kind === 'constant' || token?.kind === 'variable';
}

function readQualifiedName(tokens: Token[], start: number): { name: string; next: number } {
	let name = tokens[start]?.value ?? '';
	let next = start + 1;
	while (tokens[next]?.value === '::' && isNameToken(tokens[next + 1])) {
		name += '::' + tokens[next + 1].value;
		next += 2;
	}
	return { name, next };
}

function isNewline(token: Token | undefined): boolean {
	return token?.kind === 'newline' || token?.value === ';';
}

function parseParams(tokens: Token[], start: number): string[] {
	if (tokens[start]?.value !== '(') {
		return [];
	}
	const params: string[] = [];
	let depth = 0;
	let segmentStart = start + 1;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.value === '(' || token.value === '[' || token.value === '{') {
			depth++;
		} else if (token.value === ')' || token.value === ']' || token.value === '}') {
			depth--;
			if (depth === 0 && token.value === ')') {
				const segment = tokens.slice(segmentStart, index);
				const candidates = segment.filter(item => isNameToken(item) || item.value === '*' || item.value === '&');
				const name = candidates.find(item => item.kind === 'identifier' || item.kind === 'variable');
				if (name) {
					params.push(name.value.replace(/^[*&]+/, ''));
				}
				break;
			}
		} else if (token.value === ',' && depth === 1) {
			const name = tokens.slice(segmentStart, index).find(item => item.kind === 'identifier' || item.kind === 'variable');
			if (name) {
				params.push(name.value);
			}
			segmentStart = index + 1;
		}
	}
	return params;
}

function parseBareParams(tokens: Token[], start: number): string[] {
	const params: string[] = [];
	let segmentStart = start;
	for (let index = start; index <= tokens.length; index++) {
		const token = tokens[index];
		if (!token || token.value === ',' || isNewline(token)) {
			const name = tokens.slice(segmentStart, index).find(candidate =>
				candidate.kind === 'identifier' || candidate.kind === 'variable');
			if (name && !params.includes(name.value)) {
				params.push(name.value);
			}
			segmentStart = index + 1;
		}
		if (!token || isNewline(token)) {
			break;
		}
	}
	return params;
}

function inferFromTokens(tokens: Token[], methodReturns: Map<string, string>): string | undefined {
	const useful = tokens.filter(token => token.kind !== 'newline');
	if (useful.length === 0) {
		return undefined;
	}
	const first = useful[0];
	if (first.kind === 'string') {
		return 'String';
	}
	if (first.kind === 'symbol') {
		return 'Symbol';
	}
	if (first.kind === 'number') {
		return first.value.includes('.') || /[eE]/.test(first.value) ? 'Float' : 'Integer';
	}
	if (first.value === '[') {
		return 'Array';
	}
	if (first.value === '{') {
		return 'Hash';
	}
	if (first.value === 'true' || first.value === 'false') {
		return 'Boolean';
	}

	let index = useful[0].value === 'self' || useful[0].value === 'self.' ? 2 : 0;
	const qualified = readQualifiedName(useful, index);
	if (qualified.name && useful[qualified.next]?.value === '.') {
		index = qualified.next + 1;
		if (useful[index]?.value === 'new') {
			return qualified.name;
		}
	}
	const callStart = useful[0]?.value === 'self' && useful[1]?.value === '.' ? 2 : 0;
	if (useful[callStart]?.kind === 'identifier') {
		const callName = useful[callStart].value;
		return methodReturns.get(callName);
	}
	return undefined;
}

function addUniqueSymbol(scope: ScopeNode, symbol: SymbolInfo): void {
	if (!scope.symbols.some(existing => existing.name === symbol.name && existing.kind === symbol.kind && existing.line === symbol.line)) {
		scope.symbols.push(symbol);
	}
}

function assignmentTarget(token: Token): SymbolKind | undefined {
	if (token.kind === 'variable') {
		return token.value.startsWith('@@') ? 'cvar' : 'ivar';
	}
	return token.kind === 'constant' ? 'constant' : token.kind === 'identifier' ? 'lvar' : undefined;
}

function isBlockBrace(tokens: Token[], index: number, lineStart: number): boolean {
	const previous = tokens[index - 1];
	if (!previous || previous.line !== tokens[index].line) {
		return false;
	}
	const significant = tokens.slice(lineStart, index).filter(token => token.kind !== 'comment' && !isNewline(token));
	if (significant.some(token => token.value === '=>') || ['=', '(', '[', ',', ':', 'return'].includes(previous.value)) {
		return false;
	}
	return previous.kind === 'identifier' || previous.value === ')' || previous.value === ']' || previous.value === '}';
}

/**
 * Performs a tolerant, dependency-free scan of Ruby source and builds its symbol
 * and lexical-scope tables. lineOffset is used for Ruby embedded in HTML.
 */
export function analyzeRubySource(filePath: string, source: string, lineOffset = 0): FileSymbolTable {
	const finalLine = source.replace(/\r\n?/g, '\n').split('\n').length + lineOffset;
	const root: ScopeNode = {
		type: 'global',
		startLine: lineOffset + 1,
		endLine: finalLine,
		symbols: [],
		children: []
	};
	const tokens = tokenize(source, lineOffset);
	const frames: ScopeFrame[] = [{ scope: root, closer: 'end', createsScope: true, openedOnLine: root.startLine }];
	const pendingComments: { line: number; text: string }[] = [];
	const methodReturns = new Map<string, string>();
	const deferred: Array<{ symbol: SymbolInfo; tokens: Token[] }> = [];
	let lineStart = 0;
	let lineHasCode = false;

	const activeScope = (): ScopeNode => {
		for (let index = frames.length - 1; index >= 0; index--) {
			if (frames[index].createsScope) {
				return frames[index].scope;
			}
		}
		return root;
	};
	const consumeComment = (line: number): string | undefined => {
		if (!pendingComments.length || pendingComments[pendingComments.length - 1].line >= line ||
			pendingComments[pendingComments.length - 1].line < line - 1) {
			return undefined;
		}
		const comment = pendingComments.map(item => item.text).join('\n');
		pendingComments.length = 0;
		return comment;
	};

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const value = token.value;

		if (token.kind === 'comment') {
			if (lineHasCode) {
				pendingComments.length = 0;
				continue;
			}
			const last = pendingComments[pendingComments.length - 1];
			if (last && last.line + 1 === token.line) {
				pendingComments.push({ line: token.line, text: token.value });
			} else {
				pendingComments.splice(0, pendingComments.length, { line: token.line, text: token.value });
			}
			continue;
		}
		if (isNewline(token)) {
			lineStart = index + 1;
			if (token.kind === 'newline') {
				lineHasCode = false;
			}
			continue;
		}
		lineHasCode = true;

		if (value === 'end') {
			pendingComments.length = 0;
			for (let frameIndex = frames.length - 1; frameIndex > 0; frameIndex--) {
				if (frames[frameIndex].closer === 'end') {
					const [frame] = frames.splice(frameIndex, 1);
					if (frame.createsScope) {
						frame.scope.endLine = token.line;
					}
					break;
				}
			}
			continue;
		}
		if (value === '}' && frames.some(frame => frame.closer === 'brace')) {
			pendingComments.length = 0;
			for (let frameIndex = frames.length - 1; frameIndex > 0; frameIndex--) {
				if (frames[frameIndex].closer === 'brace') {
					const [frame] = frames.splice(frameIndex, 1);
					if (frame.createsScope) {
						frame.scope.endLine = token.line;
					}
					break;
				}
			}
			continue;
		}

		if (token.kind === 'identifier' && (value === 'class' || value === 'module' || value === 'def')) {
			const qualifiedIndex = index + 1;
			let definition = readQualifiedName(tokens, qualifiedIndex);
			let definitionToken = tokens[qualifiedIndex];
			let params: string[] = [];
			if (value === 'def' && definitionToken?.value === 'self' && tokens[qualifiedIndex + 1]?.value === '.') {
				definitionToken = tokens[qualifiedIndex + 2];
				definition = { name: `self.${definitionToken?.value ?? ''}`, next: qualifiedIndex + 3 };
			}
			if (!isNameToken(definitionToken) || !definition.name) {
				pendingComments.length = 0;
				continue;
			}
			const scope = activeScope();
			const rawComment = consumeComment(token.line);
			let definitionName = definition.name;
			if (value === 'def' && ['?', '!'].includes(tokens[definition.next]?.value)) {
				definitionName += tokens[definition.next].value;
				definition.next++;
			}
			const symbol: SymbolInfo = {
				name: definitionName,
				kind: value === 'class' ? 'class' : value === 'module' ? 'module' : 'method',
				line: definitionToken.line,
				column: definitionToken.column,
				rawComment
			};
			if (value === 'class') {
				const lessThan = tokens.slice(definition.next).find(item => item.line > token.line || isNewline(item) || item.value === '<');
				if (lessThan?.value === '<') {
					const superIndex = tokens.indexOf(lessThan, definition.next) + 1;
					if (tokens[superIndex]) {
						symbol.superClass = readQualifiedName(tokens, superIndex).name;
					}
				}
			}
			if (value === 'def') {
				const paramsIndex = tokens.findIndex((candidate, candidateIndex) =>
					candidateIndex >= definition.next && candidate.line === token.line && candidate.value === '(');
				params = paramsIndex === -1 ? parseBareParams(tokens, definition.next) : parseParams(tokens, paramsIndex);
				symbol.params = params;
				const methodReturn = rawComment ? METHOD_RETURNS.exec(rawComment)?.[1].trim() : undefined;
				if (methodReturn) {
					methodReturns.set(definitionName.replace(/^self\./, ''), methodReturn);
				}
			}
			addUniqueSymbol(scope, symbol);
			const child: ScopeNode = {
				type: value === 'def' ? 'method' : value,
				name: definitionName,
				startLine: token.line,
				endLine: finalLine,
				symbols: [],
				children: []
			};
			scope.children.push(child);
			frames.push({ scope: child, closer: 'end', createsScope: true, openedOnLine: token.line });
			if (value === 'def') {
				for (const param of params) {
					addUniqueSymbol(child, {
						name: param,
						kind: 'param',
						line: token.line,
						column: Math.max(0, definitionToken.column + definitionToken.value.length + 1)
					});
				}
			}
			continue;
		}

		if (token.kind === 'identifier' && CONTROL_KEYWORDS.has(value)) {
			const hasPreviousCode = tokens.slice(lineStart, index).some(candidate =>
				candidate.kind !== 'comment' && candidate.kind !== 'newline');
			const previous = tokens[index - 1];
			const postfix = hasPreviousCode && previous?.value !== '=';
			if (!postfix) {
				frames.push({ scope: activeScope(), closer: 'end', createsScope: false, openedOnLine: token.line });
			}
			pendingComments.length = 0;
			continue;
		}

		if (value === 'do') {
			const controlFrame = frames[frames.length - 1];
			if (!controlFrame.createsScope && controlFrame.openedOnLine === token.line) {
				continue;
			}
			const scope = activeScope();
			const child: ScopeNode = {
				type: 'block',
				startLine: token.line,
				endLine: finalLine,
				symbols: [],
				children: []
			};
			scope.children.push(child);
			frames.push({ scope: child, closer: 'end', createsScope: true, openedOnLine: token.line });
			pendingComments.length = 0;
			continue;
		}

		if (value === '{') {
			const scope = activeScope();
			if (isBlockBrace(tokens, index, lineStart)) {
				const child: ScopeNode = {
					type: 'block',
					startLine: token.line,
					endLine: finalLine,
					symbols: [],
					children: []
				};
				scope.children.push(child);
				frames.push({ scope: child, closer: 'brace', createsScope: true, openedOnLine: token.line });
			} else {
				frames.push({ scope, closer: 'brace', createsScope: false, openedOnLine: token.line });
			}
			continue;
		}

		if (token.value === '|' && tokens[index - 1]?.line === token.line && frames[frames.length - 1]?.scope.type === 'block') {
			let end = index + 1;
			while (end < tokens.length && tokens[end].value !== '|' && !isNewline(tokens[end])) {
				const candidate = tokens[end++];
				if (candidate.kind === 'identifier' || candidate.kind === 'variable') {
					addUniqueSymbol(frames[frames.length - 1].scope, {
						name: candidate.value,
						kind: 'param',
						line: candidate.line,
						column: candidate.column
					});
				}
			}
		}

		const kind = assignmentTarget(token);
		if (kind && tokens[index + 1]?.value === '=') {
			const scope = activeScope();
			let end = index + 2;
			let bracketDepth = 0;
			while (end < tokens.length && (bracketDepth > 0 || !isNewline(tokens[end]))) {
				const candidate = tokens[end++];
				if (['(', '[', '{'].includes(candidate.value)) {
					bracketDepth++;
				} else if ([')', ']', '}'].includes(candidate.value)) {
					bracketDepth--;
				}
			}
			const symbol: SymbolInfo = {
				name: token.value,
				kind,
				line: token.line,
				column: token.column,
				inferredType: inferFromTokens(tokens.slice(index + 2, end), methodReturns),
				rawComment: kind === 'constant' ? consumeComment(token.line) : undefined
			};
			if (kind !== 'constant') {
				pendingComments.length = 0;
			}
			addUniqueSymbol(scope, symbol);
			deferred.push({ symbol, tokens: tokens.slice(index + 2, end) });
		} else if (kind === undefined && token.kind !== 'newline') {
			consumeComment(token.line);
		}
	}

	for (const item of deferred) {
		item.symbol.inferredType ??= inferFromTokens(item.tokens, methodReturns);
	}
	for (let index = frames.length - 1; index > 0; index--) {
		if (frames[index].createsScope) {
			frames[index].scope.endLine = finalLine;
		}
	}
	return { filePath, rootScope: root };
}

/** Builds one symbol table from every Ruby script embedded in an HTML document. */
export function analyzeHtmlRubySource(filePath: string, source: string): FileSymbolTable {
	const finalLine = source.replace(/\r\n?/g, '\n').split('\n').length;
	const combined: FileSymbolTable = {
		filePath,
		rootScope: {
			type: 'global',
			startLine: 1,
			endLine: finalLine,
			symbols: [],
			children: []
		}
	};
	const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = scriptPattern.exec(source))) {
		const attributes = match[1];
		const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
		if ((type?.[1] ?? type?.[2] ?? type?.[3])?.trim().toLowerCase() !== 'text/ruby') {
			continue;
		}
		const bodyOffset = match.index + match[0].indexOf(match[2]);
		const lineOffset = source.slice(0, bodyOffset).replace(/\r\n?/g, '\n').split('\n').length - 1;
		const table = analyzeRubySource(filePath, match[2], lineOffset);
		combined.rootScope.symbols.push(...table.rootScope.symbols);
		combined.rootScope.children.push(...table.rootScope.children);
	}
	return combined;
}
