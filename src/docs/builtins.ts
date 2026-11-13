import * as vscode from 'vscode';

export interface Documentation {
	signature: string;
	description: string;
	example?: string;
}

export const BUILTIN_DOCS: Readonly<Record<string, Documentation>> = {
	puts: { signature: 'puts(*objects)', description: vscode.l10n.t('Outputs values as strings, followed by a newline.'), example: 'puts "Hello, PicoRuby!"' },
	p: { signature: 'p(*objects)', description: vscode.l10n.t('Outputs the inspect representation of values for debugging. In Funicular render methods, also used as the p tag helper.') },
	print: { signature: 'print(*objects)', description: vscode.l10n.t('Outputs values as strings without adding a newline.') },
	require: { signature: 'require(feature)', description: vscode.l10n.t('Loads the specified library or Ruby file.'), example: "require 'js'" },
	'JS.global': { signature: 'JS.global', description: vscode.l10n.t('Accesses the JavaScript global object.'), example: 'JS.global[:document]' },
	'JS.eval': { signature: 'JS.eval(source)', description: vscode.l10n.t('Evaluates JavaScript code passed as a string.'), example: 'JS.eval("document.title")' },
	'Funicular::Component': { signature: 'class MyComponent < Funicular::Component', description: vscode.l10n.t('Base class for Funicular components with state and a UI.') },
	initialize_state: { signature: 'def initialize_state', description: vscode.l10n.t('Returns the initial state of a component as a Hash.'), example: 'def initialize_state\n  { count: 0 }\nend' },
	state: { signature: 'state', description: vscode.l10n.t('Accesses the current state Hash of a component.'), example: 'state[:count]' },
	patch: { signature: 'patch(updates)', description: vscode.l10n.t('Updates the state and triggers a component re-render.'), example: 'patch(count: state[:count] + 1)' },
	render: { signature: 'def render', description: vscode.l10n.t('Defines a component UI using tag helpers.') },
	'Funicular.start': { signature: 'Funicular.start(component, container:)', description: vscode.l10n.t('Mounts a component in the specified DOM container.'), example: "Funicular.start(Counter, container: 'app')" },
	'SQLite3::Database.new': { signature: 'SQLite3::Database.new(path)', description: vscode.l10n.t('Opens a SQLite3 database. Use ":memory:" for an in-memory database or specify a path for a file.'), example: "db = SQLite3::Database.new(':memory:')" },
	execute: { signature: 'execute(sql, parameters = [])', description: vscode.l10n.t('Executes an SQL statement and returns the results as an array of rows. Specify placeholder values as an array.'), example: "db.execute('SELECT * FROM users WHERE id = ?', [1])" }
};

export const TAG_DOCS: Readonly<Record<string, Documentation>> = Object.fromEntries(
	['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'p', 'input', 'span', 'a', 'ul', 'ol', 'li', 'form', 'label', 'section', 'header', 'footer', 'main', 'textarea', 'select', 'option'].map(tag => [tag, {
		signature: `${tag}(**attributes, &block)`,
		description: vscode.l10n.t('Defines an HTML {0} element in a Funicular render method. Specify attributes as keyword arguments.', tag)
	}])
);
