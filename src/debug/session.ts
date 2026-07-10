import * as vscode from 'vscode';
import * as path from 'path';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'crypto';
import {
	InitializedEvent,
	LoggingDebugSession,
	OutputEvent,
	StoppedEvent,
	TerminatedEvent
} from '@vscode/debugadapter';
import { PicoRubyWasmRuntimeClient } from './wasmRuntimeClient';

/**
 * viewType used to identify the WebView panel.
 * VS Code uses this key to manage panels of the same kind.
 */
const WEBVIEW_VIEW_TYPE = 'picoruby-wasm.webview';

/**
 * Stores the extension context received during activation.
 * This is used by the debug session to resolve extension resource URIs for the WebView.
 */
let extensionContext: vscode.ExtensionContext | undefined;

/**
 * Sets the extension context referenced by debug sessions.
 *
 * @param context VS Code ExtensionContext provided when the extension activates.
 */
export function setPicoRubyWasmExtensionContext(context: vscode.ExtensionContext): void {
	extensionContext = context;
}

/**
 * Describes capability flags returned in the DAP initialize response body.
 */
interface PicoRubyWasmInitializeResponseBody {
	/** Whether configurationDone requests are supported. */
	supportsConfigurationDoneRequest: boolean;
	/** Whether evaluate-for-hover is supported. */
	supportsEvaluateForHovers: boolean;
	/** Whether stepInTargets requests are supported. */
	supportsStepInTargetsRequest: boolean;
	/** Whether variable mutation is supported. */
	supportsSetVariable: boolean;
	/** Whether terminate requests are supported. */
	supportsTerminateRequest: boolean;
	/** Whether restart requests are supported. */
	supportsRestartRequest: boolean;
	/** Whether single-thread execution requests are supported. */
	supportsSingleThreadExecutionRequests: boolean;
	/** Completion trigger characters. */
	completionTriggerCharacters: string[];
}

/**
 * Thread entry returned by the DAP threads response.
 */
interface PicoRubyWasmThread {
	/** Thread identifier. */
	id: number;
	/** Display name. */
	name: string;
}

/**
 * Stack frame entry returned by the DAP stackTrace response.
 */
interface PicoRubyWasmStackFrame {
	/** Frame identifier. */
	id: number;
	/** Frame label. */
	name: string;
	/** 1-based line number. */
	line: number;
	/** 1-based column number. */
	column: number;
	/** Source metadata for this frame. */
	source: {
		/** Display name for the source. */
		name: string;
		/** Absolute source path. */
		path: string;
	};
}

/**
 * Scope entry returned by the DAP scopes response.
 */
interface PicoRubyWasmScope {
	/** Scope label. */
	name: string;
	/** Variable reference id. A non-zero value can be expanded by the client. */
	variablesReference: number;
	/** Whether this scope is considered expensive to evaluate. */
	expensive: boolean;
}

/**
 * Variable entry returned by the DAP variables response.
 */
interface PicoRubyWasmVariable {
	/** Variable name. */
	name: string;
	/** Rendered value string. */
	value: string;
	/** Child reference id. Zero means no children. */
	variablesReference: number;
}

/**
 * Returns the extension root URI.
 * This is required to resolve WebView resources when a debug session starts.
 *
 * @returns The extensionUri from the extension context.
 * @throws If setPicoRubyWasmExtensionContext has not been called yet.
 */
function getExtensionUri(): vscode.Uri {
	if (!extensionContext) {
		throw new Error('PicoRuby WASM extension context is not initialized.');
	}

	return extensionContext.extensionUri;
}

/**
 * Generates a CSP nonce.
 *
 * @returns A random 16-byte hex string for script nonce attributes.
 */
function getNonce(): string {
	return randomBytes(16).toString('hex');
}

/**
 * Formats WebView-originated logs for the Debug Console.
 *
 * @param text Raw log text received from the WebView.
 * @returns Log text with a prefix and trailing newline.
 */
function formatWebviewLogOutput(text: string): string {
	return `[webview] ${text.endsWith('\n') ? text : `${text}\n`}`;
}

/**
 * Builds the HTML content for the WebView.
 *
 * @param webview Target WebView instance that will host the HTML.
 * @returns HTML that loads PicoRuby WASM and includes the log forwarding bridge.
 */
function createPicoRubyWasmWebviewHtml(webview: vscode.Webview): string {
	return createPicoRubyWasmWebviewHtmlWithExtensionUri(webview, getExtensionUri());
}

/**
 * Builds WebView HTML using a provided extension URI.
 * This helper is separated so tests can inject a fixed URI and verify HTML fragments.
 *
 * @param webview VS Code WebView instance.
 * @param extensionUri Extension root URI.
 * @returns Full HTML string for the WebView.
 */
function createPicoRubyWasmWebviewHtmlWithExtensionUri(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'picoruby.js'));
	const nonce = getNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; connect-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>PicoRuby WASM</title>
</head>
<body>
	<h1>PicoRuby WASM</h1>
	<p>Initializing WebView.</p>
	<script type="module" nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const stringifyLogValue = (value) => {
			if (typeof value === 'string') {
				return value;
			}

			try {
				const json = JSON.stringify(value);
				return typeof json === 'string' ? json : String(value);
			} catch {
				return String(value);
			}
		};

		const forwardLogMessage = (text) => {
			vscode.postMessage({ type: 'log', text });
		};

		const originalConsoleLog = console.log.bind(console);
		console.log = (...args) => {
			originalConsoleLog(...args);
			forwardLogMessage(args.map(stringifyLogValue).join(' '));
		};

		const originalConsoleError = console.error.bind(console);
		console.error = (...args) => {
			originalConsoleError(...args);
			forwardLogMessage(args.map(stringifyLogValue).join(' '));
		};

		const moduleReady = import('${scriptUri}')
			.then(({ default: Module }) => Module())
			.then((instance) => {
				console.log('PicoRuby WASM in WebView Loaded!');
				vscode.postMessage({ type: 'ready' });
				return instance;
			})
			.catch((error) => {
				console.error('Failed to load PicoRuby WASM in WebView', error);
				throw error;
			});

		window.addEventListener('message', async (event) => {
			const data = event.data;

			if (data?.type !== 'start') {
				return;
			}

			const instance = await moduleReady;
			const receivedCode = typeof data.code === 'string' ? data.code : String(data.code ?? '');
			console.log('Received start command from VS Code.');
			console.log(receivedCode);
			// TODO: ここでPicoRubyにコードを渡して実行
			void instance;
		});
	</script>
</body>
</html>`;
}

/**
 * Public test hook to call WebView HTML generation directly from unit tests.
 */
export const picoRubyWasmWebviewTestHooks = {
	createPicoRubyWasmWebviewHtmlWithExtensionUri
};

/**
 * Creates a WebView panel used to run PicoRuby WASM.
 *
 * @returns A WebView panel with script execution enabled.
 */
function createPicoRubyWasmWebviewPanel(): vscode.WebviewPanel {
	const extensionUri = getExtensionUri();
	const panel = vscode.window.createWebviewPanel(
		WEBVIEW_VIEW_TYPE,
		'PicoRuby WASM',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')]
		}
	);

	panel.webview.html = createPicoRubyWasmWebviewHtml(panel.webview);
	return panel;
}

/**
 * Arguments for the debug launch request.
 */
export interface PicoRubyWasmLaunchArguments {
	/** Program path to run. Relative paths and ${workspaceFolder} are supported. */
	program?: string;
	/** Arguments forwarded to the runtime. */
	args?: string[];
	/** Working directory used for relative path resolution. */
	cwd?: string;
	/** Whether to emit a stop event immediately after launch. */
	stopOnEntry?: boolean;
}

/**
 * Centralized state container and mock data factory for the debug session.
 * Shared by both the LoggingDebugSession-based implementation and the inline adapter.
 */
class PicoRubyWasmMockSessionState {
	/** Client that simulates PicoRuby WASM runtime connectivity. */
	private readonly runtimeClient = new PicoRubyWasmRuntimeClient();
	/** Callback used to forward logs received from the WebView. */
	private readonly onWebviewLog: ((text: string) => void) | undefined;
	/** Whether the stopOnEntry stop event has already been emitted. */
	private stopped = false;
	/** Flag that controls stop-on-entry behavior. */
	private stopOnEntry = true;
	/** Absolute path to the currently active program. */
	private activeProgram = path.resolve(process.cwd(), 'index.html');
	/** WebView panel associated with this session. */
	private webviewPanel: vscode.WebviewPanel | undefined;
	/** Tracks whether the current WebView has finished WASM initialization. */
	private webviewReady = false;
	/** Ruby source code waiting to be sent to the WebView runtime. */
	private pendingStartCode: string | undefined;

	/**
	 * @param onWebviewLog Callback that notifies the caller of log strings received from the WebView.
	 */
	constructor(onWebviewLog?: (text: string) => void) {
		this.onWebviewLog = onWebviewLog;
	}

	/**
	 * Creates the initialize response body.
	 *
	 * @returns DAP capabilities exposed by this adapter.
	 */
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

	/**
	 * Executes launch flow for the debug session.
	 * During launchRequest, this opens the WebView, loads WASM, and returns runtime connection output.
	 * In the VS Code F5 flow, the runtime UI environment must be prepared at this stage.
	 *
	 * @param args Debug launch arguments.
	 * @returns Runtime output intended for the Debug Console.
	 */
	async launch(args: PicoRubyWasmLaunchArguments): Promise<{ output: string }> {
		this.stopOnEntry = args.stopOnEntry ?? true;
		this.activeProgram = this.resolveProgramPath(args.program, args.cwd);
		this.pendingStartCode = await this.readProgramSource(this.activeProgram);
		this.showWebviewPanel();
		this.postStartMessageIfReady();
		const result = await this.runtimeClient.launch(args);
		const outputEvent = result.events.find((event) => event.type === 'output');

		return {
			output:
				typeof outputEvent?.body?.output === 'string'
					? outputEvent.body.output
					: '[picoruby-wasm] mock runtime connected\n'
		};
	}

	/**
	 * Determines whether a stop event should be emitted exactly once for stopOnEntry.
	 *
	 * @returns True when a stopped event should be sent in this call.
	 */
	markStopped(): boolean {
		if (!this.stopOnEntry) {
			return false;
		}

		if (this.stopped) {
			return false;
		}

		this.stopped = true;
		return true;
	}

	/**
	 * Resets session state and shuts down runtime/WebView resources.
	 *
	 * @returns Promise that resolves when asynchronous stop processing completes.
	 */
	reset(): Promise<void> {
		this.stopped = false;
		this.disposeWebviewPanel();
		return this.runtimeClient.stop();
	}

	/**
	 * Disposes the current WebView panel and clears its reference.
	 */
	private disposeWebviewPanel(): void {
		this.webviewPanel?.dispose();
		this.webviewPanel = undefined;
		this.webviewReady = false;
	}

	/**
	 * Shows the session WebView panel.
	 * Reuses an existing panel when available; otherwise creates a new one.
	 *
	 * Messages posted from the WebView via vscode.postMessage are received in the extension host
	 * through onDidReceiveMessage. This listener is where we bridge WebView logs to the Debug Console.
	 */
	private showWebviewPanel(): void {
		if (this.webviewPanel) {
			this.webviewPanel.reveal(vscode.ViewColumn.Active);
			return;
		}

		this.webviewPanel = createPicoRubyWasmWebviewPanel();
		this.webviewPanel.webview.onDidReceiveMessage((message: unknown) => {
			if (typeof message !== 'object' || message === null) {
				return;
			}

			const receivedMessage = message as { type?: unknown; text?: unknown };
			if (receivedMessage.type === 'ready') {
				this.webviewReady = true;
				this.postStartMessageIfReady();
				return;
			}

			if (receivedMessage.type !== 'log') {
				return;
			}

			this.onWebviewLog?.(this.stringifyWebviewMessage(receivedMessage.text));
		});
		this.webviewPanel.onDidDispose(() => {
			this.webviewPanel = undefined;
				this.webviewReady = false;
		});
	}

	/**
	 * Sends a start command to the WebView once both code and runtime are ready.
	 */
	private postStartMessageIfReady(): void {
		if (!this.webviewPanel || !this.webviewReady || this.pendingStartCode === undefined) {
			return;
		}

		const code = this.pendingStartCode;
		this.pendingStartCode = undefined;
		void this.webviewPanel.webview.postMessage({
			type: 'start',
			code
		});
	}

	/**
	 * Reads the target program source from disk and returns UTF-8 text.
	 *
	 * @param programPath Resolved program file path.
	 * @returns Source text. Empty string is returned when the file cannot be read.
	 */
	private async readProgramSource(programPath: string): Promise<string> {
		try {
			return await readFile(programPath, 'utf8');
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.onWebviewLog?.(`Failed to read program source: ${programPath} (${message})`);
			return '';
		}
	}

	/**
	 * Normalizes a WebView message payload into a string suitable for Debug Console output.
	 *
	 * @param text text field from a WebView message.
	 * @returns Stringified log body.
	 */
	private stringifyWebviewMessage(text: unknown): string {
		if (typeof text === 'string') {
			return text;
		}

		try {
			const json = JSON.stringify(text);
			return typeof json === 'string' ? json : String(text);
		} catch {
			return String(text);
		}
	}

	/**
	 * Builds thread data for the threads response.
	 *
	 * @returns A single mock thread entry.
	 */
	createThreads(): PicoRubyWasmThread[] {
		return [{ id: 1, name: 'Mock PicoRuby thread' }];
	}

	/**
	 * Builds stack frames for the stackTrace response.
	 *
	 * @returns A single frame pointing to the active program.
	 */
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

	/**
	 * Builds scopes for the scopes response.
	 *
	 * @returns Local scope metadata.
	 */
	createScopes(): PicoRubyWasmScope[] {
		return [{ name: 'Locals', variablesReference: 1, expensive: false }];
	}

	/**
	 * Builds variables for the variables response.
	 *
	 * @returns Currently an empty list.
	 */
	createVariables(): PicoRubyWasmVariable[] {
		return [];
	}

	/**
	 * Builds breakpoint entries for the setBreakpoints response.
	 *
	 * @param request DAP breakpoint request payload.
	 * @returns Breakpoints marked as verified.
	 */
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

	/**
	 * Returns a mock result for evaluate responses.
	 *
	 * @returns Fixed evaluation payload.
	 */
	createEvaluationResult(): { result: string; variablesReference: number } {
		return {
			result: 'mock-evaluation',
			variablesReference: 0
		};
	}

	/**
	 * Resolves the launch program argument into an absolute path.
	 *
	 * @param program Program path provided by the user.
	 * @param cwd Base directory for resolution.
	 * @returns Resolved absolute program path.
	 */
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

/**
 * LoggingDebugSession-based debug session implementation.
 * Responds to Debug Adapter Protocol requests and emits the required events.
 */
export class PicoRubyWasmLoggingDebugSession extends LoggingDebugSession {
	/** Shared session state with a callback that forwards WebView logs to the Debug Console. */
	private readonly state = new PicoRubyWasmMockSessionState((text) => {
		this.sendEvent(new OutputEvent(formatWebviewLogOutput(text), 'console'));
	});

	/**
	 * Handles DAP initialize requests.
	 *
	 * @param response DAP response object.
	 */
	protected initializeRequest(response: any): void {
		response.body = this.state.createInitializeBody();
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Handles DAP launch requests.
	 * This stage opens the WebView and prepares the WASM execution environment.
	 * In the VS Code F5 flow, the runtime UI must be started here.
	 *
	 * @param response DAP response object.
	 * @param args Launch arguments.
	 */
	protected launchRequest(response: any, args: any): void {
		void this.state.launch(args).then((launchResult) => {
			this.sendResponse(response);
			this.sendEvent(new OutputEvent(launchResult.output, 'console'));
		});
	}

	/**
	 * Handles DAP configurationDone requests.
	 *
	 * @param response DAP response object.
	 */
	protected configurationDoneRequest(response: any): void {
		this.sendResponse(response);

		if (this.state.markStopped()) {
			this.sendEvent(new StoppedEvent('entry', 1));
		}
	}

	/**
	 * Handles DAP threads requests.
	 *
	 * @param response DAP response object.
	 */
	protected threadsRequest(response: any): void {
		response.body = { threads: this.state.createThreads() };
		this.sendResponse(response);
	}

	/**
	 * Handles DAP stackTrace requests.
	 *
	 * @param response DAP response object.
	 */
	protected stackTraceRequest(response: any): void {
		response.body = {
			stackFrames: this.state.createStackFrames(),
			totalFrames: 1
		};
		this.sendResponse(response);
	}

	/**
	 * Handles DAP scopes requests.
	 *
	 * @param response DAP response object.
	 */
	protected scopesRequest(response: any): void {
		response.body = { scopes: this.state.createScopes() };
		this.sendResponse(response);
	}

	/**
	 * Handles DAP variables requests.
	 *
	 * @param response DAP response object.
	 */
	protected variablesRequest(response: any): void {
		response.body = { variables: this.state.createVariables() };
		this.sendResponse(response);
	}

	/**
	 * Handles DAP setBreakpoints requests.
	 *
	 * @param response DAP response object.
	 * @param args Breakpoint request payload.
	 */
	protected setBreakpointsRequest(response: any, args: { breakpoints?: Array<{ line?: number; column?: number }> }): void {
		response.body = {
			breakpoints: this.state.createBreakpoints(args)
		};
		this.sendResponse(response);
	}

	/**
	 * Handles DAP evaluate requests.
	 *
	 * @param response DAP response object.
	 */
	protected evaluateRequest(response: any): void {
		response.body = this.state.createEvaluationResult();
		this.sendResponse(response);
	}

	/**
	 * Handles DAP disconnect requests and terminates the session.
	 *
	 * @param response DAP response object.
	 */
	protected disconnectRequest(response: any): void {
		void this.state.reset();
		this.sendEvent(new TerminatedEvent());
		this.sendResponse(response);
	}
}

/**
 * Implementation of VS Code's inline debug adapter interface.
 * Exchanges DebugProtocolMessage objects directly without LoggingDebugSession.
 */
class PicoRubyWasmInlineDebugAdapter implements vscode.DebugAdapter {
	/** Event emitter used to send DAP messages back to VS Code. */
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	/** Shared session state that forwards WebView logs as output events. */
	private readonly state = new PicoRubyWasmMockSessionState((text) => {
		this.emit({
			type: 'event',
			seq: this.nextMessageSeq(),
			event: 'output',
			body: {
				category: 'console',
				output: formatWebviewLogOutput(text)
			}
		});
	});
	/** Sequence counter for outgoing DAP messages. */
	private nextSeq = 1;

	/** Outgoing message event subscribed to by VS Code. */
	readonly onDidSendMessage = this.emitter.event;

	/**
	 * Performs cleanup when the adapter is disposed.
	 */
	dispose(): void {
		void this.state.reset();
		this.emitter.dispose();
	}

	/**
	 * Handles DAP messages received from VS Code.
	 *
	 * @param message Incoming DAP message.
	 */
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

	/**
	 * Runs asynchronous core handling for DAP requests.
	 *
	 * @param message Incoming DAP message.
	 * @returns Promise resolved when request handling completes.
	 */
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
					success: false,
					command: message.command,
					message: `Unsupported request: ${message.command}`
				});
		}
	}

	/**
	 * Emits a DAP message to VS Code.
	 *
	 * @param message DAP message to emit.
	 */
	private emit(message: any): void {
		this.emitter.fire(message);
	}

	/**
	 * Allocates the next DAP message sequence number.
	 *
	 * @returns Next sequence number.
	 */
	private nextMessageSeq(): number {
		return this.nextSeq++;
	}
}

/**
 * Creates the inline debug adapter instance registered with VS Code.
 *
 * @returns Adapter instance passed to DebugAdapterInlineImplementation.
 */
export function createPicoRubyWasmInlineDebugAdapter(): vscode.DebugAdapter {
	return new PicoRubyWasmInlineDebugAdapter();
}
