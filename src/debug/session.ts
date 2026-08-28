import * as vscode from 'vscode';
import * as path from 'path';
import { readFileSync } from 'node:fs';
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
 * Interface of Webview messages sent to the extension.
 */
interface PicoRubyWasmIncomingMessage {
	/** Message type. */
	type?: string;
	/** Request identifier. */
	requestId?: string;
	data?: unknown;
	text?: unknown;
	reason?: unknown;
	line?: unknown;
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
	const runtimeScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'assets', 'webviewRuntime.js'));
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
	<script type="module" nonce="${nonce}" src="${runtimeScriptUri}"></script>
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
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
			retainContextWhenHidden: true
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
	/** Callback used to notify the adapter that runtime entered paused state. */
	private readonly onRuntimeStopped: ((reason: 'entry' | 'breakpoint', line?: number) => void) | undefined;
	/** Callback used to notify the adapter that runtime execution has terminated. */
	private readonly onRuntimeTerminated: (() => void) | undefined;
	/** Absolute path to the currently active program. */
	private activeProgram = path.resolve(process.cwd(), 'index.html');
	/** Current 1-based line used for stackTrace responses. */
	private currentLine = 1;
	/** Current source lines used to validate injectable breakpoint positions. */
	private activeProgramLines: string[] = [];
	/** WebView panel associated with this session. */
	private webviewPanel: vscode.WebviewPanel | undefined;
	/** Tracks whether the current WebView has finished WASM initialization. */
	private webviewReady = false;
	/** Ruby source code waiting to be sent to the WebView runtime. */
	private pendingStartCode: string | undefined;
    /** HTML content waiting to be sent to the WebView runtime for DOM rendering. */
    private pendingStartHtml: string | undefined;
	/** Pending requests for webview mapped by their request ID. */
	private pendingRequests = new Map<string, (data: any) => void>();
	/** 1-based line number where the script started. Used to adjust stack frames. */
	private scriptStartLine = 1;
	/** Pending breakpoints mapped by their normalized file path. */
    private breakpointsByPath = new Map<string, number[]>();

    /** Retrieves the breakpoints configured for the currently active program. */
    private get configuredBreakpoints(): number[] {
        const key = this.activeProgram ? path.normalize(this.activeProgram).toLowerCase() : '';
        return this.breakpointsByPath.get(key) || [];
    }

	/**
	 * @param onWebviewLog Callback that notifies the caller of log strings received from the WebView.
	 */
	constructor(
		onWebviewLog?: (text: string) => void,
		onRuntimeStopped?: (reason: 'entry' | 'breakpoint', line?: number) => void,
		onRuntimeTerminated?: () => void
	) {
		this.onWebviewLog = onWebviewLog;
		this.onRuntimeStopped = onRuntimeStopped;
		this.onRuntimeTerminated = onRuntimeTerminated;
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
		this.activeProgram = this.resolveProgramPath(args.program, args.cwd);
		this.currentLine = 1;
		this.pendingStartCode = await this.readProgramSource(this.activeProgram);
		this.activeProgramLines = this.pendingStartCode.split('\n');
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
	 * Resets session state and shuts down runtime/WebView resources.
	 *
	 * @returns Promise that resolves when asynchronous stop processing completes.
	 */
	reset(): Promise<void> {
		this.pendingStartCode = undefined;
		this.pendingStartHtml = undefined;
		this.activeProgramLines = [];
		this.breakpointsByPath.clear();
		this.scriptStartLine = 1;
		this.currentLine = 1;
		this.pendingRequests.clear();
		this.disposeWebviewPanel();
		return this.runtimeClient.stop();
	}

	/**
	 * Requests the WebView runtime to continue from a paused state.
	 */
	continueRuntime(): void {
		this.postControlMessage('continue');
	}

	/**
	 * Requests the WebView runtime to execute one step-over operation.
	 */
	nextRuntime(): void {
		this.postControlMessage('next');
	}

	/**
	 * Requests the WebView runtime to execute one step-in operation.
	 */
	stepInRuntime(): void {
		this.postControlMessage('stepIn');
	}

	/**
	 * Sends a control command to the runtime webview and logs delivery outcome.
	 *
	 * @param type Control message type.
	 */
	private postControlMessage(type: 'continue' | 'next' | 'stepIn' | 'terminate'): void {
		if (!this.webviewPanel) {
			this.onWebviewLog?.(`[adapter] dropped '${type}' command: webview panel not available`);
			return;
		}

		if (!this.webviewReady) {
			this.onWebviewLog?.(`[adapter] dropped '${type}' command: webview not ready`);
			return;
		}

		void this.webviewPanel.webview.postMessage({ type }).then((posted) => {
			if (!posted) {
				this.onWebviewLog?.(`[adapter] webview declined '${type}' command`);
			}
		}, (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			this.onWebviewLog?.(`[adapter] failed to post '${type}' command: ${message}`);
		});
	}

	/**
	 * Requests runtime termination and then resets adapter-side resources.
	 */
	async terminateRuntime(): Promise<void> {
		if (this.webviewPanel && this.webviewReady) {
			try {
				await this.webviewPanel.webview.postMessage({ type: 'terminate' });
			} catch {
				// Ignore postMessage failures and continue with local cleanup.
			}
		}

		await this.reset();
	}

	/**
     * Updates configured breakpoints and forwards them to WebView runtime when ready.
	 *
	 * @param sourcePath The path of the source file for which breakpoints are being updated.
	 * @param lines 1-based line numbers.
     */
    updateBreakpoints(sourcePath: string | undefined, lines: number[]): void {
        const key = sourcePath ? path.normalize(sourcePath).toLowerCase() : 'unknown';
        const validLines = Array.from(
            new Set(lines.filter((line) => Number.isInteger(line) && line > 0))
        ).sort((left, right) => left - right);

        // Save the valid lines for the given source path
        this.breakpointsByPath.set(key, validLines);

        this.postBreakpointsIfReady();
    }

	/**
	 * Resolves source lines used to validate breakpoint positions.
	 *
	 * @param sourcePath Source path from DAP setBreakpoints request.
	 * @returns Source lines, or undefined when source cannot be resolved.
	 */
	resolveBreakpointValidationLines(sourcePath: string | undefined): string[] | undefined {
		if (typeof sourcePath === 'string' && sourcePath.length > 0) {
			try {
				return readFileSync(sourcePath, 'utf8').split('\n');
			} catch {
				// Fall back to active program lines below.
			}
		}

		if (this.activeProgramLines.length > 0) {
			return this.activeProgramLines;
		}

		return undefined;
	}

	/**
	 * Returns whether a source line can safely receive "binding.irb; " injection.
	 *
	 * @param line 1-based source line number.
	 * @returns false for comments, empty lines, and control-flow keywords that would break Ruby syntax when prepended.
	 */
	isInjectableBreakpointLine(line: number, sourceLines: string[] | undefined): boolean {
		if (!Number.isInteger(line) || line <= 0) {
			return false;
		}

		if (sourceLines === undefined) {
			return true;
		}

		const sourceLine = sourceLines[line - 1];
		if (typeof sourceLine !== 'string') {
			return false;
		}

		const trimmed = sourceLine.trimStart();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			return false;
		}

		return !/^(?:else|elsif|when|rescue|ensure|end)\b/.test(trimmed);
	}

	/**
	 * Injects binding.irb into the configured Ruby source lines.
	 *
	 * @param sourceCode Ruby source code.
	 * @param breakpoints 1-based line numbers from VS Code (HTML line numbers).
	 * @returns Ruby source code with debugger bindings injected.
	 */
	injectBindingIrb(sourceCode: string, breakpoints: number[]): string {
		const lines = sourceCode.split('\n');
		const offset = this.scriptStartLine - 1;

		const rubyBreakpoints = new Set(
			breakpoints
				.map((htmlLine) => htmlLine - offset)
				.filter((line) => Number.isInteger(line) && line > 0)
		);

		for (let index = 0; index < lines.length; index += 1) {
			const lineNumber = index + 1; // 1-based Ruby line number corresponding to the current index
			if (!rubyBreakpoints.has(lineNumber) || !this.isInjectableBreakpointLine(lineNumber, lines)) {
				continue;
			}

			lines[index] = `binding.irb; ${lines[index]}`;
		}

		return lines.join('\n');
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

			const receivedMessage = message as PicoRubyWasmIncomingMessage;

			if (receivedMessage.requestId) {
				this.handleWebviewResponse(receivedMessage);
				return;
			}

			if (receivedMessage.type === 'ready') {
				this.webviewReady = true;
				this.postBreakpointsIfReady();
				this.postStartMessageIfReady();
				return;
			}

			if (receivedMessage.type === 'stopped') {
				const reason =
					receivedMessage.reason === 'breakpoint' || receivedMessage.reason === 'entry'
						? receivedMessage.reason
						: 'breakpoint';
				let line =
					typeof receivedMessage.line === 'number' && Number.isInteger(receivedMessage.line) && receivedMessage.line > 0
						? receivedMessage.line
						: undefined;
						
				// Adjust the line number to html file line number.
				if (line !== undefined) {
					line = line + (this.scriptStartLine - 1);
					this.currentLine = line;
				}
				this.onRuntimeStopped?.(reason, line);
				return;
			}

			if (receivedMessage.type === 'terminated') {
				this.onRuntimeTerminated?.();
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
	 * Handles messages received from the WebView and resolves pending requests.
	 *
	 * @param message Incoming message from the WebView.
	 */
	private handleWebviewResponse(message: PicoRubyWasmIncomingMessage): void {
		if (message?.requestId && this.pendingRequests.has(message.requestId)) {
			const resolve = this.pendingRequests.get(message.requestId);
			this.pendingRequests.delete(message.requestId);
			if (resolve) {
				resolve(message.data);
			}
		}
	}

	/**
	 * Sends a message to Webview and returns a promise for the response.
	 */
	public requestFromWebview<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
		return new Promise((resolve) => {
			const requestId = randomBytes(8).toString('hex');
			this.pendingRequests.set(requestId, resolve);

			setTimeout(() => {
				if (this.pendingRequests.has(requestId)) {
					this.pendingRequests.delete(requestId);
					resolve({} as T);
				}
			}, 1000);

			this.postMessageToWebview({ ...(payload ?? {}), type, requestId });
		});
	}

	/**
	 * Sends a start command to the WebView once both code and runtime are ready.
	 */
	private postStartMessageIfReady(): void {
		if (!this.webviewPanel || !this.webviewReady || this.pendingStartCode === undefined) {
			return;
		}

		const code = this.injectBindingIrb(this.pendingStartCode, this.configuredBreakpoints);
		const html = this.pendingStartHtml;
		this.pendingStartCode = undefined;
		this.pendingStartHtml = undefined;

		void this.webviewPanel.webview.postMessage({
			type: 'start',
			code,
			html,
			breakpoints: this.configuredBreakpoints
		});
	}

	/**
	 * Sends current breakpoints to WebView runtime.
	 */
	private postBreakpointsIfReady(): void {
		if (!this.webviewPanel || !this.webviewReady) {
			return;
		}

		void this.webviewPanel.webview.postMessage({
			type: 'setBreakpoints',
			breakpoints: this.configuredBreakpoints
		});
	}

	/**
	 * Reads the target program source from disk and returns UTF-8 text.
	 * If it's an HTML file, extracts the content of <script type="text/ruby">.
	 *
	 * @param programPath Resolved program file path.
	 * @returns Source text. Empty string is returned when the file cannot be read.
	 */
	private async readProgramSource(programPath: string): Promise<string> {
		try {
			const content = await readFile(programPath, 'utf8');
			
			if (programPath.toLowerCase().endsWith('.html') || programPath.toLowerCase().endsWith('.htm')) {
				this.pendingStartHtml = await this.inlineExternalCss(content, programPath);
				
				const lines = content.split('\n');
				const scriptStartRegex = /<script\s+type=["'](?:text\/ruby|text\/picoruby)["'][^>]*>/i;
				const scriptEndRegex = /<\/script>/i;

				let insideScript = false;
				let extractedLines: string[] = [];
				this.scriptStartLine = 1;

				for (let i = 0; i < lines.length; i++) {
					if (!insideScript) {
						if (scriptStartRegex.test(lines[i])) {
							insideScript = true;
							this.scriptStartLine = i + 2; // 0-based index + 1 (next line) + 1 (1-based line number)
						}
					} else {
						if (scriptEndRegex.test(lines[i])) {
							break;
						}
						extractedLines.push(lines[i]);
					}
				}

				if (extractedLines.length === 0) {
					this.onWebviewLog?.(`No PicoRuby script found in ${programPath}`);
					return '';
				}
				return extractedLines.join('\n');
			}

			this.scriptStartLine = 1; // if it's .rb files and so on, it is always 1.
			this.pendingStartHtml = undefined;
			return content;
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
				line: this.currentLine,
				column: 1,
				source: {
					name: path.basename(this.activeProgram),
					path: this.activeProgram
				}
			}
		];
	}

	/**
	 * Builds scopes for the scopes response.
	 *
	 * @returns Local and global scope metadata.
	 */
	createScopes(): PicoRubyWasmScope[] {
		return [
			{ name: 'Locals', variablesReference: 1, expensive: false },
			{ name: 'Globals', variablesReference: 2, expensive: true }
		];
	}

	/**
	 * Builds variables for the variables response by fetching data from the webview runtime.
	 *
	 * @param variablesReference 1 for Locals, 2 for Globals.
	 * @returns Array of DAP variable entries.
	 */
	async createVariables(variablesReference?: number): Promise<PicoRubyWasmVariable[]> {
		let variablesData: Record<string, any> = {};
		const isGlobal = variablesReference === 2;

		if (variablesReference === 1) {
			variablesData = await this.requestFromWebview<Record<string, any>>('getLocals');
		} else if (variablesReference === 2) {
			variablesData = await this.requestFromWebview<Record<string, any>>('getGlobals');
		}

		return Object.entries(variablesData)
			.filter(([name]) => {
				if (!isGlobal) {
					return !name.startsWith('__');
				} else {
					return (
						!name.startsWith('$__') &&
						!name.startsWith('$_') &&
						!name.startsWith('$promise_') &&
						name !== '$LOADED_FEATURES'
					);
				}
			})
			.map(([name, value]) => ({
				name,
				value: typeof value === 'string' ? value : JSON.stringify(value),
				variablesReference: 0
			}));
	}

	/**
	 * Evaluates an expression in the current debug context via WebView runtime.
	 *
	 * @param expression Variable name or expression to evaluate.
	 * @returns DAP-compatible evaluation payload.
	 */
	async evaluateExpression(expression: string): Promise<{ result: string; variablesReference: number }> {
		const fallback = { result: '', variablesReference: 0 };
		const query = expression;

		if (!query.trim()) {
			return fallback;
		}

		try {
			const response = await this.requestFromWebview<{ result?: unknown }>('evaluate', {
				expression: query
			});
			const result = this.stringifyEvaluationResult(response?.result);
			return {
				result,
				variablesReference: 0
			};
		} catch {
			return fallback;
		}
	}

	/**
	 * Converts evaluation payload values into DAP string output.
	 *
	 * @param value Value returned from the WebView runtime.
	 * @returns Display-safe string value.
	 */
	private stringifyEvaluationResult(value: unknown): string {
		if (typeof value === 'string') {
			return value;
		}

		if (value === null || value === undefined) {
			return '';
		}

		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
			return String(value);
		}

		try {
			const json = JSON.stringify(value);
			return typeof json === 'string' ? json : '';
		} catch {
			return '';
		}
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

	/**
	 * Sends a message to the active Webview.
	 *
	 * @param message Message payload to send to the Webview.
	 */
	public postMessageToWebview(message: any): void {
		if (this.webviewPanel) {
			void this.webviewPanel.webview.postMessage(message);
		}
	}

	/**
     * Resolves local <link rel="stylesheet" href="..."> files and inlines them into <style> tags.
     */
    private async inlineExternalCss(htmlContent: string, htmlPath: string): Promise<string> {
        const htmlDir = path.dirname(htmlPath);
        const linkRegex = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>|<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;

        let resolvedHtml = htmlContent;
        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(htmlContent)) !== null) {
            const cssHref = match[1] || match[2];
            // HTTP(S) 等の外部URL以外のローカル相対パスを対象とする
            if (cssHref && !cssHref.startsWith('http://') && !cssHref.startsWith('https://') && !cssHref.startsWith('//')) {
                try {
                    const cssPath = path.resolve(htmlDir, cssHref);
                    const cssContent = await readFile(cssPath, 'utf8');
                    resolvedHtml = resolvedHtml.replace(match[0], `<style>\n/* inlined: ${cssHref} */\n${cssContent}\n</style>`);
                } catch (error) {
                    this.onWebviewLog?.(`Failed to inline CSS file: ${cssHref}`);
                }
            }
        }
        return resolvedHtml;
    }
}

/**
 * LoggingDebugSession-based debug session implementation.
 * Responds to Debug Adapter Protocol requests and emits the required events.
 */
export class PicoRubyWasmLoggingDebugSession extends LoggingDebugSession {
	private static readonly THREAD_ID = 1;

	/** Tracks whether a terminated event has already been sent for this session. */
	private terminatedEventSent = false;

	/** Shared session state with a callback that forwards WebView logs to the Debug Console. */
	private readonly state = new PicoRubyWasmMockSessionState(
		(text) => {
			this.sendEvent(new OutputEvent(formatWebviewLogOutput(text), 'console'));
		},
		(reason) => {
			const event = new StoppedEvent(reason, PicoRubyWasmLoggingDebugSession.THREAD_ID);
			Object.assign(event.body, { allThreadsStopped: true });
			this.sendEvent(event);
		},
		() => {
			void this.state.reset();
			this.sendTerminatedEventOnce();
		}
	);

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
	}

	/**
	 * Handles DAP continue requests.
	 *
	 * @param response DAP response object.
	 */
	protected continueRequest(response: any, _args: any): void {
		this.state.continueRuntime();
		response.body = { allThreadsContinued: true };
		this.sendResponse(response);
	}

	/**
	 * Handles DAP next (step over) requests.
	 *
	 * @param response DAP response object.
	 */
	protected nextRequest(response: any): void {
		this.state.nextRuntime();
		this.sendResponse(response);
	}

	/**
	 * Handles DAP stepIn requests.
	 *
	 * @param response DAP response object.
	 */
	protected stepInRequest(response: any): void {
		this.state.stepInRuntime();
		this.sendResponse(response);
	}

	/**
	 * Handles DAP setBreakpoints requests.
	 *
	 * @param response DAP response object.
	 * @param args Incoming breakpoint payload.
	 */
	protected setBreakpointsRequest(
        response: any,
        args: { source?: { path?: string }; breakpoints?: Array<{ line?: number; column?: number }> }
    ): void {
        const requested = Array.isArray(args?.breakpoints) ? args.breakpoints : [];
        const sourcePath = typeof args?.source?.path === 'string' ? args.source.path : undefined;

		const validationLines = this.state.resolveBreakpointValidationLines(sourcePath);
		const acceptedLines = requested
			.map((bp) => bp?.line)
			.filter(
				(line): line is number =>
					typeof line === 'number' &&
					Number.isInteger(line) &&
					line > 0 &&
					this.state.isInjectableBreakpointLine(line, validationLines)
			);

        this.state.updateBreakpoints(sourcePath, acceptedLines);

        const acceptedLineSet = new Set(acceptedLines);
        response.body = {
            breakpoints: requested.map((bp) => ({
				verified:
					typeof bp?.line === 'number' && Number.isInteger(bp.line)
						? acceptedLineSet.has(bp.line)
						: false,
                line: typeof bp?.line === 'number' ? bp.line : undefined,
                column: typeof bp?.column === 'number' ? bp.column : undefined
            }))
        };
        this.sendResponse(response);
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
	protected variablesRequest(response: any, args: any): void {
		const ref = args?.variablesReference;
		void this.state.createVariables(ref).then((variables) => {
			response.body = { variables };
			this.sendResponse(response);
		});
	}

	/**
	 * Handles DAP evaluate requests.
	 *
	 * @param response DAP response object.
	 */
	protected evaluateRequest(response: any, args: any): void {
		const expression = typeof args?.expression === 'string' ? args.expression : '';
		void this.state
			.evaluateExpression(expression)
			.then((evaluationResult) => {
				response.body = evaluationResult;
				this.sendResponse(response);
			})
			.catch(() => {
				response.body = { result: '', variablesReference: 0 };
				this.sendResponse(response);
			});
	}

	/**
	 * Handles DAP disconnect requests and terminates the session.
	 *
	 * @param response DAP response object.
	 */
	protected disconnectRequest(response: any): void {
		void this.state.terminateRuntime();
		this.sendTerminatedEventOnce();
		this.sendResponse(response);
	}

	/**
	 * Handles DAP terminate requests and terminates the session.
	 *
	 * @param response DAP response object.
	 */
	protected terminateRequest(response: any): void {
		void this.state.terminateRuntime();
		this.sendTerminatedEventOnce();
		this.sendResponse(response);
	}

	/**
	 * Sends a terminated event once per session.
	 */
	private sendTerminatedEventOnce(): void {
		if (this.terminatedEventSent) {
			return;
		}

		this.terminatedEventSent = true;
		this.sendEvent(new TerminatedEvent());
	}
}

/**
 * Implementation of VS Code's inline debug adapter interface.
 * Exchanges DebugProtocolMessage objects directly without LoggingDebugSession.
 */
class PicoRubyWasmInlineDebugAdapter implements vscode.DebugAdapter {
	private static readonly THREAD_ID = 1;

	/** Tracks whether a terminated event has already been sent for this adapter. */
	private terminatedEventSent = false;

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
	}, (reason, line) => {
		this.emit({
			type: 'event',
			seq: this.nextMessageSeq(),
			event: 'stopped',
			body: {
				reason,
				threadId: PicoRubyWasmInlineDebugAdapter.THREAD_ID,
				line,
				allThreadsStopped: true
			}
		});
	}, () => {
		this.state.reset();
		this.emitTerminatedEventOnce();
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
				return;
			case 'continue':
				this.state.continueRuntime();
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'continue',
					body: { allThreadsContinued: true }
				});
				return;
			case 'next':
				this.state.nextRuntime();
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'next'
				});
				return;
			case 'stepIn':
				this.state.stepInRuntime();
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'stepIn'
				});
				return;
			case 'setBreakpoints': {
                const requested = Array.isArray(message.arguments?.breakpoints)
                    ? message.arguments.breakpoints
                    : [];
                const sourcePath =
                    typeof message.arguments?.source?.path === 'string'
                        ? message.arguments.source.path
                        : undefined;

				const validationLines = this.state.resolveBreakpointValidationLines(sourcePath);
				const acceptedLines = requested
					.map((bp: { line?: number; column?: number }) => bp?.line)
					.filter(
						(line: unknown): line is number =>
							typeof line === 'number' &&
							Number.isInteger(line) &&
							line > 0 &&
							this.state.isInjectableBreakpointLine(line, validationLines)
					);

                this.state.updateBreakpoints(sourcePath, acceptedLines);

                const acceptedLineSet = new Set(acceptedLines);
                this.emit({
                    type: 'response',
                    seq: this.nextMessageSeq(),
                    request_seq: message.seq,
                    success: true,
                    command: 'setBreakpoints',
                    body: {
                        breakpoints: requested.map((bp: { line?: number; column?: number }) => ({
							verified:
								typeof bp?.line === 'number' && Number.isInteger(bp.line)
									? acceptedLineSet.has(bp.line)
									: false,
                            line: typeof bp?.line === 'number' ? bp.line : undefined,
                            column: typeof bp?.column === 'number' ? bp.column : undefined
                        }))
                    }
                });
                return;
            }
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
			case 'variables': {
				const ref = message.arguments?.variablesReference;
				const variables = await this.state.createVariables(ref);

				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'variables',
					body: { variables }
				});
				return;
			}
			case 'evaluate':
				{
					const expression =
						typeof message.arguments?.expression === 'string'
							? message.arguments.expression
							: '';
					const evaluationResult = await this.state.evaluateExpression(expression);

					this.emit({
						type: 'response',
						seq: this.nextMessageSeq(),
						request_seq: message.seq,
						success: true,
						command: 'evaluate',
						body: evaluationResult
					});
					return;
				}
			case 'disconnect':
				void this.state.terminateRuntime();
				this.emitTerminatedEventOnce();
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'disconnect'
				});
				return;
			case 'terminate':
				void this.state.terminateRuntime();
				this.emitTerminatedEventOnce();
				this.emit({
					type: 'response',
					seq: this.nextMessageSeq(),
					request_seq: message.seq,
					success: true,
					command: 'terminate'
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
	 * Emits a terminated event once per adapter instance.
	 */
	private emitTerminatedEventOnce(): void {
		if (this.terminatedEventSent) {
			return;
		}

		this.terminatedEventSent = true;
		this.emit({ type: 'event', seq: this.nextMessageSeq(), event: 'terminated' });
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
