import * as vscode from 'vscode';

type Associations = Record<string, string>;

export function withPicoRubyAssociation(associations: Associations): Associations {
    return { ...associations, '*.rb': 'picoruby' };
}

export function withoutPicoRubyAssociation(
    associations: Associations
): Associations | undefined {
    const next = { ...associations };
    delete next['*.rb'];

    return Object.keys(next).length > 0 ? next : undefined;
}

export function isWorkspaceOpen(): boolean {
    return Boolean(
        vscode.workspace.workspaceFolders?.length ||
        vscode.workspace.workspaceFile
    );
}

/**
 * ワークスペースの .vscode/settings.json に
 * "files.associations": { "*.rb": "picoruby" } を追記する。
 * 既存の設定はマージされ、上書き/削除しない。
 * 単一フォルダ・マルチルートいずれも ConfigurationTarget.Workspace を使用する
 * （単一フォルダの .vscode/settings.json は workspaceValue として格納される）。
 */
export async function enablePicoRuby(): Promise<void> {
    if (!isWorkspaceOpen()) {
        vscode.window.showErrorMessage(
            'PicoRuby: No folder or workspace is open. Open a folder first, then run this command.'
        );
        return;
    }

    const config = vscode.workspace.getConfiguration();
    const associations: Associations =
        config.inspect<Associations>('files.associations')?.workspaceValue ?? {};

    if (associations['*.rb'] === 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: already enabled for .rb files in this workspace.'
        );
        return;
    }

    await config.update(
        'files.associations',
        withPicoRubyAssociation(associations),
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
    if (!isWorkspaceOpen()) {
        vscode.window.showErrorMessage(
            'PicoRuby: No folder or workspace is open. Open a folder first, then run this command.'
        );
        return;
    }

    const config = vscode.workspace.getConfiguration();
    const associations: Associations =
        config.inspect<Associations>('files.associations')?.workspaceValue ?? {};

    if (associations['*.rb'] !== 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: mapping for .rb is not set in this workspace.'
        );
        return;
    }

    await config.update(
        'files.associations',
        withoutPicoRubyAssociation(associations),
        vscode.ConfigurationTarget.Workspace
    );

    vscode.window.showInformationMessage(
        'PicoRuby disabled: .rb files in this workspace are no longer mapped to picoruby.'
    );
}
