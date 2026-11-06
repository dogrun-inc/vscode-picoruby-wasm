import { parseRubyDoc } from './docParser';

export interface UserDefinition {
	name: string;
	signature: string;
	description: string;
}

/** Extracts contiguous comment lines immediately preceding Ruby definitions. */
export function extractComments(source: string): UserDefinition[] {
	const definitions: UserDefinition[] = [];
	let comments: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const comment = /^\s*# ?(.*)$/.exec(line);
		if (comment) {
			comments.push(comment[1]);
			continue;
		}
		const definition = /^\s*(?:class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)|^\s*def\s+((?:(?:self|[A-Z]\w*(?:::[A-Z]\w*)*)\.)?[a-zA-Z_]\w*[!?=]?)/.exec(line);
		if (definition) {
			definitions.push({ name: definition[1] ?? definition[2], signature: line.trim(), description: parseRubyDoc(comments.join('\n')) });
		}
		comments = [];
	}
	return definitions;
}
