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

async function collectMessagesAsync(
	command: string,
	args?: any,
	adapter = createPicoRubyWasmInlineDebugAdapter()
): Promise<DebugMessage[]> {
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

	await new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error(`Timed out waiting for response: ${command}`));
		}, 2000);

		const poll = () => {
			if (messages.some((message) => message.type === 'response' && message.command === command)) {
				clearTimeout(timeoutId);
				resolve();
				return;
			}
			setTimeout(poll, 5);
		};

		poll();
	});

	subscription.dispose();
	adapter.dispose();
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

	test('terminate followed by disconnect only emits terminated once', () => {
		const adapter = createPicoRubyWasmInlineDebugAdapter();
		const messages: DebugMessage[] = [];
		const subscription = adapter.onDidSendMessage((message) => {
			messages.push(message as DebugMessage);
		});

		adapter.handleMessage({
			type: 'request',
			seq: 1,
			command: 'terminate'
		});
		adapter.handleMessage({
			type: 'request',
			seq: 2,
			command: 'disconnect'
		});

		subscription.dispose();

		const terminatedEvents = messages.filter((message) => message.type === 'event' && message.event === 'terminated');
		assert.strictEqual(terminatedEvents.length, 1);
		assert.deepStrictEqual(
			messages.map((message) => message.type === 'event' ? message.event : message.command),
			['terminated', 'terminate', 'disconnect']
		);
	});

	test('scopes returns Locals and Globals entries', async () => {
		const messages = await collectMessagesAsync('scopes', { frameId: 1 });
		const response = messages.find((message) => message.type === 'response' && message.command === 'scopes');

		assert.ok(response);
		assert.strictEqual(response.success, true);
		assert.deepStrictEqual(response.body?.scopes, [
			{ name: 'Locals', variablesReference: 1, expensive: false },
			{ name: 'Globals', variablesReference: 2, expensive: true }
		]);
	});

	test('variables applies local/global filtering rules from webview payload', async () => {
		const localsAdapter = createPicoRubyWasmInlineDebugAdapter() as any;
		localsAdapter.state.requestFromWebview = async (type: string) => {
			assert.strictEqual(type, 'getLocals');
			return {
				visible: 'ok',
				__hidden_local: 'skip',
				count: 3
			};
		};

		const localsMessages = await collectMessagesAsync('variables', { variablesReference: 1 }, localsAdapter);
		const localsResponse = localsMessages.find((message) => message.type === 'response' && message.command === 'variables');

		assert.ok(localsResponse);
		assert.deepStrictEqual(localsResponse.body?.variables, [
			{ name: 'visible', value: 'ok', variablesReference: 0 },
			{ name: 'count', value: '3', variablesReference: 0 }
		]);

		const globalsAdapter = createPicoRubyWasmInlineDebugAdapter() as any;
		globalsAdapter.state.requestFromWebview = async (type: string) => {
			assert.strictEqual(type, 'getGlobals');
			return {
				'$stdout': 'STDOUT',
				'$stdin': 'STDIN',
				'$__internal': 'skip',
				'$_last': 'skip',
				'$promise_1': 'skip',
				'$LOADED_FEATURES': 'skip',
				'$user': 42
			};
		};

		const globalsMessages = await collectMessagesAsync('variables', { variablesReference: 2 }, globalsAdapter);
		const globalsResponse = globalsMessages.find((message) => message.type === 'response' && message.command === 'variables');

		assert.ok(globalsResponse);
		assert.deepStrictEqual(globalsResponse.body?.variables, [
			{ name: '$stdout', value: 'STDOUT', variablesReference: 0 },
			{ name: '$stdin', value: 'STDIN', variablesReference: 0 },
			{ name: '$user', value: '42', variablesReference: 0 }
		]);
	});
});
