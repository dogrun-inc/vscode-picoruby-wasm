import * as assert from 'assert';

import {
	withPicoRubyAssociation,
	withoutPicoRubyAssociation
} from '../language/workspaceAssociation';

suite('workspaceAssociation helpers', () => {
	// withPicoRubyAssociation
	test('withPicoRubyAssociation adds *.rb mapping to empty associations', () => {
		const result = withPicoRubyAssociation({});

		assert.deepStrictEqual(result, { '*.rb': 'picoruby' });
	});

	test('withPicoRubyAssociation merges while preserving existing keys', () => {
		const result = withPicoRubyAssociation({ '*.rake': 'ruby' });

		assert.deepStrictEqual(result, {
			'*.rake': 'ruby',
			'*.rb': 'picoruby'
		});
	});

	test('withPicoRubyAssociation does not mutate the original object', () => {
		const original = { '*.rake': 'ruby' };
		withPicoRubyAssociation(original);

		assert.deepStrictEqual(original, { '*.rake': 'ruby' });
	});

	// withoutPicoRubyAssociation
	test('withoutPicoRubyAssociation removes only *.rb mapping', () => {
		const result = withoutPicoRubyAssociation({ '*.rb': 'picoruby', '*.rake': 'ruby' });

		assert.deepStrictEqual(result, { '*.rake': 'ruby' });
	});

	test('withoutPicoRubyAssociation returns undefined when no mapping remains', () => {
		const result = withoutPicoRubyAssociation({ '*.rb': 'picoruby' });

		assert.strictEqual(result, undefined);
	});

	test('withoutPicoRubyAssociation does not mutate the original object', () => {
		const original = { '*.rb': 'picoruby', '*.rake': 'ruby' };
		withoutPicoRubyAssociation(original);

		assert.deepStrictEqual(original, { '*.rb': 'picoruby', '*.rake': 'ruby' });
	});
});
