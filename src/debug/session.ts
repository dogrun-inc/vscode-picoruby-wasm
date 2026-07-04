import * as vscode from 'vscode';
import * as path from 'path';
import {
	InitializedEvent,
	LoggingDebugSession,
	OutputEvent,
	StoppedEvent,
	TerminatedEvent
} from '@vscode/debugadapter';
import { PicoRubyWasmRuntimeClient } from './wasmRuntimeClient';

interface PicoRubyWasmInitializeResponseBody {
	supportsConfigurationDoneRequest: boolean;
	supportsEvaluateForHovers: boolean;
	supportsStepInTargetsRequest: boolean;
	supportsSetVariable: boolean;
	supportsTerminateRequest: boolean;
	supportsRestartRequest: boolean;
	supportsSingleThreadExecutionRequests: boolean;
	completionTriggerCharacters: string[];
}

interface PicoRubyWasmThread {
	id: number;
	name: string;
}

interface PicoRubyWasmStackFrame {
	id: number;
	name: string;
	line: number;
	column: number;
	source: {
		name: string;
		path: string;
	};
}

interface PicoRubyWasmScope {
	name: string;
	variablesReference: number;
	expensive: boolean;
}

interface PicoRubyWasmVariable {
	name: string;
	value: string;
	variablesReference: number;
}

export interface PicoRubyWasmLaunchArguments {
	program?: string;
	args?: string[];
	cwd?: string;
	stopOnEntry?: boolean;
}

class PicoRubyWasmMockSessionState {
	private readonly runtimeClient = new PicoRubyWasmRuntimeClient();
	private stopped = false;
	private activeProgram = path.resolve(process.cwd(), 'index.html');

	createInitializeBody(): PicoRubyWasmInitializeResponseBody {
		return {
			supportsConfigurationDoneRequest: true,
			supportsEvaluateForHovers: true,
			supportsStepInTargetsRequest: false,
			supportsSetVariable: false,
			supportsTerminateRequest: true,
			supportsRestartRequest: false,
			supportsSingleThreadExecutionRequests: false,
			completionTriggerCharacters: ['.', ':']
		};
	}

	async launch(args: PicoRubyWasmLaunchArguments): Promise<{ output: string }> {
		this.activeProgram = this.resolveProgramPath(args.program, args.cwd);
		const result = await this.runtimeClient.launch(args);
		const outputEvent = result.events.find((event) => event.type === 'output');

		return {
			output:
				typeof outputEvent?.body?.output === 'string'
					? outputEvent.body.output
					: '[picoruby-wasm] mock runtime connected\n'
		};
	}

	markStopped(): boolean {
		if (this.stopped) {
			return false;
		}

		this.stopped = true;
		return true;
	}

	reset(): Promise<void> {
		this.stopped = false;
		return this.runtimeClient.stop();
	}

	createThreads(): PicoRubyWasmThread[] {
		return [{ id: 1, name: 'Mock PicoRuby thread' }];
	}

	createStackFrames(): PicoRubyWasmStackFrame[] {
		return [
			{
				id: 1,
				name: 'mock main',
				line: 1,
				column: 1,
				source: {
					name: 'index.html',
					path: this.activeProgram
				}
			}
		];
	}

	createScopes(): PicoRubyWasmScope[] {
		return [{ name: 'Locals', variablesReference: 1, expensive: false }];
	}

	createVariables(): PicoRubyWasmVariable[] {
		return [];
	}

	createBreakpoints(request: { breakpoints?: Array<{ line?: number; column?: number }> }): Array<{
		id: number;
		verified: boolean;
		line: number;
		column: number;
	}> {
		return (request.breakpoints ?? []).map((breakpoint, index) => ({
			id: index + 1,
			verified: true,
			line: breakpoint.line ?? 1,
			column: breakpoint.column ?? 1
		}));
	}

	createEvaluationResult(): { result: string; variablesReference: number } {
		return {
			result: 'mock-evaluation',
			variablesReference: 0
		};
	}

	private resolveProgramPath(program: string | undefined, cwd: string | undefined): string {
		const root = cwd ?? process.cwd();
		const fallback = path.resolve(root, 'index.html');

		if (!program) {
			return fallback;
		}

		if (path.isAbsolute(program)) {
			return program;
		}

		if (program.includes('${workspaceFolder}')) {
			return path.resolve(root, program.replace('${workspaceFolder}', '.'));
		}

		return path.resolve(root, program);
	}
}

export class PicoRubyWasmLoggingDebugSession extends LoggingDebugSession {
	private readonly state = new PicoRubyWasmMockSessionState();

	protected initializeRequest(response: any): void {
		response.body = this.state.createInitializeBody();
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	protected launchRequest(response: any, args: any): void {
		void this.state.launch(args).then((launchResult) => {
			this.sendResponse(response);
			this.sendEvent(new OutputEvent(launchResult.output, 'console'));
		});
	}

	protected configurationDoneRequest(response: any): void {
		this.sendResponse(response);

		if (this.state.markStopped()) {
			this.sendEvent(new StoppedEvent('entry', 1));
		}
	}

	protected threadsRequest(response: any): void {
		response.body = { threads: this.state.createThreads() };
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: any): void {
		response.body = {
			stackFrames: this.state.createStackFrames(),
			totalFrames: 1
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: any): void {
		response.body = { scopes: this.state.createScopes() };
		this.sendResponse(response);
	}

	protected variablesRequest(response: any): void {
		response.body = { variables: this.state.createVariables() };
		this.sendResponse(response);
	}

	protected setBreakpointsRequest(response: any, args: { breakpoints?: Array<{ line?: number; column?: number }> }): void {
		response.body = {
			breakpoints: this.state.createBreakpoints(args)
		};
		this.sendResponse(response);
	}

	protected evaluateRequest(response: any): void {
		response.body = this.state.createEvaluationResult();
		this.sendResponse(response);
	}

	protected disconnectRequest(response: any): void {
		void this.state.reset();
		this.sendEvent(new TerminatedEvent());
		this.sendResponse(response);
	}
}

class PicoRubyWasmInlineDebugAdapter implements vscode.DebugAdapter {
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	private readonly state = new PicoRubyWasmMockSessionState();
	private nextSeq = 1;

	readonly onDidSendMessage = this.emitter.event;

	dispose(): void {
		void this.state.reset();
		this.emitter.dispose();
	}

	handleMessage(message: any): void {
		void this.handleMessageAsync(message).catch((error: unknown) => {
			this.emit({
				type: 'response',
				seq: this.nextMessageSeq(),
				request_seq: message.seq,
				success: false,
				command: message.command,
				message: error instanceof Error ? error.message : 'Unhandled debug adapter error'
			});
		});
	}

	private async handleMessageAsync(message: any): Promise<void> {
		if (message?.type !== 'request') {
			return;
		}

		switch (message.command) {
			case 'initialize':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'initialize',
					body: this.state.createInitializeBody()
				});
				this.emit({ type: 'event', seq: this.nextMessageSeq(), event: 'initialized' });
				return;
			case 'launch': {
				const launchResult = await this.state.launch(message.arguments ?? {});
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'launch'
				});
				this.emit({
					type: 'event',
					seq: this.nextMessageSeq(),
					event: 'output',
					body: { category: 'console', output: launchResult.output }
				});
				return;
			}
			case 'configurationDone':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'configurationDone'
				});
				if (this.state.markStopped()) {
					this.emit({
						type: 'event',
						seq: this.nextMessageSeq(),
						event: 'stopped',
						body: { reason: 'entry', threadId: 1, allThreadsStopped: true }
					});
				}
				return;
			case 'threads':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'threads',
					body: { threads: this.state.createThreads() }
				});
				return;
			case 'stackTrace':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'stackTrace',
					body: { stackFrames: this.state.createStackFrames(), totalFrames: 1 }
				});
				return;
			case 'scopes':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'scopes',
					body: { scopes: this.state.createScopes() }
				});
				return;
			case 'variables':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'variables',
					body: { variables: this.state.createVariables() }
				});
				return;
			case 'setBreakpoints':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'setBreakpoints',
					body: { breakpoints: this.state.createBreakpoints(message.arguments ?? {}) }
				});
				return;
			case 'evaluate':
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'evaluate',
					body: this.state.createEvaluationResult()
				});
				return;
			case 'disconnect':
				void this.state.reset();
				this.emit({ type: 'event', seq: this.nextMessageSeq(), event: 'terminated' });
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'disconnect'
				});
				return;
			default:
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: message.command
				});
		}
	}

	private emit(message: any): void {
		this.emitter.fire(message);
	}

	private nextMessageSeq(): number {
		return this.nextSeq++;
	}
}

export function createPicoRubyWasmInlineDebugAdapter(): vscode.DebugAdapter {
	return new PicoRubyWasmInlineDebugAdapter();
}
