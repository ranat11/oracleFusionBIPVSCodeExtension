import * as vscode from 'vscode';

import { ParameterValueType, SavedConnection, SavedParameter } from '../models';
import { ConnectionManager } from '../services/connectionManager';

interface ConnectionsViewMessage {
	type: string;
	connectionId?: string;
	name?: string;
	originalName?: string;
	value?: string;
	parameterType?: ParameterValueType;
}

interface ConnectionsViewActions {
	onCreateConnection: () => Promise<void>;
	onSelectConnection: (connectionId: string) => Promise<void>;
	onEditConnection: (connectionId: string) => Promise<void>;
	onDeleteConnection: (connectionId: string) => Promise<void>;
	onCreateParameter: () => Promise<void>;
	onSaveParameter: (payload: { originalName?: string; name: string; value: string; type: ParameterValueType }) => Promise<SavedParameter>;
	onDeleteParameter: (name: string) => Promise<void>;
}

export class ConnectionsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'oracleFusionBIPVSCodeExtension.connectionsView';

	private view: vscode.WebviewView | undefined;

	public constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly actions: ConnectionsViewActions
	) {}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};
		webviewView.webview.onDidReceiveMessage((message: ConnectionsViewMessage) => {
			void this.handleMessage(message);
		});
		this.render();
	}

	public refresh(): void {
		this.render();
	}

	private async handleMessage(message: ConnectionsViewMessage): Promise<void> {
		switch (message.type) {
			case 'createConnection':
				await this.actions.onCreateConnection();
				this.render();
				break;
			case 'selectConnection':
				if (message.connectionId) {
					await this.actions.onSelectConnection(message.connectionId);
					this.render();
				}
				break;
			case 'editConnection':
				if (message.connectionId) {
					await this.actions.onEditConnection(message.connectionId);
					this.render();
				}
				break;
			case 'deleteConnection':
				if (message.connectionId) {
					await this.actions.onDeleteConnection(message.connectionId);
					this.render();
				}
				break;
			case 'createParameter':
				await this.actions.onCreateParameter();
				this.render();
				break;
			case 'saveParameter':
					if (message.name && typeof message.value === 'string') {
					try {
						const saved = await this.actions.onSaveParameter({
							originalName: message.originalName,
							name: message.name,
							value: message.value,
								type: 'auto'
						});
						await this.view?.webview.postMessage({
							type: 'parameterSaved',
							name: saved.name,
							savedType: saved.type
						});
					} catch (error) {
						await this.view?.webview.postMessage({
							type: 'parameterSaveError',
							name: message.name,
							message: error instanceof Error ? error.message : String(error)
						});
					}
				}
				break;
			case 'deleteParameter':
				if (message.name) {
					await this.actions.onDeleteParameter(message.name);
					this.render();
				}
				break;
			default:
				break;
		}
	}

	private render(): void {
		if (!this.view) {
			return;
		}

		this.view.webview.html = this.renderHtml();
	}

	private renderHtml(): string {
		const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const activeConnectionId = this.connectionManager.getActiveConnectionId();
		const connections = this.connectionManager.getAllConnections().sort((left, right) => left.name.localeCompare(right.name));
		const parameters = activeConnectionId ? this.connectionManager.getConnectionParameters(activeConnectionId) : [];

		const connectionRows = connections.length === 0
			? '<div class="empty">No saved connections</div>'
			: connections.map((connection) => this.renderConnectionRow(connection, connection.id === activeConnectionId)).join('');

		const parameterTable = activeConnectionId
			? this.renderParameterTable(parameters)
			: '<div class="empty">Select an active connection to manage parameters</div>';

		return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Connections</title>
<style>
:root {
	--bg: var(--vscode-sideBar-background);
	--surface: var(--vscode-editor-background);
	--surface-2: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
	--border: var(--vscode-panel-border);
	--ink: var(--vscode-foreground);
	--muted: var(--vscode-descriptionForeground);
	--accent: var(--vscode-button-background);
	--accent-ink: var(--vscode-button-foreground);
	--danger: var(--vscode-errorForeground);
	--input-bg: var(--vscode-input-background);
	--input-fg: var(--vscode-input-foreground);
	--input-border: var(--vscode-input-border);
	--active: var(--vscode-list-activeSelectionBackground);
	--active-border: var(--vscode-focusBorder);
	font-family: var(--vscode-font-family);
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: linear-gradient(180deg, var(--bg) 0%, var(--surface) 100%);
	color: var(--ink);
	padding: 10px;
}
.section {
	border: 1px solid var(--border);
	border-radius: 12px;
	overflow: hidden;
	background: var(--surface);
	margin-bottom: 12px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}
.section-toggle {
	list-style: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 12px;
	background: var(--surface-2);
	cursor: pointer;
	user-select: none;
	border-bottom: 1px solid transparent;
}
.section[open] .section-toggle {
	border-bottom-color: var(--border);
}
.section-toggle::-webkit-details-marker {
	display: none;
}
.section-toggle::before {
	content: '▸';
	font-size: 11px;
	color: var(--muted);
	transition: transform 120ms ease;
}
.section[open] .section-toggle::before {
	transform: rotate(90deg);
}
.section-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	flex: 1;
}
.section-title {
	font-size: 12px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--muted);
}
.toolbar {
	display: flex;
	gap: 8px;
}
.ghost, .solid, .icon-button {
	border: 1px solid var(--border);
	border-radius: 8px;
	background: transparent;
	color: var(--ink);
	cursor: pointer;
}
.ghost, .solid {
	padding: 6px 10px;
	font-size: 12px;
}
.solid {
	background: var(--accent);
	border-color: var(--accent);
	color: var(--accent-ink);
}
.connections {
	padding: 10px;
	display: grid;
	gap: 8px;
}
.connection-row {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 10px;
	padding: 10px;
	border: 1px solid var(--border);
	border-radius: 10px;
	background: var(--surface);
}
.connection-row.active {
	background: color-mix(in srgb, var(--active) 20%, var(--surface) 80%);
	border-color: var(--active-border);
}
.connection-meta {
	display: grid;
	gap: 4px;
	min-width: 0;
}
.connection-name {
	font-weight: 700;
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.badge {
	font-size: 11px;
	padding: 2px 7px;
	border-radius: 999px;
	border: 1px solid var(--active-border);
	color: var(--ink);
	background: color-mix(in srgb, var(--active) 25%, transparent 75%);
}
.connection-detail {
	font-size: 12px;
	color: var(--muted);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.actions {
	display: flex;
	gap: 6px;
	align-items: flex-start;
	flex-wrap: wrap;
}
.table-wrap {
	overflow: auto;
	padding: 10px;
}
table {
	width: 100%;
	border-collapse: collapse;
	font-size: 12px;
}
th, td {
	padding: 8px;
	border-bottom: 1px solid var(--border);
	vertical-align: middle;
	text-align: left;
}
th {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--muted);
	position: sticky;
	top: 0;
	background: var(--surface-2);
	z-index: 1;
}
input, select {
	width: 100%;
	padding: 6px 8px;
	border-radius: 8px;
	border: 1px solid var(--input-border);
	background: var(--input-bg);
	color: var(--input-fg);
	font: inherit;
}
.actions-cell {
	width: 1%;
	white-space: nowrap;
}
.type-cell {
	min-width: 110px;
}
.icon-button {
	width: 30px;
	height: 30px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 0;
	margin-right: 6px;
	background: var(--surface);
}
.icon-button.danger {
	color: var(--danger);
	border-color: color-mix(in srgb, var(--danger) 40%, var(--border) 60%);
}
.icon-button svg {
	width: 14px;
	height: 14px;
	fill: currentColor;
}
.empty {
	padding: 14px 12px;
	color: var(--muted);
	font-size: 12px;
}
.draft-note {
	padding: 0 10px 10px;
	font-size: 11px;
	color: var(--muted);
}
</style>
</head>
<body>
	<details class="section" open data-section="connections">
		<summary class="section-toggle">
			<div class="section-header">
				<div class="section-title">Connections</div>
				<div class="toolbar">
					<button class="ghost" data-action="createConnection" type="button">Add</button>
				</div>
			</div>
		</summary>
		<div class="connections">${connectionRows}</div>
	</details>

	<details class="section" open data-section="parameters">
		<summary class="section-toggle">
			<div class="section-header">
				<div class="section-title">Parameters</div>
				<div class="toolbar">
					<button class="ghost" data-action="addDraftRow" type="button" ${activeConnectionId ? '' : 'disabled'}>Add</button>
				</div>
			</div>
		</summary>
		${parameterTable}
	</details>

	<template id="draft-row-template">
		<tr data-original-name="">
			<td><input data-field="name" type="text" placeholder="P_PARAMETER" /></td>
			<td class="type-cell"><span data-type-label>Auto detect</span></td>
			<td><input data-field="value" type="text" placeholder="Parameter value" /></td>
			<td class="actions-cell">
				<button class="icon-button danger" data-action="deleteDraftRow" type="button" title="Remove row">${trashIcon()}</button>
			</td>
		</tr>
	</template>

	<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const parameterBody = document.getElementById('parameter-body');
	const draftTemplate = document.getElementById('draft-row-template');
	const state = vscode.getState() || { collapsed: {} };
	const saveTimers = new WeakMap();

	function post(message) {
		vscode.postMessage(message);
	}

	function createDraftRow() {
		if (!parameterBody || !draftTemplate) {
			return;
		}
		const fragment = draftTemplate.content.cloneNode(true);
		parameterBody.prepend(fragment);
		const firstInput = parameterBody.querySelector('tr input[data-field="name"]');
		if (firstInput) {
			firstInput.focus();
		}
	}

	function getRowPayload(row) {
		const name = row.querySelector('[data-field="name"]').value.trim();
		const typeField = row.querySelector('[data-field="type"]');
		const value = row.querySelector('[data-field="value"]').value;
		const originalName = row.dataset.originalName || undefined;
		const parameterType = typeField ? typeField.value : 'auto';
		return { name, parameterType, value, originalName };
	}

	function scheduleAutoSave(row, immediate = false) {
		if (!row) {
			return;
		}
		const payload = getRowPayload(row);
		if (!payload.name) {
			return;
		}

		const existing = saveTimers.get(row);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			post({ type: 'saveParameter', ...payload });
		}, immediate ? 0 : 300);
		saveTimers.set(row, timer);
	}

	for (const section of document.querySelectorAll('details[data-section]')) {
		const key = section.dataset.section;
		if (key && state.collapsed?.[key]) {
			section.open = false;
		}
		section.addEventListener('toggle', () => {
			const current = vscode.getState() || { collapsed: {} };
			const collapsed = { ...(current.collapsed || {}) };
			collapsed[key] = !section.open;
			vscode.setState({ ...current, collapsed });
		});
	}

	document.addEventListener('click', (event) => {
		const button = event.target.closest('button');
		if (!button) {
			return;
		}
		if (button.closest('.section-toggle')) {
			event.preventDefault();
			event.stopPropagation();
		}

		const action = button.dataset.action;
		if (!action) {
			return;
		}

		if (action === 'addDraftRow') {
			createDraftRow();
			return;
		}

		if (action === 'deleteDraftRow') {
			button.closest('tr')?.remove();
			return;
		}

		if (action === 'deleteParameter') {
			const name = button.dataset.name;
			if (!name) {
				return;
			}
			post({ type: 'deleteParameter', name });
			return;
		}

		post({
			type: action,
			connectionId: button.dataset.connectionId,
			name: button.dataset.name
		});
	});

	document.addEventListener('change', (event) => {
		const target = event.target;
		if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
			return;
		}
		const row = target.closest('tr');
		if (!row || !target.matches('[data-field]')) {
			return;
		}
		scheduleAutoSave(row, true);
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!parameterBody) {
			return;
		}
		if (message?.type === 'parameterSaved') {
			const savedName = String(message.name || '').toUpperCase();
			for (const row of parameterBody.querySelectorAll('tr')) {
				const payload = getRowPayload(row);
				const rowKey = (payload.originalName || payload.name || '').toUpperCase();
				if (rowKey !== savedName && payload.name.toUpperCase() !== savedName) {
					continue;
				}
				row.dataset.originalName = String(message.name || payload.name);
				const typeField = row.querySelector('[data-field="type"]');
				if (typeField && message.savedType) {
					typeField.value = String(message.savedType);
				}
				const typeLabel = row.querySelector('[data-type-label]');
				if (typeLabel && message.savedType) {
					typeLabel.textContent = String(message.savedType).charAt(0).toUpperCase() + String(message.savedType).slice(1);
				}
			}
			return;
		}
	});
	</script>
</body>
</html>`;
	}

	private renderConnectionRow(connection: SavedConnection, isActive: boolean): string {
		return `<div class="connection-row ${isActive ? 'active' : ''}">
			<div class="connection-meta">
				<div class="connection-name">
					<span>${escapeHtml(connection.name)}</span>
					${isActive ? '<span class="badge">Active</span>' : ''}
				</div>
				<div class="connection-detail">${escapeHtml(connection.username)} @ ${escapeHtml(connection.baseUrl)}</div>
			</div>
			<div class="actions">
				${isActive ? '' : `<button class="ghost" data-action="selectConnection" data-connection-id="${escapeHtml(connection.id)}" type="button">Use</button>`}
				<button class="ghost" data-action="editConnection" data-connection-id="${escapeHtml(connection.id)}" type="button">Edit</button>
				<button class="ghost" data-action="deleteConnection" data-connection-id="${escapeHtml(connection.id)}" type="button">Delete</button>
			</div>
		</div>`;
	}

	private renderParameterTable(parameters: SavedParameter[]): string {
		const rows = parameters.length === 0
			? '<tr><td colspan="4" class="empty">No parameters for active connection</td></tr>'
			: parameters.map((parameter) => this.renderParameterRow(parameter)).join('');

		return `<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Name</th>
						<th>Type</th>
						<th>Value</th>
						<th class="actions-cell"></th>
					</tr>
				</thead>
				<tbody id="parameter-body">${rows}</tbody>
			</table>
		</div>`;
	}

	private renderParameterRow(parameter: SavedParameter): string {
		return `<tr data-original-name="${escapeHtml(parameter.name)}">
			<td><input data-field="name" type="text" value="${escapeHtml(parameter.name)}" /></td>
			<td class="type-cell">
				<select data-field="type">
					${renderTypeOption('string', parameter.type === 'string')}
					${renderTypeOption('number', parameter.type === 'number')}
					${renderTypeOption('date', parameter.type === 'date')}
				</select>
			</td>
			<td><input data-field="value" type="text" value="${escapeHtml(parameter.value)}" /></td>
			<td class="actions-cell">
				<button class="icon-button danger" data-action="deleteParameter" data-name="${escapeHtml(parameter.name)}" type="button" title="Delete parameter">${trashIcon()}</button>
			</td>
		</tr>`;
	}
}

function renderTypeOption(value: Exclude<ParameterValueType, 'auto'>, selected: boolean): string {
	const label = value[0].toUpperCase() + value.slice(1);
	return `<option value="${value}" ${selected ? 'selected' : ''}>${label}</option>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;')
		.replace(/"/gu, '&quot;')
		.replace(/'/gu, '&#39;');
}

function trashIcon(): string {
	return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.75A.75.75 0 0 1 7.25 1h1.5a.75.75 0 0 1 .75.75V3h3a.75.75 0 0 1 0 1.5h-.56l-.53 7.42A1.75 1.75 0 0 1 9.66 13.5H6.34a1.75 1.75 0 0 1-1.75-1.58L4.06 4.5H3.5a.75.75 0 0 1 0-1.5h3ZM6 4.5l.52 7.31a.25.25 0 0 0 .25.19h2.46a.25.25 0 0 0 .25-.19L10 4.5Zm2-.5v-1h-.5v1Z"/></svg>';
}
