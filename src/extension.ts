import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { createServer, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { toCsv, toXlsxBuffer } from './exporters';
import { ActiveConnection, FIXED_CATALOG_ROOT, ParameterValueType, QueryPage, QueryResult, SavedParameter } from './models';
import { registerBipQueryTool } from './mcp/registerTools';
import { ConnectionManager } from './services/connectionManager';
import { ReportInstaller } from './services/reportInstaller';
import { BipClient } from './services/soapClient';
import { ConnectionsViewProvider } from './ui/connectionsView';
import { ResultsPanel } from './ui/resultsPanel';
import { extractSqlParameters, resolveSqlParameters } from './utils/sqlParameters';
import { buildSqlHeaderTemplate, formatSqlDocument, SqlFormatterConfig } from './utils/sqlFormatter';
import { getRunnableSql } from './utils/sqlText';

const BUNDLED_REPORT_ZIP_PATH = ['fusion_report', 'VS Code Extension.zip'];
const BUNDLED_OBJECT_TYPE = 'xdrz';
const DEFAULT_PAGE_SIZE = 50;
const EXPORT_PAGE_SIZE = 500;
const SQL_LANGUAGE_IDS = new Set(['sql', 'plsql']);
const SQL_FILE_NAME_REGEX = /\.(sql|pls|plsql|pks|pkb|prc|fnc|trg)$/iu;

function getSqlFormatterConfig(): SqlFormatterConfig {
	const config = vscode.workspace.getConfiguration('oracleFusionBIPVSCodeExtension.sqlFormatter');
	const keywordCase = config.get<'upper' | 'lower' | 'preserve'>('keywordCase', 'upper');
	const identifierCase = config.get<'upper' | 'lower' | 'preserve'>('identifierCase', 'preserve');
	const commaPlacement = config.get<'trailing' | 'leading'>('commaPlacement', 'trailing');

	return {
		enabled: config.get<boolean>('enabled', true),
		keywordCase,
		identifierCase,
		indentSize: Math.max(1, config.get<number>('indentSize', 2)),
		alignAliases: config.get<boolean>('alignAliases', true),
		clauseBreaks: config.get<boolean>('clauseBreaks', true),
		commaPlacement,
		compactParenthesesWordLimit: Math.max(0, config.get<number>('compactParenthesesWordLimit', 5)),
	};
}

function createDefaultExportUri(extension: 'csv' | 'xlsx'): vscode.Uri {
	const downloadsPath = path.join(os.homedir(), 'Downloads');
	return vscode.Uri.file(path.join(downloadsPath, `bip-results-${Date.now()}.${extension}`));
}

function isSqlDocument(document: vscode.TextDocument): boolean {
	const languageId = document.languageId.toLowerCase();
	if (SQL_LANGUAGE_IDS.has(languageId) || languageId.includes('sql')) {
		return true;
	}

	return SQL_FILE_NAME_REGEX.test(document.fileName);
}

function resolveSqlFormatterLanguage(document: vscode.TextDocument): 'sql' | 'plsql' {
	const languageId = document.languageId.toLowerCase();
	if (languageId === 'plsql' || languageId.includes('oracle')) {
		return 'plsql';
	}
	return 'sql';
}

function getSqlFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
	if (!isSqlDocument(document)) {
		return [];
	}

	const config = getSqlFormatterConfig();
	if (!config.enabled) {
		return [];
	}

	const source = document.getText();
	const formatted = formatSqlDocument(source, config, resolveSqlFormatterLanguage(document));
	if (formatted === source) {
		return [];
	}

	const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
	return [vscode.TextEdit.replace(fullRange, formatted)];
}

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Fusion BIP');
	const client = new BipClient((message) => output.appendLine(`[BipClient] ${message}`));
	let activeQueryController: AbortController | undefined;
	let currentConnection: ActiveConnection | undefined;
	let currentBaseSql: string | undefined;
	let currentOffset = 0;
	let currentPageSize = DEFAULT_PAGE_SIZE;
	let currentPage: QueryPage | undefined;
	await vscode.commands.executeCommand('setContext', 'oracleFusionBIPVSCodeExtension.queryRunning', false);

	const setQueryRunningContext = async (running: boolean): Promise<void> => {
		await vscode.commands.executeCommand('setContext', 'oracleFusionBIPVSCodeExtension.queryRunning', running);
	};
	const installer = new ReportInstaller(client);
	const installBundledReport = async (connection: ActiveConnection): Promise<void> => {
		const zipPath = path.join(context.extensionPath, ...BUNDLED_REPORT_ZIP_PATH);
		await installer.installBundledZip(connection, zipPath, FIXED_CATALOG_ROOT, BUNDLED_OBJECT_TYPE);
	};
	const connectionManager = new ConnectionManager(
		context,
		async (connection) => client.testConnection(connection),
		(message) => output.appendLine(`[ConnectionForm] ${message}`),
		installBundledReport
	);
	await connectionManager.initialize();

	const handleCreateConnection = async (): Promise<void> => {
		const saved = await connectionManager.createConnection();
		if (!saved) {
			return;
		}
		connectionsViewProvider.refresh();
		vscode.window.showInformationMessage(`Connection "${saved.name}" saved.`);
	};

	const handleSetActiveConnection = async (selectedId: string): Promise<void> => {
		await connectionManager.setActiveConnection(selectedId);
		connectionsViewProvider.refresh();
		const active = connectionManager.getAllConnections().find((connection) => connection.id === selectedId);
		if (active) {
			vscode.window.setStatusBarMessage(`Active connection: ${active.name}`, 3000);
		}
	};

	const handleEditConnection = async (connectionId: string): Promise<void> => {
		const updated = await connectionManager.editConnection(connectionId);
		if (!updated) {
			return;
		}
		connectionsViewProvider.refresh();
		vscode.window.showInformationMessage(`Connection "${updated.name}" updated.`);
	};

	const handleDeleteConnection = async (connectionId: string): Promise<void> => {
		const target = connectionManager.getAllConnections().find((item) => item.id === connectionId);
		if (!target) {
			return;
		}

		const approved = await vscode.window.showWarningMessage(
			`Delete connection "${target.name}"?`,
			{ modal: true },
			'Delete'
		);
		if (approved !== 'Delete') {
			return;
		}

		await connectionManager.deleteConnection(target.id);
		connectionsViewProvider.refresh();
		vscode.window.showInformationMessage(`Connection "${target.name}" deleted.`);
	};

	const handleCreateParameter = async (): Promise<void> => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			vscode.window.showWarningMessage('Select an active connection first.');
			return;
		}

		const created = await promptParameterForm({ title: 'Create SQL parameter' });
		if (!created) {
			return;
		}

		await connectionManager.upsertConnectionParameter(activeConnectionId, created);
		connectionsViewProvider.refresh();
		vscode.window.showInformationMessage(`Parameter :${created.name} saved for active connection.`);
	};

	const handleSaveParameter = async (payload: { originalName?: string; name: string; value: string; type: ParameterValueType }): Promise<SavedParameter> => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			throw new Error('Select an active connection first.');
		}
		if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/u.test(payload.name.trim())) {
			throw new Error('Use Oracle bind style name: letters, digits, _, $, #.');
		}

		if (payload.originalName && payload.originalName.toUpperCase() !== payload.name.trim().toUpperCase()) {
			await connectionManager.deleteConnectionParameter(activeConnectionId, payload.originalName);
		}

		const saved = await connectionManager.upsertConnectionParameter(activeConnectionId, payload);
		vscode.window.setStatusBarMessage(`Saved parameter :${saved.name} (${saved.type})`, 2500);
		return saved;
	};

	const handleDeleteParameter = async (name: string): Promise<void> => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			return;
		}

		await connectionManager.deleteConnectionParameter(activeConnectionId, name);
		connectionsViewProvider.refresh();
		vscode.window.setStatusBarMessage(`Deleted parameter :${name}`, 2500);
	};

	const handleReorderParameters = async (orderedNames: string[]): Promise<void> => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			return;
		}
		await connectionManager.reorderConnectionParameters(activeConnectionId, orderedNames);
	};

	const connectionsViewProvider = new ConnectionsViewProvider(context.extensionUri, connectionManager, {
		onCreateConnection: handleCreateConnection,
		onSelectConnection: handleSetActiveConnection,
		onEditConnection: handleEditConnection,
		onDeleteConnection: handleDeleteConnection,
		onCreateParameter: handleCreateParameter,
		onSaveParameter: handleSaveParameter,
		onDeleteParameter: handleDeleteParameter,
		onReorderParameters: handleReorderParameters
	});
	const connectionsView = vscode.window.registerWebviewViewProvider(ConnectionsViewProvider.viewType, connectionsViewProvider, {
		webviewOptions: { retainContextWhenHidden: true }
	});

	let lastResult: QueryResult | undefined;

	const setRunning = async (running: boolean): Promise<void> => {
		await setQueryRunningContext(running);
	};

	const runPagedFetch = async (connection: ActiveConnection, baseSql: string, offset: number, pageSize: number, progressTitle: string): Promise<QueryPage> => {
		activeQueryController = new AbortController();
		await setRunning(true);
		try {
			output.appendLine(`[Query] Executing page fetch offset=${offset} pageSize=${pageSize}`);
			output.appendLine(`[Query] Base SQL: ${baseSql}`);
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: progressTitle,
					cancellable: false
				},
				() => client.runPagedQuery(connection, baseSql, offset, pageSize, activeQueryController?.signal)
			);

			output.appendLine(`[Query] Parsed rows=${result.rows.length}, columns=${result.columns.length}, hasMore=${result.hasMore}`);
			return result;
		} finally {
			activeQueryController = undefined;
			await setRunning(false);
		}
	};

	const fetchAllRowsForExport = async (): Promise<QueryResult | undefined> => {
		if (!currentConnection || !currentBaseSql) {
			vscode.window.showWarningMessage('No query context available. Run a query first.');
			return undefined;
		}

		activeQueryController = new AbortController();
		await setRunning(true);
		try {
			return await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Exporting full Fusion BIP result set',
					cancellable: false
				},
				async (progress) => {
					const rows: Array<Record<string, string>> = [];
					let columns: string[] = [];
					let offset = 0;
					let hasMore = true;

					while (hasMore) {
						const page = await client.runPagedQuery(currentConnection!, currentBaseSql!, offset, EXPORT_PAGE_SIZE, activeQueryController?.signal);
						if (columns.length === 0) {
							columns = page.columns;
						}
						rows.push(...page.rows);
						hasMore = page.hasMore;
						offset += page.pageSize;
						progress.report({ message: `Fetched ${rows.length} rows...` });
					}

					const fullResult: QueryResult = {
						columns,
						rows,
						executionMs: 0,
						query: currentBaseSql!,
						timestamp: new Date().toISOString()
					};

					output.appendLine(`[Export] Fetched total rows=${rows.length}`);
					lastResult = fullResult;
					return fullResult;
				}
			);
		} finally {
			activeQueryController = undefined;
			await setRunning(false);
		}
	};

	const resolveConnectionIdArg = (arg: unknown): string | undefined => {
		if (typeof arg === 'string' && arg.length > 0) {
			return arg;
		}
		if (!arg || typeof arg !== 'object') {
			return undefined;
		}

		const maybeWithId = arg as { id?: unknown };
		if (typeof maybeWithId.id === 'string' && maybeWithId.id.length > 0) {
			return maybeWithId.id;
		}

		const maybeTreeItem = arg as { connection?: { id?: unknown } };
		if (typeof maybeTreeItem.connection?.id === 'string' && maybeTreeItem.connection.id.length > 0) {
			return maybeTreeItem.connection.id;
		}

		return undefined;
	};

	const resolveParameterNameArg = (arg: unknown): string | undefined => {
		if (typeof arg === 'string' && arg.length > 0) {
			return arg;
		}
		if (!arg || typeof arg !== 'object') {
			return undefined;
		}

		const maybeWithName = arg as { name?: unknown };
		if (typeof maybeWithName.name === 'string' && maybeWithName.name.length > 0) {
			return maybeWithName.name;
		}

		const maybeTreeItem = arg as { parameter?: { name?: unknown } };
		if (typeof maybeTreeItem.parameter?.name === 'string' && maybeTreeItem.parameter.name.length > 0) {
			return maybeTreeItem.parameter.name;
		}

		return undefined;
	};

	const promptParameterForm = async (options: {
		initial?: SavedParameter;
		fixedName?: string;
		title: string;
	}): Promise<{ name: string; value: string; type: ParameterValueType } | undefined> => {
		const initialName = options.fixedName ?? options.initial?.name ?? '';
		const name = options.fixedName
			? options.fixedName
			: await vscode.window.showInputBox({
				prompt: `${options.title}: parameter name`,
				placeHolder: 'P_PARAMETER',
				ignoreFocusOut: true,
				value: initialName,
				validateInput: (value) => {
					const trimmed = value.trim();
					if (trimmed.length === 0) {
						return 'Parameter name is required.';
					}
					if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/u.test(trimmed)) {
						return 'Use Oracle bind style name: letters, digits, _, $, #.';
					}
					return undefined;
				}
			});

		if (!name) {
			return undefined;
		}

		const value = await vscode.window.showInputBox({
			prompt: `${options.title}: value for :${name.trim()}`,
			placeHolder: 'Parameter value',
			ignoreFocusOut: true,
			value: options.initial?.value ?? ''
		});
		if (typeof value !== 'string') {
			return undefined;
		}

		return {
			name: name.trim(),
			value,
			type: 'auto'
		};
	};

	const resolveConnection = async (): Promise<ActiveConnection | undefined> => {
		try {
			return await connectionManager.getActiveConnection();
		} catch {
			const all = connectionManager.getAllConnections();
			if (all.length === 0) {
				const action = await vscode.window.showWarningMessage('No saved connection. Create one now?', 'Create');
				if (action === 'Create') {
					const created = await connectionManager.createConnection();
					if (created) {
						connectionsViewProvider.refresh();
					}
				}
				return undefined;
			}

			let chosenId = connectionManager.getActiveConnectionId();
			if (!chosenId) {
				if (all.length === 1) {
					chosenId = all[0].id;
				} else {
					const selected = await connectionManager.promptSelectConnection('Select a connection to use');
					if (!selected) {
						return undefined;
					}
					chosenId = selected.id;
				}

				await connectionManager.setActiveConnection(chosenId);
				connectionsViewProvider.refresh();
			}

			return connectionManager.getActiveConnection();
		}
	};

	const panel = new ResultsPanel(
		context.extensionUri,
		async (direction) => {
			if (!currentConnection || !currentBaseSql || !currentPage) {
				vscode.window.showWarningMessage('Run a query first before navigating pages.');
				return;
			}

			if (direction === 'nextPage') {
				if (!currentPage.hasMore) {
					return;
				}
				const nextOffset = currentOffset + currentPageSize;
				const page = await runPagedFetch(currentConnection, currentBaseSql, nextOffset, currentPageSize, 'Loading next Fusion BIP page');
				currentOffset = page.offset;
				currentPage = page;
				lastResult = page;
				panel.show(page);
				return;
			}

			const previousOffset = Math.max(0, currentOffset - currentPageSize);
			const page = await runPagedFetch(currentConnection, currentBaseSql, previousOffset, currentPageSize, 'Loading previous Fusion BIP page');
			currentOffset = page.offset;
			currentPage = page;
			lastResult = page;
			panel.show(page);
		},
		async (pageSize) => {
			if (!currentConnection || !currentBaseSql) {
				vscode.window.showWarningMessage('Run a query first before changing page size.');
				return;
			}

			currentPageSize = pageSize === 'all' ? EXPORT_PAGE_SIZE : pageSize;
			const page = await runPagedFetch(currentConnection, currentBaseSql, 0, currentPageSize, 'Applying page size for Fusion BIP results');
			currentOffset = page.offset;
			currentPage = page;
			lastResult = page;
			panel.show(page);
		},
		async () => {
			const fullResult = await fetchAllRowsForExport();
			if (!fullResult) {
				return;
			}
			const target = await vscode.window.showSaveDialog({
				filters: { CSV: ['csv'] },
				saveLabel: 'Export CSV',
				defaultUri: createDefaultExportUri('csv')
			});
			if (!target) {
				return;
			}
			await vscode.workspace.fs.writeFile(target, Buffer.from(toCsv(fullResult), 'utf8'));
			vscode.window.showInformationMessage(`CSV exported: ${target.fsPath}`);
		},
		async () => {
			const fullResult = await fetchAllRowsForExport();
			if (!fullResult) {
				return;
			}
			const target = await vscode.window.showSaveDialog({
				filters: { Excel: ['xlsx'] },
				saveLabel: 'Export Excel',
				defaultUri: createDefaultExportUri('xlsx')
			});
			if (!target) {
				return;
			}
			await vscode.workspace.fs.writeFile(target, toXlsxBuffer(fullResult));
			vscode.window.showInformationMessage(`Excel exported: ${target.fsPath}`);
		},
		async () => {
			output.clear();
			lastResult = undefined;
			currentPage = undefined;
			currentBaseSql = undefined;
			currentOffset = 0;
			panel.clear();
			vscode.window.showInformationMessage('Fusion BIP output cleared.');
		}
	);

	const resultsView = vscode.window.registerWebviewViewProvider(ResultsPanel.viewType, panel, { webviewOptions: { retainContextWhenHidden: true } });

	const createConnection = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.createConnection', async () => {
		await handleCreateConnection();
	});

	const selectConnection = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.selectConnection', async () => {
		const selected = await connectionManager.promptSelectConnection();
		if (!selected) {
			return;
		}
		await handleSetActiveConnection(selected.id);
		vscode.window.showInformationMessage(`Active connection: ${selected.name}`);
	});

	const editConnection = vscode.commands.registerCommand(
		'oracleFusionBIPVSCodeExtension.editConnection',
		async (connectionArg?: unknown) => {
			const all = connectionManager.getAllConnections();
			if (all.length === 0) {
				vscode.window.showInformationMessage('No saved connections to edit.');
				return;
			}

			const connectionId = resolveConnectionIdArg(connectionArg);
			let target = all.find((item) => item.id === connectionId);
			if (!target) {
				target = await connectionManager.promptSelectConnection('Select a connection to edit');
			}
			if (!target) {
				return;
			}

			await handleEditConnection(target.id);
		}
	);

	const setActiveConnection = vscode.commands.registerCommand(
		'oracleFusionBIPVSCodeExtension.setActiveConnection',
		async (connectionArg?: unknown) => {
			let selectedId = resolveConnectionIdArg(connectionArg);
			if (!selectedId) {
				const selected = await connectionManager.promptSelectConnection();
				selectedId = selected?.id;
			}
			if (!selectedId) {
				return;
			}
			try {
				await handleSetActiveConnection(selectedId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to set active connection: ${message}`);
			}
		}
	);

	const deleteConnection = vscode.commands.registerCommand(
		'oracleFusionBIPVSCodeExtension.deleteConnection',
		async (connectionArg?: unknown) => {
			const all = connectionManager.getAllConnections();
			if (all.length === 0) {
				vscode.window.showInformationMessage('No saved connections to delete.');
				return;
			}

			const connectionId = resolveConnectionIdArg(connectionArg);
			let target = all.find((item) => item.id === connectionId);
			if (!target) {
				target = await connectionManager.promptSelectConnection('Select a connection to delete');
			}
			if (!target) {
				return;
			}

			await handleDeleteConnection(target.id);
		}
	);

	const configureConnection = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.configureConnection', async () => {
		await handleCreateConnection();
	});

	const installReport = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.installReport', async () => {
		try {
			const connection = await resolveConnection();
			if (!connection) {
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Installing Fusion BIP report bundle',
					cancellable: false
				},
				() => installBundledReport(connection)
			);
			vscode.window.showInformationMessage('Report installation finished successfully.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Install failed: ${message}`);
		}
	});

	const stopQuery = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.stopQuery', async () => {
		if (!activeQueryController) {
			vscode.window.showInformationMessage('No Fusion BIP query is currently running.');
			return;
		}

		activeQueryController.abort();
		vscode.window.setStatusBarMessage('Stopping Fusion BIP query...', 3000);
	});

	const runQuery = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.runQuery', async () => {
		if (activeQueryController) {
			vscode.window.showWarningMessage('A Fusion BIP query is already running. Use Stop Query to cancel it first.');
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a SQL editor to run a BIP query.');
			return;
		}

		const sql = getRunnableSql(editor);
		if (!sql) {
			vscode.window.showWarningMessage('No SQL found to run. Select SQL or add SQL to the current editor.');
			return;
		}

		try {
			const connection = await resolveConnection();
			if (!connection) {
				return;
			}

			const activeConnectionId = connectionManager.getActiveConnectionId();
			if (!activeConnectionId) {
				vscode.window.showErrorMessage('No active connection selected. Choose one from the Connections panel.');
				return;
			}

			const extractedParameters = extractSqlParameters(sql);
			if (extractedParameters.length > 0) {
				let connectionParameters = connectionManager.getConnectionParameters(activeConnectionId);
				const existingNames = new Set(connectionParameters.map((parameter) => parameter.name.toUpperCase()));

				for (const parameterName of extractedParameters) {
					if (existingNames.has(parameterName.toUpperCase())) {
						continue;
					}

					const created = await promptParameterForm({
						title: 'Create SQL parameter',
						fixedName: parameterName
					});
					if (!created) {
						continue;
					}

					await connectionManager.upsertConnectionParameter(activeConnectionId, created);
					existingNames.add(created.name.toUpperCase());
				}

				connectionParameters = connectionManager.getConnectionParameters(activeConnectionId);
				const resolved = resolveSqlParameters(sql, connectionParameters);
				if (resolved.unresolvedParameters.length > 0) {
					vscode.window.showWarningMessage(`Unresolved SQL parameters: ${resolved.unresolvedParameters.join(', ')}. Query will run with unresolved placeholders.`);
				}

				currentConnection = connection;
				currentBaseSql = resolved.sql;
				currentOffset = 0;
				const result = await runPagedFetch(connection, resolved.sql, currentOffset, currentPageSize, 'Running Fusion BIP query');
				lastResult = result;
				currentPage = result;
				connectionsViewProvider.refresh();
				panel.show(result);
				return;
			}

			currentConnection = connection;
			currentBaseSql = sql;
			currentOffset = 0;
			const result = await runPagedFetch(connection, sql, currentOffset, currentPageSize, 'Running Fusion BIP query');
			lastResult = result;
			currentPage = result;
			panel.show(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const normalized = message.toLowerCase();
			if (normalized.includes('aborted')) {
				vscode.window.showInformationMessage('Fusion BIP query stopped.');
			} else {
				vscode.window.showErrorMessage(message);
			}
		}
	});

	const createParameter = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.createParameter', async () => {
		await handleCreateParameter();
	});

	const editParameter = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.editParameter', async (parameterArg?: unknown) => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			vscode.window.showWarningMessage('Select an active connection first.');
			return;
		}

		const parameters = connectionManager.getConnectionParameters(activeConnectionId);
		if (parameters.length === 0) {
			vscode.window.showInformationMessage('No parameters found for active connection.');
			return;
		}

		const parameterNameArg = resolveParameterNameArg(parameterArg);
		let target = parameters.find((parameter) => parameter.name.toUpperCase() === parameterNameArg?.toUpperCase());
		if (!target) {
			const pick = await vscode.window.showQuickPick(
				parameters.map((parameter) => ({
					label: parameter.name,
					description: `${parameter.value} (${parameter.type})`,
					parameter
				})),
				{ placeHolder: 'Select a parameter to edit', ignoreFocusOut: true }
			);
			target = pick?.parameter;
		}

		if (!target) {
			return;
		}

		const edited = await promptParameterForm({ title: 'Edit SQL parameter', initial: target, fixedName: target.name });
		if (!edited) {
			return;
		}

		await handleSaveParameter({ originalName: target.name, ...edited });
		vscode.window.showInformationMessage(`Parameter :${edited.name} updated.`);
	});

	const deleteParameter = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.deleteParameter', async (parameterArg?: unknown) => {
		const activeConnectionId = connectionManager.getActiveConnectionId();
		if (!activeConnectionId) {
			vscode.window.showWarningMessage('Select an active connection first.');
			return;
		}

		const parameters = connectionManager.getConnectionParameters(activeConnectionId);
		if (parameters.length === 0) {
			vscode.window.showInformationMessage('No parameters found for active connection.');
			return;
		}

		const parameterNameArg = resolveParameterNameArg(parameterArg);
		let target = parameters.find((parameter) => parameter.name.toUpperCase() === parameterNameArg?.toUpperCase());
		if (!target) {
			const pick = await vscode.window.showQuickPick(
				parameters.map((parameter) => ({
					label: parameter.name,
					description: `${parameter.value} (${parameter.type})`,
					parameter
				})),
				{ placeHolder: 'Select a parameter to delete', ignoreFocusOut: true }
			);
			target = pick?.parameter;
		}

		if (!target) {
			return;
		}

		const approved = await vscode.window.showWarningMessage(
			`Delete parameter :${target.name} from active connection?`,
			{ modal: true },
			'Delete'
		);
		if (approved !== 'Delete') {
			return;
		}

		await handleDeleteParameter(target.name);
		vscode.window.showInformationMessage(`Parameter :${target.name} deleted.`);
	});

	const exportCsv = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.exportCsv', async () => {
		const fullResult = await fetchAllRowsForExport();
		if (!fullResult) {
			return;
		}
		const target = await vscode.window.showSaveDialog({
			filters: { CSV: ['csv'] },
			saveLabel: 'Export CSV',
			defaultUri: createDefaultExportUri('csv')
		});
		if (!target) {
			return;
		}
		await vscode.workspace.fs.writeFile(target, Buffer.from(toCsv(fullResult), 'utf8'));
		vscode.window.showInformationMessage(`CSV exported: ${target.fsPath}`);
	});

	const exportXlsx = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.exportXlsx', async () => {
		const fullResult = await fetchAllRowsForExport();
		if (!fullResult) {
			return;
		}
		const target = await vscode.window.showSaveDialog({
			filters: { Excel: ['xlsx'] },
			saveLabel: 'Export Excel',
			defaultUri: createDefaultExportUri('xlsx')
		});
		if (!target) {
			return;
		}
		await vscode.workspace.fs.writeFile(target, toXlsxBuffer(fullResult));
		vscode.window.showInformationMessage(`Excel exported: ${target.fsPath}`);
	});

	const clearOutput = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.clearOutput', async () => {
		output.clear();
		lastResult = undefined;
		currentPage = undefined;
		currentBaseSql = undefined;
		currentOffset = 0;
		panel.clear();
		vscode.window.showInformationMessage('Fusion BIP output cleared.');
	});

	const sqlFormattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
		[{ language: 'sql' }, { language: 'plsql' }],
		{
			provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
				return getSqlFormattingEdits(document);
			}
		}
	);

	const sqlFormatOnSave = vscode.workspace.onWillSaveTextDocument((event) => {
		const formatOnSaveEnabled = vscode.workspace
			.getConfiguration('oracleFusionBIPVSCodeExtension.sqlFormatter')
			.get<boolean>('formatOnSave', false);
		if (!formatOnSaveEnabled) {
			return;
		}

		if (event.reason !== vscode.TextDocumentSaveReason.Manual) {
			return;
		}

		event.waitUntil(Promise.resolve(getSqlFormattingEdits(event.document)));
	});

	const toggleSqlFormatter = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.toggleSqlFormatter', async () => {
		const config = vscode.workspace.getConfiguration('oracleFusionBIPVSCodeExtension.sqlFormatter');
		const currentlyEnabled = config.get<boolean>('enabled', true);
		const nextValue = !currentlyEnabled;
		await config.update('enabled', nextValue, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`SQL formatter ${nextValue ? 'enabled' : 'disabled'}.`);
	});

	const insertSqlHeaderTemplate = vscode.commands.registerCommand('oracleFusionBIPVSCodeExtension.insertSqlHeaderTemplate', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Open a SQL editor before inserting a header template.');
			return;
		}

		if (!isSqlDocument(editor.document)) {
			vscode.window.showWarningMessage('Header template is available only for SQL documents.');
			return;
		}

		const templateConfig = vscode.workspace.getConfiguration('oracleFusionBIPVSCodeExtension.sqlFormatter');
		const configuredTemplate = templateConfig.get<string>('headerTemplate', '').trim();
		const headerAuthorName = templateConfig.get<string>('headerAuthorName', 'Ranatchai');
		const template = configuredTemplate.length > 0
			? `${configuredTemplate}\n\n`
			: buildSqlHeaderTemplate(path.basename(editor.document.fileName), headerAuthorName);

		await editor.edit((editBuilder) => {
			editBuilder.insert(new vscode.Position(0, 0), template);
		});
	});

	// ─── MCP Server Definition Provider ───────────────────────────────────────
	// Host the MCP server inside the extension process so tool execution can use
	// the same ConnectionManager + secret storage path as the main extension.
	const mcpDidChange = new vscode.EventEmitter<void>();
	const mcpAuthToken = randomUUID();
	let mcpUri: vscode.Uri | undefined;
	let mcpServerReady: Promise<vscode.Uri> | undefined;
	let mcpHttpServer: ReturnType<typeof createServer> | undefined;

	const writeJsonError = (res: ServerResponse, statusCode: number, message: string): void => {
		res.statusCode = statusCode;
		res.setHeader('content-type', 'application/json');
		res.end(
			JSON.stringify({
				jsonrpc: '2.0',
				error: {
					code: statusCode === 405 ? -32000 : -32603,
					message,
				},
				id: null,
			})
		);
	};

	const ensureMcpHttpServer = async (): Promise<vscode.Uri> => {
		if (mcpUri) {
			return mcpUri;
		}
		if (mcpServerReady) {
			return mcpServerReady;
		}

		mcpServerReady = new Promise<vscode.Uri>((resolve, reject) => {
			const httpServer = createServer(async (req, res) => {
				if (req.url !== '/mcp') {
					res.statusCode = 404;
					res.end();
					return;
				}

				const authHeader = req.headers['authorization'];
				if (authHeader !== `Bearer ${mcpAuthToken}`) {
					res.statusCode = 401;
					res.end('Unauthorized');
					return;
				}

				if (req.method !== 'POST') {
					writeJsonError(res, 405, 'Method not allowed.');
					return;
				}

				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
				});
				const mcpServer = new McpServer({
					name: 'oracle-fusion-bip',
					version: '0.0.2',
				});

				registerBipQueryTool(mcpServer, async () => connectionManager.getActiveConnection());

				try {
					await mcpServer.connect(transport);
					res.on('close', () => {
						void transport.close();
						void mcpServer.close();
					});
					await transport.handleRequest(req, res);
				} catch (error) {
					output.appendLine(`[MCP] ${error instanceof Error ? error.message : String(error)}`);
					if (!res.headersSent) {
						writeJsonError(res, 500, 'Internal server error');
					}
					void transport.close();
					void mcpServer.close();
				}
			});

			httpServer.once('error', (error) => {
				mcpServerReady = undefined;
				reject(error);
			});

			httpServer.listen(0, '127.0.0.1', () => {
				const address = httpServer.address();
				if (!address || typeof address === 'string') {
					mcpServerReady = undefined;
					reject(new Error('Unable to determine MCP server address.'));
					return;
				}

				mcpHttpServer = httpServer;
				mcpUri = vscode.Uri.parse(`http://127.0.0.1:${address.port}/mcp`);
				resolve(mcpUri);
			});
		});

		return mcpServerReady;
	};

	const mcpProvider: vscode.McpServerDefinitionProvider = {
		onDidChangeMcpServerDefinitions: mcpDidChange.event,
		async provideMcpServerDefinitions(): Promise<vscode.McpHttpServerDefinition[]> {
			const uri = await ensureMcpHttpServer();
			return [
				new vscode.McpHttpServerDefinition(
					'Oracle Fusion BIP',
					uri,
					{ Authorization: `Bearer ${mcpAuthToken}` },
					'0.0.2'
				),
			];
		},
	};

	const mcpRegistration = vscode.lm.registerMcpServerDefinitionProvider(
		'oracleFusionBIPVSCodeExtension.mcp',
		mcpProvider
	);

	context.subscriptions.push(
		output,
		connectionsView,
		resultsView,
		createConnection,
		selectConnection,
		editConnection,
		setActiveConnection,
		deleteConnection,
		configureConnection,
		createParameter,
		editParameter,
		deleteParameter,
		installReport,
		stopQuery,
		runQuery,
		exportCsv,
		exportXlsx,
		clearOutput,
		sqlFormattingProvider,
		sqlFormatOnSave,
		toggleSqlFormatter,
		insertSqlHeaderTemplate,
		mcpRegistration,
		mcpDidChange,
		new vscode.Disposable(() => {
			mcpUri = undefined;
			mcpServerReady = undefined;
			if (mcpHttpServer) {
				mcpHttpServer.close();
				mcpHttpServer = undefined;
			}
		})
	);
}

export function deactivate() {}
