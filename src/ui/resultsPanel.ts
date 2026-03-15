import * as vscode from 'vscode';

import { QueryPage } from '../models';

type PageSizeValue = 5 | 10 | 50 | 100 | 200 | 'all';
type NavigationDirection = 'nextPage' | 'prevPage';

interface PanelMessage {
	type: string;
	value?: string;
}

export class ResultsPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'oracleFusionBIPVSCodeExtension.resultsPanel';

	private view: vscode.WebviewView | undefined;
	private pageSize: PageSizeValue = 50;
	private result: QueryPage | undefined;

	public constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onNavigate: (direction: NavigationDirection) => Promise<void>,
		private readonly onPageSizeChange: (pageSize: number | 'all') => Promise<void>,
		private readonly onExportCsv: () => Promise<void>,
		private readonly onExportXlsx: () => Promise<void>,
		private readonly onClearOutput: () => Promise<void>
	) {}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
			void this.handleMessage(message);
		});
		this.render();
	}

	public show(result: QueryPage): void {
		this.result = result;
		if (result.pageSize > 0) {
			this.pageSize = result.pageSize as PageSizeValue;
		}
		void vscode.commands.executeCommand('workbench.view.extension.oracleFusionBIPVSCodeExtensionPanel');
		this.render();
	}

	public clear(): void {
		this.result = undefined;
		this.render();
	}

	private render(): void {
		if (!this.view) {
			return;
		}

		this.view.webview.html = this.renderHtml();
	}

	private async handleMessage(message: PanelMessage): Promise<void> {
		switch (message.type) {
			case 'setPageSize': {
				const raw = (message.value ?? '').toLowerCase();
				const parsed: PageSizeValue = raw === 'all' ? 'all' : (Number(raw) as PageSizeValue);
				if (parsed === 'all' || [5, 10, 50, 100, 200].includes(parsed)) {
					this.pageSize = parsed;
					await this.onPageSizeChange(parsed === 'all' ? 'all' : Number(parsed));
				}
				break;
			}
			case 'nextPage':
				await this.onNavigate('nextPage');
				break;
			case 'prevPage':
				await this.onNavigate('prevPage');
				break;
			case 'exportCsv':
				await this.onExportCsv();
				break;
			case 'exportXlsx':
				await this.onExportXlsx();
				break;
			case 'clearOutput':
				await this.onClearOutput();
				break;
			default:
				break;
		}
	}

	private renderHtml(): string {
		const result = this.result;
		if (!result) {
			return '<html><body><h3>No data. Run a query to populate results.</h3></body></html>';
		}

		const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const pageSize = result.pageSize === 0 ? this.pageSize : result.pageSize;
		const totalRows = result.rows.length;
		const start = result.offset + 1;
		const end = result.offset + totalRows;
		const rows = result.rows;
		const previousDisabled = result.offset === 0 ? 'disabled' : '';
		const nextDisabled = result.hasMore ? '' : 'disabled';
		const pageNumber = Math.floor(result.offset / Math.max(1, result.pageSize)) + 1;

		const th = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
		const tr = rows
			.map((row) => `<tr>${result.columns.map((column) => `<td>${escapeHtml(row[column] ?? '')}</td>`).join('')}</tr>`)
			.join('');
		const options = [5, 10, 50, 100, 200, 'all']
			.map((value) => `<option value="${value}" ${value === pageSize ? 'selected' : ''}>${value}</option>`)
			.join('');

		return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Fusion BIP Results</title>
<style>
:root {
	--bg: #f7f4ef;
	--surface: #fffdf8;
	--ink: #1f2a37;
	--accent: #0f766e;
	--accent-2: #c2410c;
	--border: #d6cec1;
}
body { margin: 0; font-family: 'Avenir Next', 'Segoe UI', sans-serif; background: radial-gradient(circle at top left, #fdf6e3, var(--bg)); color: var(--ink); }
header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--surface); position: sticky; top: 0; z-index: 5; }
#clear { margin-left: auto; }
button, select { border: 1px solid var(--border); border-radius: 8px; background: white; color: var(--ink); padding: 6px 10px; cursor: pointer; }
button.primary { background: var(--accent); color: white; border-color: var(--accent); }
button.secondary { background: var(--accent-2); color: white; border-color: var(--accent-2); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
main { padding: 10px 0 0; }
.meta { margin: 0 8px 10px; font-size: 12px; opacity: 0.8; }
.table-wrap { overflow: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: white; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border-bottom: 1px solid #ede8df; padding: 7px 8px; text-align: left; white-space: nowrap; }
th { background: #f1ebe2; position: sticky; top: 0; }
footer { padding: 8px 8px 10px; font-size: 12px; }
</style>
</head>
<body>
<header>
	<button class="primary" id="prev" ${previousDisabled}>Previous</button>
	<button class="primary" id="next" ${nextDisabled}>Next</button>
	<label>Rows:
		<select id="page-size">${options}</select>
	</label>
	<button id="csv">Export CSV</button>
	<button class="secondary" id="xlsx">Export Excel</button>
	<button id="clear">Clear Output</button>
</header>
<main>
	<div class="meta">Loaded rows: ${totalRows} | Showing ${start}-${Math.max(start, end)} | Offset: ${result.offset} | Page: ${pageNumber} | Query time: ${result.executionMs} ms</div>
	<div class="table-wrap">
		<table>
			<thead><tr>${th}</tr></thead>
			<tbody>${tr}</tbody>
		</table>
	</div>
</main>
<footer>${result.hasMore ? 'More rows available.' : 'End of result set reached.'}</footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('prev').addEventListener('click', () => vscode.postMessage({ type: 'prevPage' }));
document.getElementById('next').addEventListener('click', () => vscode.postMessage({ type: 'nextPage' }));
document.getElementById('page-size').addEventListener('change', (event) => vscode.postMessage({ type: 'setPageSize', value: event.target.value }));
document.getElementById('csv').addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
document.getElementById('xlsx').addEventListener('click', () => vscode.postMessage({ type: 'exportXlsx' }));
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clearOutput' }));
</script>
</body>
</html>`;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
