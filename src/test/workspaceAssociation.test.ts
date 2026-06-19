import * as assert from 'assert';

import {
	resolveAssociationContext,
	withPicoRubyAssociation,
	withoutPicoRubyAssociation
} from '../language/workspaceAssociation';

suite('workspaceAssociation helpers', () => {
	test('resolveAssociationContext uses Workspace for multi-root workspace file', () => {
		const result = resolveAssociationContext(
			{
				workspaceValue: { '*.rb': 'picoruby' },
				workspaceFolderValue: { '*.rb': 'ruby' }
			},
			true,
			true
		);

		assert.strictEqual(result.target, 'workspace');
		assert.deepStrictEqual(result.associations, { '*.rb': 'picoruby' });
	});

	test('resolveAssociationContext uses WorkspaceFolder for single-folder workspace', () => {
		const result = resolveAssociationContext(
			{
				workspaceValue: { '*.rb': 'ruby' },
				workspaceFolderValue: { '*.rb': 'picoruby', '*.rake': 'ruby' }
			},
			false,
			true
		);

		assert.strictEqual(result.target, 'workspaceFolder');
		assert.deepStrictEqual(result.associations, {
			'*.rb': 'picoruby',
			'*.rake': 'ruby'
		});
	});

	test('withPicoRubyAssociation merges while preserving existing keys', () => {
		const result = withPicoRubyAssociation({ '*.rake': 'ruby' });

		assert.deepStrictEqual(result, {
			'*.rake': 'ruby',
			'*.rb': 'picoruby'
		});
	});

	test('withoutPicoRubyAssociation removes only *.rb mapping', () => {
		const result = withoutPicoRubyAssociation({ '*.rb': 'picoruby', '*.rake': 'ruby' });

		assert.deepStrictEqual(result, { '*.rake': 'ruby' });
	});

	test('withoutPicoRubyAssociation returns undefined when no mapping remains', () => {
		const result = withoutPicoRubyAssociation({ '*.rb': 'picoruby' });

		assert.strictEqual(result, undefined);
	});
});
