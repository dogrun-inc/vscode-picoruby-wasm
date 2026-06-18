import * as vscode from 'vscode';

/**
 * ワークスペースの .vscode/settings.json に
 * "files.associations": { "*.rb": "picoruby" } を追記する。
 * 既存の設定はマージされ、上書き/削除しない。
 */
export async function enablePicoRuby(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const associations: Record<string, string> =
        config.inspect<Record<string, string>>('files.associations')
            ?.workspaceValue ?? {};

    if (associations['*.rb'] === 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: already enabled for .rb files in this workspace.'
        );
        return;
    }

    await config.update(
        'files.associations',
        { ...associations, '*.rb': 'picoruby' },
        vscode.ConfigurationTarget.Workspace
    );

    vscode.window.showInformationMessage(
        'PicoRuby enabled: .rb files in this workspace are now treated as picoruby. ' +
        'Open a .rb file and check the language indicator in the status bar.'
    );
}

/**
 * ワークスペース設定から "*.rb": "picoruby" のマッピングを削除する。
 * その他の files.associations は変更しない。
 */
export async function disablePicoRuby(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const associations: Record<string, string> =
        config.inspect<Record<string, string>>('files.associations')
            ?.workspaceValue ?? {};

    if (associations['*.rb'] !== 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: mapping for .rb is not set in this workspace.'
        );
        return;
    }

    const next = { ...associations };
    delete next['*.rb'];

    await config.update(
        'files.associations',
        Object.keys(next).length > 0 ? next : undefined,
        vscode.ConfigurationTarget.Workspace
    );

    vscode.window.showInformationMessage(
        'PicoRuby disabled: .rb files in this workspace are no longer mapped to picoruby.'
    );
}
