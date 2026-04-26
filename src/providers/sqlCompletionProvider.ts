import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface SchemaTable {
	table_name: string;
	description: string;
	columns: Array<{
		column_name: string;
		description: string;
		data_type: string;
	}>;
	primary_key: Array<{
		name: string;
		columns: string;
	}>;
	foreign_keys: Array<{
		table: string;
		foreign_table: string;
		foreign_key_column: string;
	}>;
	indexes: Array<{
		index: string;
		uniqueness: string;
		tablespace: string;
		columns: string;
	}>;
}

type UsageStats = Record<string, number>;

export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
	private schemas = new Map<string, SchemaTable>();
	private initialized = false;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	public async initialize() {
		if (this.initialized) return;

		const extensionPath = this.context.extensionPath;
		const files = ['common_26b.json', 'financials_26b.json', 'procurement_26b.json'];

		for (const file of files) {
			const filePath = path.join(extensionPath, 'fusion_report', file);
			if (fs.existsSync(filePath)) {
				try {
					const data = await fs.promises.readFile(filePath, 'utf8');
					const tables: SchemaTable[] = JSON.parse(data);
					for (const table of tables) {
						this.schemas.set(table.table_name.toUpperCase(), table);
					}
				} catch (error) {
					console.error(`Failed to load schema file ${file}:`, error);
				}
			}
		}

		this.initialized = true;
	}

	private getUsageRank(type: 'table' | 'column', name: string): number {
		const stats = this.context.globalState.get<UsageStats>('oracleFusionBIPVSCodeExtension.sqlUsageStats', {});
		return stats[`${type}:${name}`] || 0;
	}

	public async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<vscode.Hover | undefined> {
		await this.initialize();

		// Check for word with dot: e.g. alias.column
		const rangeWithDot = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_$#]+\.[a-zA-Z0-9_$#]+/);
		if (rangeWithDot) {
			const word = document.getText(rangeWithDot);
			const parts = word.split('.');
			if (parts.length === 2) {
				const alias = parts[0].toUpperCase();
				const columnName = parts[1].toUpperCase();
				const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
				const aliasMap = this.extractAliases(textBefore);
				const tableName = aliasMap.get(alias) || alias;
				
				const schema = this.schemas.get(tableName);
				if (schema) {
					const col = schema.columns.find(c => c.column_name.toUpperCase() === columnName);
					if (col) {
						const md = new vscode.MarkdownString();
						md.appendMarkdown(`**${schema.table_name}.${col.column_name}**\n\n`);
						md.appendMarkdown(`**Type:** \`${col.data_type}\`\n\n`);
						if (col.description) {
							md.appendMarkdown(`${col.description}`);
						}
						return new vscode.Hover(md, rangeWithDot);
					}
				}
			}
		}

		const range = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_$#]+/);
		if (!range) return undefined;
		const word = document.getText(range).toUpperCase();

		const schema = this.schemas.get(word);
		if (schema) {
			const md = new vscode.MarkdownString();
			md.appendMarkdown(`**Table:** \`${schema.table_name}\`\n\n`);
			if (schema.description) {
				md.appendMarkdown(`${schema.description}\n\n`);
			}
			
			if (schema.primary_key && schema.primary_key.length > 0) {
				md.appendMarkdown(`**Primary Key:** ${schema.primary_key.map(pk => pk.columns).join(', ')}\n\n`);
			}
			
			md.appendMarkdown(`*Columns: ${schema.columns.length}*`);
			return new vscode.Hover(md, range);
		}

		// Maybe it's a column without alias?
		const textBefore = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const aliasList = this.extractAliasList(textBefore);
		for (const { tableName } of aliasList) {
			const tableSchema = this.schemas.get(tableName);
			if (tableSchema) {
				const col = tableSchema.columns.find(c => c.column_name.toUpperCase() === word);
				if (col) {
					const md = new vscode.MarkdownString();
					md.appendMarkdown(`**${tableSchema.table_name}.${col.column_name}**\n\n`);
					md.appendMarkdown(`**Type:** \`${col.data_type}\`\n\n`);
					if (col.description) {
						md.appendMarkdown(`${col.description}`);
					}
					return new vscode.Hover(md, range);
				}
			}
		}

		return undefined;
	}

	public async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[]> {
		await this.initialize();

		const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const fullDocumentText = document.getText();

		const items: vscode.CompletionItem[] = [];

		// Context 0: Alias Dot (e.g. aia.)
		const dotMatch = /([a-zA-Z0-9_$#]+)\.([a-zA-Z0-9_$#]*)$/.exec(textBeforeCursor);
		if (dotMatch) {
			const alias = dotMatch[1].toUpperCase();
			// If we are in a SELECT context, we might need full text to find tables defined later
			const isSelectContext = /\bselect\b[^;]*$/i.test(textBeforeCursor);
			const textToSearch = isSelectContext ? fullDocumentText : textBeforeCursor;
			
			const aliasMap = this.extractAliases(textToSearch);
			const tableName = aliasMap.get(alias) || alias;
			
			const tableSchema = this.schemas.get(tableName);
			if (tableSchema) {
				for (const col of tableSchema.columns) {
					const item = new vscode.CompletionItem(col.column_name, vscode.CompletionItemKind.Field);
					item.detail = col.data_type;
					item.documentation = new vscode.MarkdownString(col.description);
					const rank = this.getUsageRank('column', `${tableName}.${col.column_name}`);
					item.sortText = `${(10000 - rank).toString().padStart(5, '0')}_${col.column_name}`;
					item.command = {
						command: 'oracleFusionBIPVSCodeExtension.trackUsage',
						title: 'Track Usage',
						arguments: ['column', `${tableName}.${col.column_name}`]
					};
					items.push(item);
				}
			}
			return items;
		}

		// Context 1: Alias suggestion (after table name)
		const aliasContextMatch = /(?:from|join|update|,)\s+([a-zA-Z0-9_$#.]+)\s+(?:as\s+)?([a-zA-Z0-9_$#]*)$/i.exec(textBeforeCursor);
		if (aliasContextMatch) {
			let tableName = aliasContextMatch[1].toUpperCase();
			if (tableName.includes('.')) {
				tableName = tableName.split('.').pop() || tableName;
			}
			
			if (this.schemas.has(tableName)) {
				const suggestedAlias = this.generateAlias(tableName);
				
				const item = new vscode.CompletionItem(suggestedAlias, vscode.CompletionItemKind.Variable);
				item.detail = `Alias for ${tableName}`;
				item.insertText = suggestedAlias;
				item.sortText = `00000_alias`;
				items.push(item);
				return items; 
			}
		}

		// Context 2: Table suggestion (after FROM, JOIN, or comma)
		const tableContextMatch = /(?:from|join|,)\s+([a-zA-Z0-9_$#.]*)$/i.exec(textBeforeCursor);
		if (tableContextMatch) {
			const isJoin = /(?:join)\s+[a-zA-Z0-9_$#.]*$/i.test(textBeforeCursor);
			let previousTables: Array<{tableName: string, alias: string}> = [];
			
			if (isJoin) {
				const lastKeywordMatch = textBeforeCursor.match(/(?:from|join|,)\s+[a-zA-Z0-9_$#.]*$/i);
				if (lastKeywordMatch) {
					const textBeforeKeyword = textBeforeCursor.substring(0, lastKeywordMatch.index);
					previousTables = this.extractAliasList(textBeforeKeyword);
				}
			}

			for (const [tableName, schema] of this.schemas.entries()) {
				const alias = this.generateAlias(tableName);
				const label = `${tableName} ${alias}`;
				const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Class);
				item.insertText = label;
				item.filterText = tableName; // prioritize table name for filtering
				
				item.detail = `Table with alias ${alias} - ${schema.description?.substring(0, 100)}`;
				item.documentation = new vscode.MarkdownString(schema.description);
				const rank = this.getUsageRank('table', tableName);
				
				let fkRank = 999;
				if (isJoin && previousTables.length > 0) {
					fkRank = this.getFkRank(tableName, previousTables);
				}
				
				item.sortText = `${fkRank.toString().padStart(3, '0')}_${(10000 - rank).toString().padStart(5, '0')}_${tableName}`;
				item.command = {
					command: 'oracleFusionBIPVSCodeExtension.trackUsage',
					title: 'Track Usage',
					arguments: ['table', tableName]
				};
				items.push(item);
			}
			return items;
		}

		// Context 3: JOIN Condition (after ON)
		const onContextMatch = /\bon\s+([a-zA-Z0-9_$#]*)$/i.exec(textBeforeCursor);
		if (onContextMatch) {
			const aliasMapList = this.extractAliasList(textBeforeCursor);
			if (aliasMapList.length >= 2) {
				const current = aliasMapList[aliasMapList.length - 1];
				
				for (let i = aliasMapList.length - 2; i >= 0; i--) {
					const prev = aliasMapList[i];
					const condition = this.findJoinCondition(current.tableName, current.alias, prev.tableName, prev.alias);
					if (condition) {
						const item = new vscode.CompletionItem(condition, vscode.CompletionItemKind.Snippet);
						item.insertText = new vscode.SnippetString(condition);
						item.detail = `Join ${current.tableName} with ${prev.tableName}`;
						item.documentation = new vscode.MarkdownString(`Based on foreign key relationship.`);
						item.sortText = `00000_join`;
						items.push(item);
					}
				}
			}
		}

		// Context 4: Column suggestion (after SELECT, WHERE, AND, OR, HAVING, BY, ON)
		const columnContextMatch = /(?:select|where|and|or|having|by|on)\s+([a-zA-Z0-9_$#]*)$/i.exec(textBeforeCursor);
		if (columnContextMatch || onContextMatch) {
			const isSelectContext = /\bselect\s+[a-zA-Z0-9_$#]*$/i.test(textBeforeCursor);
			const textToSearch = isSelectContext ? fullDocumentText : textBeforeCursor;
			const aliasMapList = this.extractAliasList(textToSearch);
			if (aliasMapList.length > 0) {
				for (const entry of aliasMapList) {
					const tableSchema = this.schemas.get(entry.tableName);
					if (tableSchema) {
						for (const col of tableSchema.columns) {
							const insertText = entry.alias !== entry.tableName ? `${entry.alias}.${col.column_name}` : col.column_name;
							const label = `${col.column_name} (${entry.alias || entry.tableName})`;
							
							const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
							item.insertText = insertText;
							item.filterText = col.column_name;
							item.detail = `${tableSchema.table_name}.${col.column_name} - ${col.data_type}`;
							item.documentation = new vscode.MarkdownString(col.description);
							
							const rank = this.getUsageRank('column', `${entry.tableName}.${col.column_name}`);
							item.sortText = `${(10000 - rank).toString().padStart(5, '0')}_${col.column_name}`;
							item.command = {
								command: 'oracleFusionBIPVSCodeExtension.trackUsage',
								title: 'Track Usage',
								arguments: ['column', `${entry.tableName}.${col.column_name}`]
							};
							items.push(item);
						}
					}
				}
			}
		}

		return items;
	}

	private generateAlias(tableName: string): string {
		const parts = tableName.split('_');
		if (parts.length === 1) {
			return tableName.substring(0, Math.min(2, tableName.length)).toUpperCase();
		}
		return parts.map(p => p.charAt(0).toUpperCase()).join('');
	}

	private extractAliasList(text: string): Array<{tableName: string, alias: string}> {
		const result: Array<{tableName: string, alias: string}> = [];
		const regex = /(?:from|join|update|into)\s+([a-zA-Z0-9_$#.]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_$#]+))?/gi;
		let match;
		const keywords = new Set(['WHERE', 'ON', 'SELECT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'SET', 'VALUES']);
		
		while ((match = regex.exec(text)) !== null) {
			let tableName = match[1].toUpperCase();
			if (tableName.includes('.')) {
				tableName = tableName.split('.').pop() || tableName;
			}
			let alias = match[2] ? match[2].toUpperCase() : tableName;
			if (keywords.has(alias)) {
				alias = tableName;
			}
			result.push({ tableName, alias });
		}
		return result;
	}

	private extractAliases(text: string): Map<string, string> {
		const map = new Map<string, string>();
		const list = this.extractAliasList(text);
		for (const item of list) {
			map.set(item.alias, item.tableName);
		}
		return map;
	}

	private getFkRank(tableName: string, previousTables: Array<{tableName: string}>): number {
		const schema = this.schemas.get(tableName);
		let bestRank = 999;
		
		for (let i = previousTables.length - 1; i >= 0; i--) {
			const prevTable = previousTables[i].tableName;
			let hasRelation = false;
			
			if (schema?.foreign_keys) {
				for (const fk of schema.foreign_keys) {
					if (fk.foreign_table.toUpperCase() === prevTable) {
						hasRelation = true;
						break;
					}
				}
			}
			
			if (!hasRelation) {
				const prevSchema = this.schemas.get(prevTable);
				if (prevSchema?.foreign_keys) {
					for (const fk of prevSchema.foreign_keys) {
						if (fk.foreign_table.toUpperCase() === tableName) {
							hasRelation = true;
							break;
						}
					}
				}
			}
			
			if (hasRelation) {
				const rank = previousTables.length - i;
				if (rank < bestRank) {
					bestRank = rank;
				}
			}
		}
		
		return bestRank;
	}

	private findJoinCondition(tableA: string, aliasA: string, tableB: string, aliasB: string): string | null {
		const schemaA = this.schemas.get(tableA);
		const schemaB = this.schemas.get(tableB);

		if (schemaA?.foreign_keys) {
			for (const fk of schemaA.foreign_keys) {
				if (fk.foreign_table.toUpperCase() === tableB) {
					const cols = fk.foreign_key_column.split(',').map(c => c.trim());
					return cols.map(c => `${aliasA}.${c} = ${aliasB}.${c}`).join(' AND ');
				}
			}
		}

		if (schemaB?.foreign_keys) {
			for (const fk of schemaB.foreign_keys) {
				if (fk.foreign_table.toUpperCase() === tableA) {
					const cols = fk.foreign_key_column.split(',').map(c => c.trim());
					return cols.map(c => `${aliasB}.${c} = ${aliasA}.${c}`).join(' AND ');
				}
			}
		}

		return null;
	}
}
