export interface Documentation {
	signature: string;
	description: string;
	example?: string;
}

export const BUILTIN_DOCS: Readonly<Record<string, Documentation>> = {
	puts: { signature: 'puts(*objects)', description: '値を文字列として、末尾に改行を付けて出力します。', example: 'puts "Hello, PicoRuby!"' },
	p: { signature: 'p(*objects)', description: '値の inspect 表現を出力します。デバッグ時の値の確認に使います。Funicular の render 内では p タグヘルパーとしても使います。' },
	print: { signature: 'print(*objects)', description: '値を文字列として出力します。末尾に改行を追加しません。' },
	require: { signature: 'require(feature)', description: '指定したライブラリや Ruby ファイルを読み込みます。', example: "require 'js'" },
	'JS.global': { signature: 'JS.global', description: 'JavaScript のグローバルオブジェクトにアクセスします。', example: 'JS.global[:document]' },
	'JS.eval': { signature: 'JS.eval(source)', description: '文字列で渡した JavaScript コードを評価します。', example: 'JS.eval("document.title")' },
	'Funicular::Component': { signature: 'class MyComponent < Funicular::Component', description: '状態と UI を持つ Funicular コンポーネントの基底クラスです。' },
	initialize_state: { signature: 'def initialize_state', description: 'コンポーネントの初期状態を Hash として返すメソッドです。', example: 'def initialize_state\n  { count: 0 }\nend' },
	state: { signature: 'state', description: 'コンポーネントの現在の状態 Hash を参照します。', example: 'state[:count]' },
	patch: { signature: 'patch(updates)', description: '状態を更新し、コンポーネントの再描画を促します。', example: 'patch(count: state[:count] + 1)' },
	render: { signature: 'def render', description: 'タグヘルパーを使ってコンポーネントの UI を定義するメソッドです。' },
	'Funicular.start': { signature: 'Funicular.start(component, container:)', description: 'コンポーネントを指定した DOM コンテナーにマウントします。', example: "Funicular.start(Counter, container: 'app')" },
	'SQLite3::Database.new': { signature: 'SQLite3::Database.new(path)', description: 'SQLite3 のデータベースを開きます。メモリ上に作成する場合は ":memory:"、ファイルを使う場合はパスを指定します。', example: "db = SQLite3::Database.new(':memory:')" },
	execute: { signature: 'execute(sql, parameters = [])', description: 'SQL 文を実行し、問い合わせ結果を行の配列として取得します。プレースホルダーに渡す値は配列で指定します。', example: "db.execute('SELECT * FROM users WHERE id = ?', [1])" }
};

export const TAG_DOCS: Readonly<Record<string, Documentation>> = Object.fromEntries(
	['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'p', 'input', 'span', 'a', 'ul', 'ol', 'li', 'form', 'label', 'section', 'header', 'footer', 'main', 'textarea', 'select', 'option'].map(tag => [tag, {
		signature: `${tag}(**attributes, &block)`,
		description: `Funicular の render 内で HTML の ${tag} 要素を定義するタグヘルパーです。属性をキーワード引数で指定します。`
	}])
);
