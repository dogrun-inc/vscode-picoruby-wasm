export interface PicoRubyWasmLaunchRequest {
	program?: string;
	args?: string[];
	cwd?: string;
}

export interface PicoRubyWasmMockEvent {
	type: 'output' | 'stopped' | 'terminated';
	body?: Record<string, unknown>;
}

export interface PicoRubyWasmLaunchResult {
	sessionId: string;
	events: PicoRubyWasmMockEvent[];
}

export class PicoRubyWasmRuntimeClient {
	private connected = false;
	private launched = false;

	async connect(): Promise<void> {
		this.connected = true;
	}

	async launch(request: PicoRubyWasmLaunchRequest): Promise<PicoRubyWasmLaunchResult> {
		if (!this.connected) {
			await this.connect();
		}

		this.launched = true;

		const target = request.program ?? 'mock-launch.json';

		return {
			sessionId: 'picoruby-wasm-mock-session',
			events: [
				{
					type: 'output',
					body: {
						category: 'console',
						output: `[picoruby-wasm] mock runtime connected for ${target}\n`
					}
				}
			]
		};
	}

	async stop(): Promise<void> {
		this.launched = false;
		this.connected = false;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get isLaunched(): boolean {
		return this.launched;
	}
}
