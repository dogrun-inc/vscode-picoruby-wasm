import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectVfsFiles } from '../vfsCollector';

suite('vfs collector', () => {
	test('collects Ruby files below the target HTML directory with POSIX relative paths', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-vfs-'));
		const nestedDirectory = path.join(directory, 'lib', 'nested');
		const htmlPath = path.join(directory, 'index.html');

		try {
			mkdirSync(nestedDirectory, { recursive: true });
			writeFileSync(htmlPath, '<script type="text/ruby">require "main"</script>');
			writeFileSync(path.join(directory, 'main.rb'), 'require "lib/helper"\n');
			writeFileSync(path.join(directory, 'lib', 'helper.rb'), 'VALUE = 1\n');
			writeFileSync(path.join(nestedDirectory, 'deep.rb'), 'DEEP = true\n');
			writeFileSync(path.join(directory, 'ignore.txt'), 'ignored');

			assert.deepStrictEqual(await collectVfsFiles(htmlPath), {
				'main.rb': 'require "lib/helper"\n',
				'lib/helper.rb': 'VALUE = 1\n',
				'lib/nested/deep.rb': 'DEEP = true\n'
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});