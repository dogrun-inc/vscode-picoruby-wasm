import * as assert from 'assert';

import { createPicoRubyWasmInlineDebugAdapter } from '../debug/session';

type DebugMessage = {
	type: 'response' | 'event';
	command?: string;
	event?: string;
	success?: boolean;
	body?: any;
};

function collectMessages(command: string, args?: any): DebugMessage[] {
	const adapter = createPicoRubyWasmInlineDebugAdapter();
	const messages: DebugMessage[] = [];
	const subscription = adapter.onDidSendMessage((message) => {
		messages.push(message as DebugMessage);
	});

	adapter.handleMessage({
		type: 'request',
		seq: 1,
		command,
		arguments: args
	});

	subscription.dispose();
	return messages;
}

suite('debug session adapter', () => {
	test('initialize advertises the current adapter capabilities', () => {
		const messages = collectMessages('initialize');

		assert.strictEqual(messages.length, 2);
		assert.strictEqual(messages[0].type, 'response');
		assert.strictEqual(messages[0].command, 'initialize');
		assert.deepStrictEqual(messages[0].body, {
			supportsConfigurationDoneRequest: true,
			supportsEvaluateForHovers: true,
			supportsStepInTargetsRequest: false,
			supportsSetVariable: false,
			supportsTerminateRequest: true,
			supportsRestartRequest: false,
			supportsSingleThreadExecutionRequests: false,
			completionTriggerCharacters: ['.', ':']
		});
		assert.strictEqual(messages[1].type, 'event');
		assert.strictEqual(messages[1].event, 'initialized');
	});

	test('continue, next, and stepIn requests return success responses', () => {
		const continueMessages = collectMessages('continue');
		assert.strictEqual(continueMessages.length, 2);
		assert.strictEqual(continueMessages[0].type, 'event');
		assert.strictEqual(continueMessages[0].event, 'output');
		assert.ok(
			typeof continueMessages[0].body?.output === 'string' &&
			continueMessages[0].body.output.includes("dropped 'continue' command")
		);
		assert.strictEqual(continueMessages[1].type, 'response');
		assert.strictEqual(continueMessages[1].command, 'continue');
		assert.strictEqual(continueMessages[1].success, true);
		assert.deepStrictEqual(continueMessages[1].body, { allThreadsContinued: true });

		const nextMessages = collectMessages('next');
		assert.strictEqual(nextMessages.length, 2);
		assert.strictEqual(nextMessages[0].type, 'event');
		assert.strictEqual(nextMessages[0].event, 'output');
		assert.ok(
			typeof nextMessages[0].body?.output === 'string' &&
			nextMessages[0].body.output.includes("dropped 'next' command")
		);
		assert.strictEqual(nextMessages[1].type, 'response');
		assert.strictEqual(nextMessages[1].command, 'next');
		assert.strictEqual(nextMessages[1].success, true);
		assert.strictEqual(nextMessages[1].body, undefined);

		const stepInMessages = collectMessages('stepIn');
		assert.strictEqual(stepInMessages.length, 2);
		assert.strictEqual(stepInMessages[0].type, 'event');
		assert.strictEqual(stepInMessages[0].event, 'output');
		assert.ok(
			typeof stepInMessages[0].body?.output === 'string' &&
			stepInMessages[0].body.output.includes("dropped 'stepIn' command")
		);
		assert.strictEqual(stepInMessages[1].type, 'response');
		assert.strictEqual(stepInMessages[1].command, 'stepIn');
		assert.strictEqual(stepInMessages[1].success, true);
		assert.strictEqual(stepInMessages[1].body, undefined);
	});

	test('terminate and disconnect emit a terminated event before responding', () => {
		for (const command of ['terminate', 'disconnect'] as const) {
			const messages = collectMessages(command);

			assert.strictEqual(messages.length, 2, `${command} should emit exactly one event and one response`);
			assert.strictEqual(messages[0].type, 'event');
			assert.strictEqual(messages[0].event, 'terminated');
			assert.strictEqual(messages[1].type, 'response');
			assert.strictEqual(messages[1].command, command);
			assert.strictEqual(messages[1].success, true);
		}
	});
});
