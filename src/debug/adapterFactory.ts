import * as vscode from 'vscode';
import { PicoRubyWasmDebugConfigurationProvider } from './configProvider';
import { createPicoRubyWasmInlineDebugAdapter } from './session';

const DEBUG_TYPE = 'picoruby-wasm';

class PicoRubyWasmDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(createPicoRubyWasmInlineDebugAdapter());
	}
}

export function registerPicoRubyWasmDebugging(context: vscode.ExtensionContext): vscode.Disposable {
	const configurationProvider = new PicoRubyWasmDebugConfigurationProvider();
	const descriptorFactory = new PicoRubyWasmDebugAdapterDescriptorFactory();

	return vscode.Disposable.from(
		vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configurationProvider),
		vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, descriptorFactory)
	);
}
