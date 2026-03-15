import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

import { inferSqlParameterType } from '../utils/sqlParameters';
import {
	ActiveConnection,
	ConnectionTestStatus,
	FIXED_REPORT_PATH,
	ParameterValueType,
	SavedConnection,
	SavedParameter,
	SavedParameterValueType,
	StoredConnections,
	StoredParametersByConnection
} from '../models';

const CONFIG_SECTION = 'oracleFusionBIPVSCodeExtension';
const PASSWORD_SECRET_KEY = 'oracleFusionBIPVSCodeExtension.password';
const CONNECTIONS_KEY = 'connections';
const ACTIVE_CONNECTION_KEY = 'activeConnectionId';
const PARAMETERS_BY_CONNECTION_KEY = 'parametersByConnection';

interface ConnectionFormValues {
	name: string;
	baseUrl: string;
	username: string;
	password: string;
}

export class ConnectionManager {
	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connectionTester?: (connection: ActiveConnection) => Promise<ConnectionTestStatus>,
		private readonly debugLog?: (message: string) => void,
		private readonly reportInstaller?: (connection: ActiveConnection) => Promise<void>
	) {}

	public async initialize(): Promise<void> {
		// No legacy migration/cleanup: new development expects manual connection creation.
	}

	public async configureConnection(): Promise<SavedConnection | undefined> {
		return this.createConnection();
	}

	public async createConnection(): Promise<SavedConnection | undefined> {
		const active = this.getActiveSavedConnection();
		const fallbackName = active ? `${active.name} Copy` : 'Connection 1';

		const form = await this.promptConnectionForm(
			{
				name: fallbackName,
				baseUrl: active?.baseUrl ?? '',
				username: active?.username ?? '',
				password: ''
			},
			{ title: 'Create Fusion BIP Connection', submitLabel: 'Save Connection', isEdit: false }
		);
		if (!form) {
			return undefined;
		}

		const now = new Date().toISOString();
		const saved: SavedConnection = {
			id: this.generateConnectionId(),
			name: form.name,
			baseUrl: form.baseUrl,
			username: form.username,
			reportPath: FIXED_REPORT_PATH,
			createdAt: now,
			updatedAt: now
		};

		await this.persistConnection(saved, form.password);
		return saved;
	}

	public async editConnection(connectionId: string): Promise<SavedConnection | undefined> {
		const stored = this.getStoredConnections();
		const index = stored.connections.findIndex((connection) => connection.id === connectionId);
		if (index === -1) {
			throw new Error('Selected connection no longer exists. Refresh and try again.');
		}

		const existing = stored.connections[index];
		const form = await this.promptConnectionForm(
			{
				name: existing.name,
				baseUrl: existing.baseUrl,
				username: existing.username,
				password: ''
			},
			{ title: 'Edit Fusion BIP Connection', submitLabel: 'Update Connection', isEdit: true, connectionId: existing.id }
		);
		if (!form) {
			return undefined;
		}

		const updated: SavedConnection = {
			...existing,
			name: form.name,
			baseUrl: form.baseUrl,
			username: form.username,
			reportPath: FIXED_REPORT_PATH,
			updatedAt: new Date().toISOString()
		};

		stored.connections[index] = updated;
		await this.persistStoredConnections(stored);
		if (form.password.length > 0) {
			await this.context.secrets.store(this.passwordSecretKey(connectionId), form.password);
		}

		return updated;
	}

	public async getActiveConnection(): Promise<ActiveConnection> {
		const active = this.getActiveSavedConnection();
		if (!active) {
			throw new Error('No active connection selected. Choose one from the BIP Connections panel.');
		}

		return this.toActiveConnection(active);
	}

	public async getConnectionById(connectionId: string): Promise<ActiveConnection> {
		const stored = this.getStoredConnections();
		const selected = stored.connections.find((connection) => connection.id === connectionId);
		if (!selected) {
			throw new Error('Selected connection no longer exists. Refresh and try again.');
		}

		return this.toActiveConnection({
			...selected,
			reportPath: FIXED_REPORT_PATH
		});
	}

	public getAllConnections(): SavedConnection[] {
		const stored = this.getStoredConnections();
		return stored.connections.map((connection) => ({
			...connection,
			reportPath: FIXED_REPORT_PATH
		}));
	}

	public getActiveConnectionId(): string | undefined {
		const stored = this.getStoredConnections();
		const exists = stored.connections.some((connection) => connection.id === stored.activeConnectionId);
		return exists ? stored.activeConnectionId : undefined;
	}

	public async setActiveConnection(connectionId: string): Promise<void> {
		const stored = this.getStoredConnections();
		const exists = stored.connections.some((connection) => connection.id === connectionId);
		if (!exists) {
			throw new Error('Selected connection no longer exists. Refresh and try again.');
		}
		stored.activeConnectionId = connectionId;
		await this.persistStoredConnections(stored);
	}

	public async deleteConnection(connectionId: string): Promise<void> {
		const stored = this.getStoredConnections();
		const remaining = stored.connections.filter((connection) => connection.id !== connectionId);
		if (remaining.length === stored.connections.length) {
			return;
		}

		if (stored.activeConnectionId === connectionId) {
			stored.activeConnectionId = remaining[0]?.id;
		}
		stored.connections = remaining;
		await this.persistStoredConnections(stored);
		const parametersByConnection = this.getStoredParametersByConnection();
		delete parametersByConnection[connectionId];
		await this.persistStoredParametersByConnection(parametersByConnection);
		await this.context.secrets.delete(this.passwordSecretKey(connectionId));
	}

	public getConnectionParameters(connectionId: string): SavedParameter[] {
		const parametersByConnection = this.getStoredParametersByConnection();
		return (parametersByConnection[connectionId] ?? []).slice().sort((left, right) => left.name.localeCompare(right.name));
	}

	public async upsertConnectionParameter(connectionId: string, parameter: { name: string; value: string; type: ParameterValueType }): Promise<SavedParameter> {
		const normalizedName = parameter.name.trim();
		if (normalizedName.length === 0) {
			throw new Error('Parameter name is required.');
		}
		const normalizedValue = parameter.value.trim();

		const parametersByConnection = this.getStoredParametersByConnection();
		const now = new Date().toISOString();
		const current = parametersByConnection[connectionId] ?? [];
		const existingIndex = current.findIndex((item) => item.name.toUpperCase() === normalizedName.toUpperCase());
		const normalizedType: SavedParameterValueType = parameter.type === 'auto' ? inferSqlParameterType(normalizedValue) : parameter.type;

		const nextParameter: SavedParameter = {
			name: normalizedName,
			value: normalizedValue,
			type: normalizedType,
			createdAt: existingIndex === -1 ? now : current[existingIndex].createdAt,
			updatedAt: now
		};

		if (existingIndex === -1) {
			current.push(nextParameter);
		} else {
			current[existingIndex] = nextParameter;
		}

		parametersByConnection[connectionId] = current;
		await this.persistStoredParametersByConnection(parametersByConnection);
		return nextParameter;
	}

	public async deleteConnectionParameter(connectionId: string, parameterName: string): Promise<void> {
		const parametersByConnection = this.getStoredParametersByConnection();
		const existing = parametersByConnection[connectionId] ?? [];
		const remaining = existing.filter((item) => item.name.toUpperCase() !== parameterName.toUpperCase());
		if (remaining.length === existing.length) {
			return;
		}

		parametersByConnection[connectionId] = remaining;
		await this.persistStoredParametersByConnection(parametersByConnection);
	}

	public async promptSelectConnection(placeHolder = 'Select a Fusion BIP connection'): Promise<SavedConnection | undefined> {
		const connections = this.getAllConnections();
		if (connections.length === 0) {
			return undefined;
		}

		const activeId = this.getActiveConnectionId();
		const pick = await vscode.window.showQuickPick(
			connections.map((connection) => ({
				label: connection.name,
				description: `${connection.username} @ ${connection.baseUrl}`,
				detail: connection.id === activeId ? 'Active connection' : undefined,
				connection
			})),
			{
				placeHolder,
				ignoreFocusOut: true
			}
		);

		return pick?.connection;
	}

	private getActiveSavedConnection(): SavedConnection | undefined {
		const stored = this.getStoredConnections();
		if (stored.connections.length === 0) {
			return undefined;
		}

		const byId = stored.connections.find((connection) => connection.id === stored.activeConnectionId);
		if (byId) {
			return {
				...byId,
				reportPath: FIXED_REPORT_PATH
			};
		}

		return {
			...stored.connections[0],
			reportPath: FIXED_REPORT_PATH
		};
	}

	private validateUrl(value: string): boolean {
		try {
			const parsed = new URL(value.trim());
			return parsed.protocol === 'https:' || parsed.protocol === 'http:';
		} catch {
			return false;
		}
	}

	private generateConnectionId(): string {
		try {
			return randomUUID();
		} catch {
			return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		}
	}

	private getStoredConnections(): StoredConnections {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const rawConnections = config.get<SavedConnection[]>(CONNECTIONS_KEY, []);
		const activeConnectionId = config.get<string>(ACTIVE_CONNECTION_KEY);
		const connections = rawConnections.map((connection) => ({
			...connection,
			reportPath: FIXED_REPORT_PATH,
			createdAt: connection.createdAt ?? new Date().toISOString(),
			updatedAt: connection.updatedAt ?? new Date().toISOString()
		}));

		return {
			activeConnectionId,
			connections
		};
	}

	private async persistConnection(connection: SavedConnection, password: string): Promise<void> {
		const stored = this.getStoredConnections();
		stored.connections.push(connection);
		stored.activeConnectionId = connection.id;
		await this.persistStoredConnections(stored);
		await this.context.secrets.store(this.passwordSecretKey(connection.id), password);
	}

	private async persistStoredConnections(stored: StoredConnections): Promise<void> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update(CONNECTIONS_KEY, stored.connections, vscode.ConfigurationTarget.Workspace);
		await config.update(ACTIVE_CONNECTION_KEY, stored.activeConnectionId, vscode.ConfigurationTarget.Workspace);
	}

	private getStoredParametersByConnection(): StoredParametersByConnection {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const raw = config.get<StoredParametersByConnection>(PARAMETERS_BY_CONNECTION_KEY, {});
		const now = new Date().toISOString();
		const normalized: StoredParametersByConnection = {};

		for (const [connectionId, parameters] of Object.entries(raw)) {
			if (!Array.isArray(parameters)) {
				continue;
			}

			normalized[connectionId] = parameters
				.filter((parameter): parameter is SavedParameter => {
					return !!parameter && typeof parameter.name === 'string' && typeof parameter.value === 'string';
				})
				.map((parameter) => ({
					name: parameter.name,
					value: parameter.value,
					type: parameter.type ?? 'auto',
					createdAt: parameter.createdAt ?? now,
					updatedAt: parameter.updatedAt ?? now
				}));
		}

		return normalized;
	}

	private async persistStoredParametersByConnection(parametersByConnection: StoredParametersByConnection): Promise<void> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update(PARAMETERS_BY_CONNECTION_KEY, parametersByConnection, vscode.ConfigurationTarget.Workspace);
	}

	private async toActiveConnection(connection: SavedConnection): Promise<ActiveConnection> {
		const password = await this.context.secrets.get(this.passwordSecretKey(connection.id));
		if (!password) {
			throw new Error(`Password is missing for connection "${connection.name}". Re-create the connection.`);
		}

		return {
			...connection,
			password
		};
	}

	private passwordSecretKey(connectionId: string): string {
		return `${PASSWORD_SECRET_KEY}.${connectionId}`;
	}

	private async promptConnectionForm(
		defaults: ConnectionFormValues,
		options: { title: string; submitLabel: string; isEdit: boolean; connectionId?: string }
	): Promise<ConnectionFormValues | undefined> {
		this.logDebug(`Opening connection form: ${options.title}`);
		const panel = vscode.window.createWebviewPanel(
			'oracleFusionBIPConnectionForm',
			options.title,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: false
			}
		);

		panel.webview.html = this.buildConnectionFormHtml(panel.webview, defaults, options);

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: ConnectionFormValues | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				disposables.forEach((disposable) => disposable.dispose());
				if (panel.visible) {
					panel.dispose();
				}
				this.logDebug(`Connection form closed: ${options.title}`);
				resolve(value);
			};

			const disposables: vscode.Disposable[] = [];
			disposables.push(
				panel.webview.onDidReceiveMessage(async (message: { type?: string; payload?: Partial<ConnectionFormValues> }) => {
					try {
						if (message.type === 'cancel') {
							finish(undefined);
							return;
						}

						if (message.type !== 'submit' && message.type !== 'test') {
							return;
						}

						const submitted = {
							name: (message.payload?.name ?? '').trim(),
							baseUrl: (message.payload?.baseUrl ?? '').trim().replace(/\/+$/, ''),
							username: (message.payload?.username ?? '').trim(),
							password: message.payload?.password ?? ''
						};
					if (message.type === 'submit' && !(message.payload as Record<string, unknown>)?.__testPassed) {
						void panel.webview.postMessage({ type: 'validationError', message: 'Please test the connection successfully before saving.' });
						return;
					}
						if (message.type === 'test') {
							const testValidationError = this.validateConnectionFieldsForTest(submitted);
							if (testValidationError) {
								void panel.webview.postMessage({ type: 'validationError', message: testValidationError });
								void panel.webview.postMessage({
									type: 'testResult',
									success: false,
									message: testValidationError,
									details: []
								});
								return;
							}

							this.logDebug(`Testing connection for user: ${submitted.username} at ${submitted.baseUrl}`);
							const testResult = await this.testConnectionFormValues(submitted, options.connectionId);
							this.logDebug(`Test finished. Success=${testResult.success}`);
							void panel.webview.postMessage({
								type: 'testResult',
								success: testResult.success,
								message: testResult.message,
								details: testResult.details
							});
							return;
						}

						const validationError = this.validateConnectionForm(submitted, options.isEdit);
						if (validationError) {
							void panel.webview.postMessage({ type: 'validationError', message: validationError });
							return;
						}

						finish(submitted);
					} catch (error) {
						const messageText = error instanceof Error ? error.message : String(error);
						this.logDebug(`Connection form handler error: ${messageText}`);
						void panel.webview.postMessage({ type: 'validationError', message: messageText });
						void panel.webview.postMessage({
							type: 'testResult',
							success: false,
							message: `Connection test failed: ${messageText}`,
							details: []
						});
					}
				})
			);

			disposables.push(panel.onDidDispose(() => finish(undefined)));
		});
	}

	private validateConnectionForm(values: ConnectionFormValues, isEdit: boolean): string | undefined {
		if (values.name.length === 0) {
			return 'Connection name is required.';
		}
		if (!this.validateUrl(values.baseUrl)) {
			return 'Enter a valid http/https URL.';
		}
		if (values.username.length === 0) {
			return 'Username is required.';
		}
		if (!isEdit && values.password.trim().length === 0) {
			return 'Password is required.';
		}
		return undefined;
	}

	private validateConnectionFieldsForTest(values: ConnectionFormValues): string | undefined {
		if (values.name.length === 0) {
			return 'Connection name is required.';
		}
		if (!this.validateUrl(values.baseUrl)) {
			return 'Enter a valid http/https URL.';
		}
		if (values.username.length === 0) {
			return 'Username is required.';
		}
		return undefined;
	}

	private async testConnectionFormValues(
		values: ConnectionFormValues,
		connectionId?: string
	): Promise<{ success: boolean; message: string; details: string[] }> {
		if (!this.connectionTester) {
			return {
				success: false,
				message: 'Connection tester is not configured in this extension build.',
				details: []
			};
		}

		let password = values.password;
		if (password.trim().length === 0 && connectionId) {
			password = (await this.context.secrets.get(this.passwordSecretKey(connectionId))) ?? '';
		}

		if (password.trim().length === 0) {
			return {
				success: false,
				message: 'Password is required to test this connection.',
				details: []
			};
		}

		const status = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Testing Fusion BIP connection',
				cancellable: false
			},
			() =>
				this.connectionTester!({
					baseUrl: values.baseUrl,
					username: values.username,
					password,
					reportPath: FIXED_REPORT_PATH
				})
		);

		if (status.urlReachable && status.credentialsValid && status.reportInstalled) {
			return {
				success: true,
				message: 'Connection test passed.',
				details: []
			};
		}

		if (status.faultType === 'invalid-credentials') {
			return {
				success: false,
				message: 'Invalid username or password. Please verify credentials.',
				details: []
			};
		}

		if (!status.credentialsValid) {
			return {
				success: false,
				message: status.faultMessage ?? 'Unable to validate credentials due to timeout/network error. Verify URL reachability and try again.',
				details: []
			};
		}

		if (!status.reportInstalled && status.urlReachable && status.credentialsValid && status.faultType === 'object-not-found') {
			if (this.reportInstaller) {
				const choice = await vscode.window.showInformationMessage(
					'The BIP report is not installed on this server. Would you like to install it now?',
					{ modal: true },
					'Install'
				);
				if (choice === 'Install') {
					try {
						await vscode.window.withProgress(
							{
								location: vscode.ProgressLocation.Notification,
								title: 'Installing Fusion BIP report',
								cancellable: false
							},
							() => this.reportInstaller!({
								baseUrl: values.baseUrl,
								username: values.username,
								password,
								reportPath: FIXED_REPORT_PATH
							})
						);
						return {
							success: true,
							message: 'Report installed successfully. Connection is ready.',
							details: []
						};
					} catch (installError) {
						const installMsg = installError instanceof Error ? installError.message : String(installError);
						return {
							success: false,
							message: `Report installation failed: ${installMsg}`,
							details: []
						};
					}
				}
			}
			return {
				success: false,
				message: `Report not found at ${status.reportPath}. Install the report and test again.`,
				details: []
			};
		}

		return {
			success: false,
			message: status.faultMessage ?? 'Connection test failed. Check URL and credentials.',
			details: []
		};
	}

	private logDebug(message: string): void {
		if (this.debugLog) {
			this.debugLog(message);
			return;
		}
		console.log(`[ConnectionForm] ${message}`);
	}

	private buildConnectionFormHtml(
		webview: vscode.Webview,
		defaults: ConnectionFormValues,
		options: { title: string; submitLabel: string; isEdit: boolean }
	): string {
		const nonce = this.generateNonce();
		const passwordHint = options.isEdit
			? 'Leave blank to keep the current saved password.'
			: 'Required for creating a new connection.';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${this.escapeHtml(options.title)}</title>
	<style>
		:root {
			color-scheme: light dark;
		}
		body {
			font-family: var(--vscode-font-family);
			margin: 0;
			padding: 24px;
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
		}
		form {
			max-width: 640px;
			margin: 0 auto;
			padding: 18px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			background: var(--vscode-sideBar-background);
		}
		h1 {
			margin: 0 0 16px;
			font-size: 1.2rem;
		}
		.field {
			display: grid;
			gap: 6px;
			margin-bottom: 14px;
		}
		label {
			font-weight: 600;
		}
		input {
			padding: 8px 10px;
			font-size: 0.95rem;
			color: var(--vscode-input-foreground);
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border);
			border-radius: 6px;
		}
		.hint {
			font-size: 0.84rem;
			opacity: 0.85;
		}
		.error {
			min-height: 20px;
			margin-bottom: 10px;
			color: var(--vscode-errorForeground);
		}
		.status {
			min-height: 20px;
			margin-bottom: 10px;
			color: var(--vscode-descriptionForeground);
		}
		.status.success {
			color: var(--vscode-testing-iconPassed);
		}
		.status.error {
			color: var(--vscode-errorForeground);
		}
		.details {
			margin: 0 0 12px;
			padding-left: 16px;
			font-size: 0.85rem;
			opacity: 0.9;
		}
		.actions {
			display: flex;
			gap: 10px;
			justify-content: flex-end;
		}
		button {
			padding: 8px 14px;
			border: 1px solid transparent;
			border-radius: 6px;
			cursor: pointer;
		}
		button.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.ghost {
			background: transparent;
			border-color: var(--vscode-button-border);
			color: var(--vscode-button-foreground);
		}
	</style>
</head>
<body>
	<form id="connection-form">
		<h1>${this.escapeHtml(options.title)}</h1>
		<div id="error" class="error" role="alert"></div>
		<div id="status" class="status" role="status"></div>
		<ul id="details" class="details" hidden></ul>

		<div class="field">
			<label for="name">Connection name</label>
			<input id="name" name="name" type="text" required value="${this.escapeHtml(defaults.name)}" />
		</div>

		<div class="field">
			<label for="baseUrl">Fusion base URL</label>
			<input id="baseUrl" name="baseUrl" type="url" required placeholder="https://example.fa.us2.oraclecloud.com" value="${this.escapeHtml(defaults.baseUrl)}" />
		</div>

		<div class="field">
			<label for="username">Fusion username</label>
			<input id="username" name="username" type="text" required value="${this.escapeHtml(defaults.username)}" />
		</div>

		<div class="field">
			<label for="password">Fusion password</label>
			<input id="password" name="password" type="password" ${options.isEdit ? '' : 'required'} />
			<div class="hint">${this.escapeHtml(passwordHint)}</div>
		</div>

		<div class="actions">
			<button id="cancel" type="button" class="secondary">Cancel</button>
			<button id="test" type="button" class="ghost">Test Connection</button>
			<button id="submit" type="submit" class="primary" disabled>${this.escapeHtml(options.submitLabel)}</button>
		</div>
	</form>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const form = document.getElementById('connection-form');
		const errorElement = document.getElementById('error');
		const statusElement = document.getElementById('status');
		const detailsElement = document.getElementById('details');
		const cancelButton = document.getElementById('cancel');
		const testButton = document.getElementById('test');
		const submitButton = document.getElementById('submit');
		const requireFreshTestForSubmit = ${options.isEdit ? 'true' : 'false'};

		let testPassed = false;
		let isTesting = false;

		const syncSubmitState = () => {
			submitButton.hidden = requireFreshTestForSubmit && !testPassed;
			submitButton.disabled = isTesting || !testPassed;
		};

		if (requireFreshTestForSubmit) {
			statusElement.textContent = 'Run Test Connection to enable update.';
			statusElement.className = 'status';
		}
		syncSubmitState();

		const collectPayload = () => {
			const formData = new FormData(form);
			return {
				name: String(formData.get('name') || ''),
				baseUrl: String(formData.get('baseUrl') || ''),
				username: String(formData.get('username') || ''),
				password: String(formData.get('password') || ''),
				__testPassed: testPassed
			};
		};

		const resetTestState = () => {
			if (!testPassed) { return; }
			testPassed = false;
			syncSubmitState();
			statusElement.textContent = 'Connection details changed — please test again before saving.';
			statusElement.className = 'status';
			detailsElement.hidden = true;
		};

		['name', 'baseUrl', 'username', 'password'].forEach((id) => {
			document.getElementById(id)?.addEventListener('input', resetTestState);
		});

		const renderDetails = (details) => {
			detailsElement.innerHTML = '';
			if (!Array.isArray(details) || details.length === 0) {
				detailsElement.hidden = true;
				return;
			}
			for (const line of details) {
				const item = document.createElement('li');
				item.textContent = String(line);
				detailsElement.appendChild(item);
			}
			detailsElement.hidden = false;
		};

		const setTestingState = (testing) => {
			isTesting = Boolean(testing);
			testButton.disabled = isTesting;
			cancelButton.disabled = isTesting;
			testButton.textContent = isTesting ? 'Testing...' : 'Test Connection';
			syncSubmitState();
		};

		document.getElementById('cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'cancel' });
		});

		document.getElementById('test').addEventListener('click', () => {
			errorElement.textContent = '';
			statusElement.textContent = 'Testing connection...';
			statusElement.className = 'status';
			renderDetails([]);
			setTestingState(true);
			vscode.postMessage({ type: 'test', payload: collectPayload() });
		});

		form.addEventListener('submit', (event) => {
			event.preventDefault();
			errorElement.textContent = '';
			vscode.postMessage({
				type: 'submit',
				payload: collectPayload()
			});
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message?.type === 'validationError') {
				errorElement.textContent = String(message.message || 'Please review the form values.');
				statusElement.textContent = '';
				renderDetails([]);
				setTestingState(false);
				return;
			}
			if (message?.type === 'testResult') {
				statusElement.textContent = String(message.message || 'Test finished.');
				statusElement.className = message.success ? 'status success' : 'status error';
				renderDetails(message.details);
				setTestingState(false);
				testPassed = message.success === true;
				syncSubmitState();
			}
		});

		window.addEventListener('error', () => {
			setTestingState(false);
		});
	</script>
</body>
</html>`;
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private generateNonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let nonce = '';
		for (let index = 0; index < 32; index += 1) {
			nonce += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return nonce;
	}

}
