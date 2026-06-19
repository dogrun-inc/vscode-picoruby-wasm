import * as vscode from 'vscode';

type Associations = Record<string, string>;
type AssociationTarget = 'workspace' | 'workspaceFolder';

interface AssociationContext {
    target: AssociationTarget;
    associations: Associations;
}

interface AssociationInspectValues {
    workspaceValue?: Associations;
    workspaceFolderValue?: Associations;
}

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

export function resolveAssociationContext(
    values: AssociationInspectValues,
    hasWorkspaceFile: boolean,
    hasWorkspaceFolders: boolean
): AssociationContext {
    if (hasWorkspaceFile) {
        return {
            target: 'workspace',
            associations: values.workspaceValue ?? {}
        };
    }

    if (hasWorkspaceFolders) {
        return {
            target: 'workspaceFolder',
            associations: values.workspaceFolderValue ?? {}
        };
    }

    return {
        target: 'workspace',
        associations: values.workspaceValue ?? {}
    };
}

function toConfigurationTarget(target: AssociationTarget): vscode.ConfigurationTarget {
    return target === 'workspaceFolder'
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
}

function getAssociationContext(config: vscode.WorkspaceConfiguration): AssociationContext {
    const inspected = config.inspect<Associations>('files.associations');

    return resolveAssociationContext(
        {
            workspaceValue: inspected?.workspaceValue,
            workspaceFolderValue: inspected?.workspaceFolderValue
        },
        Boolean(vscode.workspace.workspaceFile),
        Boolean(vscode.workspace.workspaceFolders?.length)
    );
}

/**
 * ワークスペースの .vscode/settings.json に
 * "files.associations": { "*.rb": "picoruby" } を追記する。
 * 既存の設定はマージされ、上書き/削除しない。
 */
export async function enablePicoRuby(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const context = getAssociationContext(config);
    const associations = context.associations;

    if (associations['*.rb'] === 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: already enabled for .rb files in this workspace.'
        );
        return;
    }

    await config.update(
        'files.associations',
        withPicoRubyAssociation(associations),
        toConfigurationTarget(context.target)
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
    const context = getAssociationContext(config);
    const associations = context.associations;

    if (associations['*.rb'] !== 'picoruby') {
        vscode.window.showInformationMessage(
            'PicoRuby: mapping for .rb is not set in this workspace.'
        );
        return;
    }

    await config.update(
        'files.associations',
        withoutPicoRubyAssociation(associations),
        toConfigurationTarget(context.target)
    );

    vscode.window.showInformationMessage(
        'PicoRuby disabled: .rb files in this workspace are no longer mapped to picoruby.'
    );
}
