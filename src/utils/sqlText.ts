import * as vscode from 'vscode';

const TERMINAL_PAGING_CLAUSE_REGEX = /\b(?:offset\s+\d+\s+rows(?:\s+fetch\s+next\s+\d+\s+rows?\s+only)?|fetch\s+(?:first|next)\s+\d+\s+rows?\s+only)\s*$/iu;

export function stripTrailingSemicolon(sql: string): string {
	return sql.trim().replace(/;+\s*$/u, '').trim();
}

export function hasTerminalPagingClause(sql: string): boolean {
	const normalized = stripTrailingSemicolon(sql);
	if (normalized.length === 0) {
		return false;
	}

	return TERMINAL_PAGING_CLAUSE_REGEX.test(normalized);
}

export function buildPagedSql(sql: string, offset: number, rowLimit: number): string {
	const normalized = stripTrailingSemicolon(sql);
	if (normalized.length === 0) {
		return normalized;
	}

	const safeOffset = Math.max(0, Math.floor(offset));
	const safeRowLimit = Math.max(1, Math.floor(rowLimit));

	if (hasTerminalPagingClause(normalized)) {
		return normalized;
	}

	return `${normalized} OFFSET ${safeOffset} ROWS FETCH NEXT ${safeRowLimit} ROWS ONLY`;
}

/**
 * Splits `text` on statement delimiters (`;` or a standalone `/` on its own line)
 * and returns the statement that contains `cursorOffset`, stripped of its
 * trailing delimiter and surrounding whitespace.
 */
export function extractStatementAtCursor(text: string, cursorOffset: number): string {
	// Match ; anywhere, or / alone on a line (Oracle PL/SQL block terminator)
	const delimiterRegex = /;|^\s*\/\s*$/gmu;
	let start = 0;
	let match: RegExpExecArray | null;

	while ((match = delimiterRegex.exec(text)) !== null) {
		const delimEnd = match.index + match[0].length;
		if (cursorOffset <= delimEnd) {
			return stripTrailingSemicolon(text.slice(start, delimEnd).trim());
		}
		start = delimEnd;
	}

	// Cursor is past the last delimiter, or no delimiters exist
	return stripTrailingSemicolon(text.slice(start).trim());
}

export function getRunnableSql(editor: vscode.TextEditor): string {
	const selection = editor.selection;
	if (!selection.isEmpty) {
		const selected = editor.document.getText(selection).trim();
		if (selected.length > 0) {
			return stripTrailingSemicolon(selected);
		}
	}

	const fullText = editor.document.getText();
	const cursorOffset = editor.document.offsetAt(editor.selection.active);
	return extractStatementAtCursor(fullText, cursorOffset);
}
