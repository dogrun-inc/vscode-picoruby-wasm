import * as assert from 'assert';
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HoverDefinitionIndex } from '../hoverDefinitionIndex';
import { collectVfsFiles } from '../vfsCollector';

suite('Hover definition index', () => {
	test('shares scans and cancels individual requests without cancelling other waiters', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-index-'));
		const target = path.join(directory, 'index.html');
		const first = new vscode.CancellationTokenSource();
		const second = new vscode.CancellationTokenSource();
		let scans = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const index = new HoverDefinitionIndex(target, async () => {
			scans++;
			await gate;
			return { 'helper.rb': '# Project docs\ndef example_method\nend' };
		});
		try {
			const cancelled = index.find('example_method', target, first.token);
			const pending = index.find('example_method', target, second.token);
			first.cancel();
			assert.strictEqual(await cancelled, undefined);
			release!();
			assert.strictEqual((await pending)?.description, 'Project docs');
			assert.strictEqual((await index.find('example_method', target, second.token))?.description, 'Project docs');
			assert.strictEqual(scans, 1);
		} finally {
			first.dispose();
			second.dispose();
			index.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('stops a scan when its last waiter cancels and retries on the next request', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-index-'));
		const target = path.join(directory, 'index.html');
		const first = new vscode.CancellationTokenSource();
		const second = new vscode.CancellationTokenSource();
		let scans = 0;
		let aborted = false;
		const index = new HoverDefinitionIndex(target, async (_file, signal) => {
			scans++;
			if (scans > 1) { return { 'helper.rb': '# Retry\ndef example_method\nend' }; }
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => {
					aborted = true;
					reject(signal.reason);
				}, { once: true });
			});
		});
		try {
			const pending = index.find('example_method', target, first.token);
			first.cancel();
			assert.strictEqual(await pending, undefined);
			assert.ok(aborted);
			assert.strictEqual((await index.find('example_method', target, second.token))?.description, 'Retry');
			assert.strictEqual(scans, 2);
		} finally {
			first.dispose();
			second.dispose();
			index.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('restarts an initial scan if a file changes before the scan completes', async function () {
		this.timeout(10000);
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-index-'));
		const target = path.join(directory, 'index.html');
		const helper = path.join(directory, 'helper.rb');
		const token = new vscode.CancellationTokenSource();
		let scans = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		writeFileSync(helper, '# Original\ndef example_method\nend');
		const index = new HoverDefinitionIndex(target, async (file, signal) => {
			const files = await collectVfsFiles(file, signal);
			if (++scans === 1) { await gate; }
			return files;
		});
		const observer = watch(directory, { recursive: true });
		try {
			const pending = index.find('example_method', target, token.token);
			while (scans === 0) { await new Promise(resolve => setTimeout(resolve, 10)); }
			const changed = new Promise<void>(resolve => observer.once('change', () => resolve()));
			writeFileSync(helper, '# Updated\ndef example_method\nend');
			await changed;
			await new Promise(resolve => setTimeout(resolve, 50));
			release!();
			assert.strictEqual((await pending)?.description, 'Updated');
			assert.strictEqual(scans, 2);
		} finally {
			release?.();
			token.dispose();
			observer.close();
			index.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('refreshes changed Ruby files and uses unsaved editor content', async function () {
		this.timeout(20000);
		const directory = mkdtempSync(path.join(os.tmpdir(), 'picoruby-index-'));
		const target = path.join(directory, 'index.html');
		const helper = path.join(directory, 'helper.rb');
		const token = new vscode.CancellationTokenSource();
		let scans = 0;
		writeFileSync(helper, '# Original\ndef example_method\nend');
		const index = new HoverDefinitionIndex(target, async (file, signal) => {
			scans++;
			return collectVfsFiles(file, signal);
		});
		try {
			assert.strictEqual((await index.find('example_method', target, token.token))?.description, 'Original');
			writeFileSync(helper, '# Changed\ndef example_method\nend');
			const deadline = Date.now() + 10000;
			while ((await index.find('example_method', target, token.token))?.description !== 'Changed') {
				if (Date.now() > deadline) { assert.fail('File change was not reflected in the index'); }
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			assert.strictEqual(scans, 1);

			const added = path.join(directory, 'added.rb');
			writeFileSync(added, '# Added\ndef new_method\nend');
			while (!(await index.find('new_method', target, token.token))) {
				if (Date.now() > deadline) { assert.fail('New file was not reflected in the index'); }
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			rmSync(added);
			while (await index.find('new_method', target, token.token)) {
				if (Date.now() > deadline) { assert.fail('Deleted file was not removed from the index'); }
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			assert.strictEqual(scans, 1);

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(helper));
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
				'# Unsaved\ndef example_method\nend');
			assert.ok(await vscode.workspace.applyEdit(edit));
			assert.strictEqual((await index.find('example_method', target, token.token))?.description, 'Unsaved');
			assert.strictEqual(scans, 1);
		} finally {
			token.dispose();
			index.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
