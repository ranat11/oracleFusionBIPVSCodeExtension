export type SqlParameterType = 'auto' | 'string' | 'number' | 'date';

export interface SqlParameterValue {
	name: string;
	value: string;
	type: SqlParameterType;
}

export interface SqlParameterResolution {
	sql: string;
	unresolvedParameters: string[];
}

export function inferSqlParameterType(value: string): Exclude<SqlParameterType, 'auto'> {
	const trimmed = value.trim();
	if (/^[+-]?\d+(?:\.\d+)?$/u.test(trimmed)) {
		return 'number';
	}
	if (
		/^\d{4}-\d{2}-\d{2}$/u.test(trimmed) ||
		/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/u.test(trimmed)
	) {
		return 'date';
	}

	return 'string';
}

function isIdentifierStart(char: string): boolean {
	return /^[A-Za-z_]$/u.test(char);
}

function isIdentifierPart(char: string): boolean {
	return /^[A-Za-z0-9_$#]$/u.test(char);
}

function canonicalName(name: string): string {
	return name.toUpperCase();
}

function formatLiteral(value: string, type: SqlParameterType): string {
	const trimmed = value.trim();
	if (type === 'number') {
		return trimmed;
	}

	const escaped = trimmed.replace(/'/gu, "''");
	if (type === 'date') {
		if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
			return `DATE '${escaped}'`;
		}
		return `TIMESTAMP '${escaped}'`;
	}

	if (type === 'auto') {
		const inferred = inferSqlParameterType(trimmed);
		if (inferred === 'number') {
			return trimmed;
		}
		if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
			return `DATE '${escaped}'`;
		}
		if (inferred === 'date') {
			return `TIMESTAMP '${escaped}'`;
		}
	}

	return `'${escaped}'`;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) {
		values.push(value);
	}
}

export function extractSqlParameters(sql: string): string[] {
	const found: string[] = [];
	let i = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingleQuote = false;
	let inDoubleQuote = false;

	while (i < sql.length) {
		const char = sql[i];
		const next = i + 1 < sql.length ? sql[i + 1] : '';

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			i += 1;
			continue;
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		if (inSingleQuote) {
			if (char === "'" && next === "'") {
				i += 2;
				continue;
			}
			if (char === "'") {
				inSingleQuote = false;
			}
			i += 1;
			continue;
		}

		if (inDoubleQuote) {
			if (char === '"' && next === '"') {
				i += 2;
				continue;
			}
			if (char === '"') {
				inDoubleQuote = false;
			}
			i += 1;
			continue;
		}

		if (char === '-' && next === '-') {
			inLineComment = true;
			i += 2;
			continue;
		}

		if (char === '/' && next === '*') {
			inBlockComment = true;
			i += 2;
			continue;
		}

		if (char === "'") {
			inSingleQuote = true;
			i += 1;
			continue;
		}

		if (char === '"') {
			inDoubleQuote = true;
			i += 1;
			continue;
		}

		if (char === ':') {
			const start = i + 1;
			const first = start < sql.length ? sql[start] : '';
			if (!isIdentifierStart(first)) {
				i += 1;
				continue;
			}

			let end = start + 1;
			while (end < sql.length && isIdentifierPart(sql[end])) {
				end += 1;
			}

			pushUnique(found, canonicalName(sql.slice(start, end)));
			i = end;
			continue;
		}

		i += 1;
	}

	return found;
}

export function resolveSqlParameters(sql: string, parameters: SqlParameterValue[]): SqlParameterResolution {
	const byName = new Map<string, SqlParameterValue>();
	for (const parameter of parameters) {
		byName.set(canonicalName(parameter.name), parameter);
	}

	const unresolved: string[] = [];
	let resolved = '';
	let i = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingleQuote = false;
	let inDoubleQuote = false;

	while (i < sql.length) {
		const char = sql[i];
		const next = i + 1 < sql.length ? sql[i + 1] : '';

		if (inLineComment) {
			resolved += char;
			if (char === '\n') {
				inLineComment = false;
			}
			i += 1;
			continue;
		}

		if (inBlockComment) {
			resolved += char;
			if (char === '*' && next === '/') {
				resolved += next;
				inBlockComment = false;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		if (inSingleQuote) {
			resolved += char;
			if (char === "'" && next === "'") {
				resolved += next;
				i += 2;
				continue;
			}
			if (char === "'") {
				inSingleQuote = false;
			}
			i += 1;
			continue;
		}

		if (inDoubleQuote) {
			resolved += char;
			if (char === '"' && next === '"') {
				resolved += next;
				i += 2;
				continue;
			}
			if (char === '"') {
				inDoubleQuote = false;
			}
			i += 1;
			continue;
		}

		if (char === '-' && next === '-') {
			resolved += char + next;
			inLineComment = true;
			i += 2;
			continue;
		}

		if (char === '/' && next === '*') {
			resolved += char + next;
			inBlockComment = true;
			i += 2;
			continue;
		}

		if (char === "'") {
			resolved += char;
			inSingleQuote = true;
			i += 1;
			continue;
		}

		if (char === '"') {
			resolved += char;
			inDoubleQuote = true;
			i += 1;
			continue;
		}

		if (char === ':') {
			const start = i + 1;
			const first = start < sql.length ? sql[start] : '';
			if (!isIdentifierStart(first)) {
				resolved += char;
				i += 1;
				continue;
			}

			let end = start + 1;
			while (end < sql.length && isIdentifierPart(sql[end])) {
				end += 1;
			}

			const tokenName = canonicalName(sql.slice(start, end));
			const parameter = byName.get(tokenName);
			if (!parameter) {
				pushUnique(unresolved, tokenName);
				resolved += sql.slice(i, end);
				i = end;
				continue;
			}

			if (parameter.value.trim().length === 0) {
				resolved += 'NULL';
				i = end;
				continue;
			}

			resolved += formatLiteral(parameter.value, parameter.type);
			i = end;
			continue;
		}

		resolved += char;
		i += 1;
	}

	return {
		sql: resolved,
		unresolvedParameters: unresolved
	};
}
