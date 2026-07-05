import * as vscode from 'vscode';

const DEBUG_TYPE = 'picoruby-wasm';
const DEFAULT_PROGRAM = './index.html';

export class PicoRubyWasmDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		return [this.createDefaultConfiguration(folder)];
	}

	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		configuration: vscode.DebugConfiguration
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		const resolved = { ...configuration };

		resolved.type = DEBUG_TYPE;
		resolved.request = resolved.request ?? 'launch';
		resolved.name = resolved.name ?? 'Launch PicoRuby WASM';
		resolved.program = resolved.program ?? this.getDefaultProgram();
		resolved.cwd = resolved.cwd ?? this.getDefaultCwd(folder);
		resolved.stopOnEntry = resolved.stopOnEntry ?? true;

		return resolved;
	}

	private createDefaultConfiguration(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration {
		return {
			name: 'Launch PicoRuby WASM',
			type: DEBUG_TYPE,
			request: 'launch',
			program: this.getDefaultProgram(),
			cwd: this.getDefaultCwd(folder),
			stopOnEntry: true
		};
	}

	private getDefaultProgram(): string {
		return './index.html';
	}

	private getDefaultCwd(folder: vscode.WorkspaceFolder | undefined): string | undefined {
		return folder?.uri.fsPath;
	}
}
