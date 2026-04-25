import { format as formatSql } from 'sql-formatter';

export type SqlKeywordCase = 'upper' | 'lower' | 'preserve';
export type SqlIdentifierCase = 'upper' | 'lower' | 'preserve';
export type SqlCommaPlacement = 'trailing' | 'leading';

export interface SqlFormatterConfig {
	enabled: boolean;
	keywordCase: SqlKeywordCase;
	identifierCase: SqlIdentifierCase;
	indentSize: number;
	alignAliases: boolean;
	clauseBreaks: boolean;
	commaPlacement: SqlCommaPlacement;
	compactParenthesesWordLimit: number;
}

const COMMENT_PLACEHOLDER_PREFIX = '__BIP_SQL_COMMENT__';
const COMMENT_LINE_PLACEHOLDER_PREFIX = '__BIP_SQL_COMMENT_LINE__';
const DASH_COMMENT_EOL_MARKER = '__BIP_SQL_DASH_EOL__';
const COMMENT_LINE_PREFIX_REGEX = /^--|^\/\*/u;
const PLACEHOLDER_PRESENCE_REGEX = new RegExp(`${COMMENT_PLACEHOLDER_PREFIX}|${COMMENT_LINE_PLACEHOLDER_PREFIX}`, 'iu');
const PLACEHOLDER_TOKEN_REGEX = new RegExp(`${COMMENT_PLACEHOLDER_PREFIX}\\d+__|${COMMENT_LINE_PLACEHOLDER_PREFIX}\\d+__`, 'giu');
const WORD_TOKEN_REGEX = /\b[\p{L}\p{N}_$#]+\b/gu;

function isCommentLine(trimmed: string): boolean {
	return COMMENT_LINE_PREFIX_REGEX.test(trimmed);
}

function countWordTokens(text: string): number {
	return text.match(WORD_TOKEN_REGEX)?.length ?? 0;
}

function applyKeywordCase(keyword: string, keywordCase: SqlKeywordCase): string {
	if (keywordCase === 'lower') {
		return keyword.toLowerCase();
	}
	if (keywordCase === 'upper') {
		return keyword.toUpperCase();
	}
	return keyword;
}

function extractComments(sql: string): { textWithoutComments: string; comments: string[] } {
	const comments: string[] = [];
	const textWithoutComments = sql.replace(/(--[^\n]*|\/\*[\s\S]*?\*\/)/gu, (comment, _group: string, offset: number, fullText: string) => {
		const lineStart = fullText.lastIndexOf('\n', offset - 1) + 1;
		const lineEndCandidate = fullText.indexOf('\n', offset + comment.length);
		const lineEnd = lineEndCandidate === -1 ? fullText.length : lineEndCandidate;
		const before = fullText.slice(lineStart, offset);
		const after = fullText.slice(offset + comment.length, lineEnd);
		const isWholeLineComment = before.trim().length === 0 && after.trim().length === 0;

		if (isWholeLineComment) {
			const fullLineComment = fullText.slice(lineStart, lineEnd);
			const index = comments.push(fullLineComment) - 1;
			return `${COMMENT_LINE_PLACEHOLDER_PREFIX}${index}__`;
		}

		const index = comments.push(comment) - 1;
		if (comment.startsWith('--')) {
			return `${COMMENT_PLACEHOLDER_PREFIX}${index}__${DASH_COMMENT_EOL_MARKER}`;
		}
		return `${COMMENT_PLACEHOLDER_PREFIX}${index}__`;
	});
	return { textWithoutComments, comments };
}

function restoreComments(sql: string, comments: string[]): string {
	const linePlaceholderRegex = new RegExp(`^[\\t ]*${COMMENT_LINE_PLACEHOLDER_PREFIX}(\\d+)__[\\t ]*$`, 'gmiu');
	const withLineCommentsRestored = sql.replace(linePlaceholderRegex, (_match, indexRaw: string) => {
		const index = Number.parseInt(indexRaw, 10);
		return comments[index] ?? '';
	});
	const withInlineCommentsRestored = withLineCommentsRestored.replace(new RegExp(`${COMMENT_PLACEHOLDER_PREFIX}(\\d+)__`, 'giu'), (_match, indexRaw: string) => {
		const index = Number.parseInt(indexRaw, 10);
		return comments[index] ?? '';
	});

	const fallbackLinePlaceholderRegex = new RegExp(`[\\t ]*${COMMENT_LINE_PLACEHOLDER_PREFIX}(\\d+)__[\\t ]*`, 'giu');
	const restored = withInlineCommentsRestored.replace(fallbackLinePlaceholderRegex, (match, indexRaw: string, offset: number, fullText: string) => {
		const index = Number.parseInt(indexRaw, 10);
		const fullLineComment = comments[index] ?? '';
		const needsLeadingNewLine = offset > 0 && fullText[offset - 1] !== '\n';
		const endOffset = offset + match.length;
		const needsTrailingNewLine = endOffset < fullText.length && fullText[endOffset] !== '\n';
		return `${needsLeadingNewLine ? '\n' : ''}${fullLineComment}${needsTrailingNewLine ? '\n' : ''}`;
	});

	return restored
		.replace(new RegExp(DASH_COMMENT_EOL_MARKER, 'giu'), '\n')
		// Keep full-line comments directly attached to surrounding SQL lines without
		// introducing an empty spacer line before them.
		.replace(/\n[\t ]*\n([\t ]*--)/gu, '\n$1')
		.replace(/\n{3,}/gu, '\n\n');
}

function normalizeStatementSeparators(sql: string): string {
	const lines = sql.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		if (/^[\t ]*\/[\t ]*$/u.test(lines[index])) {
			lines[index] = '/';
		}
	}

	return lines.join('\n');
}

function enforceClauseBreaks(sql: string): string {
	const clauseRegex = /\s+(FROM|START\s+WITH|CONNECT\s+BY|WHERE|GROUP\s+BY|ORDER\s+SIBLINGS\s+BY|ORDER\s+BY|HAVING|UNION\s+ALL|UNION|CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|INNER\s+JOIN|LEFT(?:\s+OUTER)?\s+JOIN|RIGHT(?:\s+OUTER)?\s+JOIN|FULL(?:\s+OUTER)?\s+JOIN|NATURAL\s+JOIN|(?<!CROSS\s)(?<!INNER\s)(?<!LEFT\s)(?<!RIGHT\s)(?<!FULL\s)(?<!OUTER\s)(?<!NATURAL\s)JOIN|LIMIT|OFFSET|FETCH\s+FIRST|FETCH\s+NEXT)\b/giu;
	return sql.replace(clauseRegex, '\n$1');
}

function normalizeQualifiedJoinLineBreaks(sql: string): string {
	const lines = sql.split(/\r?\n/u);
	const qualifierOnlyRegex = /^(\s*)(CROSS|FULL\s+OUTER|LEFT\s+OUTER|RIGHT\s+OUTER|LEFT|RIGHT|FULL|INNER|NATURAL)\s*$/iu;

	for (let i = 0; i < lines.length - 1; i += 1) {
		const currentMatch = qualifierOnlyRegex.exec(lines[i]);
		if (!currentMatch) {
			continue;
		}

		const nextTrimmed = lines[i + 1].trim();
		if (!/^JOIN\b/iu.test(nextTrimmed)) {
			continue;
		}

		const qualifierIndent = currentMatch[1] ?? '';
		const qualifier = currentMatch[2]?.replace(/\s+/gu, ' ').toUpperCase() ?? '';
		lines[i] = `${qualifierIndent}${qualifier} ${nextTrimmed}`;
		lines.splice(i + 1, 1);
		i -= 1;
	}

	return lines.join('\n');
}

function compactShortParentheses(sql: string, wordLimit: number): string {
	if (wordLimit < 0) {
		return sql;
	}

	const multilineParenthesesRegex = /\(\s*\n([\s\S]*?)\n\s*\)/gu;
	let previous = sql;

	while (true) {
		const updated = previous.replace(multilineParenthesesRegex, (fullMatch, innerRaw: string, offset: number, source: string) => {
			if (PLACEHOLDER_PRESENCE_REGEX.test(innerRaw)) {
				return fullMatch;
			}

			const compactInner = innerRaw.replace(/\s+/gu, ' ').trim();
			if (compactInner.length === 0) {
				return '()';
			}

			const beforeParen = source.slice(0, offset).replace(/[\t ]+$/u, '');
			const previousKeyword = /([\p{L}\p{N}_$#]+)$/u.exec(beforeParen)?.[1]?.toUpperCase();
			const startsWithSelect = /^SELECT\b/iu.test(compactInner);
			if (startsWithSelect && ['AS', 'FROM', 'JOIN', 'APPLY', 'WITH'].includes(previousKeyword ?? '')) {
				return fullMatch;
			}

			if (countWordTokens(compactInner) <= wordLimit) {
				return `(${compactInner})`;
			}

			return fullMatch;
		});

		if (updated === previous) {
			return updated;
		}
		previous = updated;
	}
}

function applyCommaPlacement(sql: string, commaPlacement: SqlCommaPlacement): string {
	const lines = sql.split(/\r?\n/u);

	if (commaPlacement === 'leading') {
		for (let index = 0; index < lines.length - 1; index += 1) {
			const current = lines[index];
			if (!/,\s*$/u.test(current)) {
				continue;
			}

			const next = lines[index + 1];
			if (next.trim().length === 0) {
				continue;
			}

			lines[index] = current.replace(/,\s*$/u, '');
			lines[index + 1] = next.replace(/^(\s*)/u, '$1, ');
		}
		return lines.join('\n');
	}

	for (let index = 1; index < lines.length; index += 1) {
		const current = lines[index];
		const leadingCommaMatch = /^(\s*),\s*(.+)$/u.exec(current);
		if (!leadingCommaMatch) {
			continue;
		}

		const previousIndex = index - 1;
		lines[previousIndex] = lines[previousIndex].replace(/\s*$/u, ',');
		lines[index] = `${leadingCommaMatch[1]}${leadingCommaMatch[2]}`;
	}

	return lines.join('\n');
}

function alignSelectAliases(sql: string, keywordCase: SqlKeywordCase): string {
	const lines = sql.split(/\r?\n/u);
	let inSelectList = false;
	let blockAliasIndexes: number[] = [];
	let blockAliasColumns: number[] = [];

	const flushBlock = (): void => {
		if (blockAliasIndexes.length <= 1) {
			blockAliasIndexes = [];
			blockAliasColumns = [];
			return;
		}

		const maxColumn = Math.max(...blockAliasColumns);
		for (let i = 0; i < blockAliasIndexes.length; i += 1) {
			const lineIndex = blockAliasIndexes[i];
			const line = lines[lineIndex];
			const asMatch = /\s+AS\s+/iu.exec(line);
			if (!asMatch || asMatch.index <= 0) {
				continue;
			}

			const beforeAs = line.slice(0, asMatch.index).replace(/\s+$/u, '');
			const afterAs = line.slice(asMatch.index + asMatch[0].length).trimStart();
			const padCount = Math.max(1, maxColumn - beforeAs.length + 1);
			lines[lineIndex] = `${beforeAs}${' '.repeat(padCount)}${applyKeywordCase('AS', keywordCase)} ${afterAs}`;
		}

		blockAliasIndexes = [];
		blockAliasColumns = [];
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();

		if (/^SELECT\b/iu.test(trimmed)) {
			flushBlock();
			inSelectList = true;
			continue;
		}

		if (/^FROM\b/iu.test(trimmed)) {
			flushBlock();
			inSelectList = false;
			continue;
		}

		if (!inSelectList || trimmed.length === 0 || isCommentLine(trimmed)) {
			continue;
		}

		const asMatch = /\s+AS\s+/iu.exec(line);
		if (!asMatch || asMatch.index <= 0) {
			continue;
		}

		blockAliasIndexes.push(index);
		blockAliasColumns.push(line.slice(0, asMatch.index).replace(/\s+$/u, '').length);
	}

	flushBlock();
	return lines.join('\n');
}

function getLineParenthesesDelta(line: string): number {
	const withoutInlineComment = line.replace(/--.*$/u, '');
	const withoutBlockComments = withoutInlineComment.replace(/\/\*.*?\*\//gu, '');
	let delta = 0;
	for (const char of withoutBlockComments) {
		if (char === '(') {
			delta += 1;
		} else if (char === ')') {
			delta -= 1;
		}
	}
	return delta;
}

function normalizeIndentation(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const clauseHeaderRegex = /^(SELECT|FROM|START\s+WITH|CONNECT\s+BY|WHERE|GROUP\s+BY|ORDER\s+SIBLINGS\s+BY|ORDER\s+BY|HAVING|UNION(?:\s+ALL)?|CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|JOIN|INNER\s+JOIN|LEFT(?:\s+OUTER)?\s+JOIN|RIGHT(?:\s+OUTER)?\s+JOIN|FULL(?:\s+OUTER)?\s+JOIN|NATURAL\s+JOIN)\b/iu;
	const joinHeaderRegex = /^(CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|JOIN|INNER\s+JOIN|LEFT(?:\s+OUTER)?\s+JOIN|RIGHT(?:\s+OUTER)?\s+JOIN|FULL(?:\s+OUTER)?\s+JOIN|NATURAL\s+JOIN)\b/iu;
	const hierarchicalHeaderRegex = /^(START\s+WITH|CONNECT\s+BY)\b/iu;
	const result: string[] = [];
	const unit = ' '.repeat(Math.max(1, indentSize));

	let depth = 0;
	let inClauseBody = false;
	let currentClauseIndentLevel: number | undefined;
	let currentClauseType: 'select' | 'from' | 'where' | 'other' | undefined;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			result.push('');
			continue;
		}

		const startsWithClosingParen = /^\)/u.test(trimmed);
		const effectiveDepth = Math.max(0, depth - (startsWithClosingParen ? 1 : 0));

		if (clauseHeaderRegex.test(trimmed)) {
			const isJoinHeader = joinHeaderRegex.test(trimmed);
			const isHierarchicalHeader = hierarchicalHeaderRegex.test(trimmed);
			const inFromClause = currentClauseType === 'from';
			const isSelectClauseTransition = currentClauseType === 'select' && !/^SELECT\b/iu.test(trimmed);
			const clauseDepth = isJoinHeader && inFromClause
				? effectiveDepth + 1
				: (isHierarchicalHeader && inFromClause
					? effectiveDepth
					: (isSelectClauseTransition
						? (currentClauseIndentLevel ?? effectiveDepth)
						: (inClauseBody && effectiveDepth > 0 ? effectiveDepth + 1 : effectiveDepth)));
			result.push(`${unit.repeat(Math.max(0, clauseDepth))}${trimmed}`);
			inClauseBody = true;
			currentClauseIndentLevel = Math.max(0, clauseDepth);

			if (/^SELECT\b/iu.test(trimmed)) {
				currentClauseType = 'select';
			} else if (/^WHERE\b/iu.test(trimmed)) {
				currentClauseType = 'where';
			} else if (/^FROM\b/iu.test(trimmed) || isJoinHeader || isHierarchicalHeader) {
				currentClauseType = 'from';
			} else {
				currentClauseType = 'other';
			}
		} else if (startsWithClosingParen) {
			result.push(`${unit.repeat(effectiveDepth)}${trimmed}`);
			const closesFromSource = currentClauseType === 'from' && /^\)\s*(AS\b|,|$)/iu.test(trimmed);
			const continuesWhereClause = currentClauseType === 'where' && /^\)\s*$/u.test(trimmed);
			if (closesFromSource) {
				inClauseBody = true;
				currentClauseIndentLevel = Math.max(0, effectiveDepth);
				currentClauseType = 'from';
			} else if (continuesWhereClause) {
				inClauseBody = true;
				currentClauseIndentLevel = Math.max(0, effectiveDepth);
				currentClauseType = 'where';
			} else {
				inClauseBody = false;
				currentClauseIndentLevel = undefined;
				currentClauseType = undefined;
			}
		} else {
			const baseDepth = currentClauseIndentLevel !== undefined
				? currentClauseIndentLevel + 1
				: (inClauseBody ? effectiveDepth + 1 : effectiveDepth);
			const normalizedDepth = Math.max(0, baseDepth);
			result.push(`${unit.repeat(normalizedDepth)}${trimmed}`);
		}

		const delta = getLineParenthesesDelta(trimmed);
		depth = Math.max(0, depth + delta);

		if (clauseHeaderRegex.test(trimmed)) {
			continue;
		}

		const shouldResetForClauseBoundary = /^(WHERE|GROUP\s+BY|ORDER\s+SIBLINGS\s+BY|ORDER\s+BY|HAVING|UNION(?:\s+ALL)?)\b/iu.test(trimmed);
		const shouldResetForClosingParen = /^\)/u.test(trimmed)
			&& !(currentClauseType === 'where' || currentClauseType === 'from');
		if (shouldResetForClauseBoundary || shouldResetForClosingParen) {
			inClauseBody = false;
			currentClauseIndentLevel = undefined;
			currentClauseType = undefined;
		}
	}

	return result.join('\n');
}

function normalizeSelectListIndentation(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const unit = ' '.repeat(Math.max(1, indentSize));

	for (let i = 0; i < lines.length; i += 1) {
		const headerTrimmed = lines[i].trim();
		if (!/^SELECT\b/iu.test(headerTrimmed)) {
			continue;
		}

		const headerIndent = /^\s*/u.exec(lines[i])?.[0] ?? '';
		const expectedIndent = `${headerIndent}${unit}`;

		for (let cursor = i + 1; cursor < lines.length; cursor += 1) {
			const candidate = lines[cursor].trim();
			if (candidate.length === 0 || isCommentLine(candidate)) {
				continue;
			}
			if (/^FROM\b/iu.test(candidate) || /^\)/u.test(candidate)) {
				break;
			}

			lines[cursor] = `${expectedIndent}${candidate}`;
		}
	}

	return lines.join('\n');
}

function normalizeCaseExpressionIndentation(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const unit = ' '.repeat(Math.max(1, indentSize));
	const caseIndentStack: string[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (trimmed.length === 0 || isCommentLine(trimmed)) {
			continue;
		}

		if (/^CASE\b/iu.test(trimmed)) {
			if (caseIndentStack.length > 0) {
				const nestedIndent = `${caseIndentStack[caseIndentStack.length - 1] ?? ''}${unit}`;
				lines[i] = `${nestedIndent}${trimmed}`;
				caseIndentStack.push(nestedIndent);
			} else {
				const currentIndent = /^\s*/u.exec(raw)?.[0] ?? '';
				caseIndentStack.push(currentIndent);
			}
			continue;
		}

		if (caseIndentStack.length === 0) {
			continue;
		}

		const caseIndent = caseIndentStack[caseIndentStack.length - 1] ?? '';
		if (/^WHEN\b|^ELSE\b/iu.test(trimmed)) {
			lines[i] = `${caseIndent}${unit}${trimmed}`;
			continue;
		}

		if (/^END\b/iu.test(trimmed)) {
			lines[i] = `${caseIndent}${trimmed}`;
			caseIndentStack.pop();
		}
	}

	return lines.join('\n');
}

function hasNonCommentSqlContent(textWithPlaceholders: string): boolean {
	const withoutPlaceholders = textWithPlaceholders.replace(PLACEHOLDER_TOKEN_REGEX, '');
	return withoutPlaceholders.trim().length > 0;
}

function normalizeRecursiveCteKeyword(sql: string): string {
	return sql.replace(/\bWITH\s+RECURSIVE\b/giu, 'WITH RECURSIVE');
}

function ensureClauseBodyIndentAfterComments(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const clauseHeaderRegex = /^(SELECT|FROM|START\s+WITH|CONNECT\s+BY|WHERE|GROUP\s+BY|ORDER\s+SIBLINGS\s+BY|ORDER\s+BY|HAVING|UNION(?:\s+ALL)?|CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|JOIN|INNER\s+JOIN|LEFT(?:\s+OUTER)?\s+JOIN|RIGHT(?:\s+OUTER)?\s+JOIN|FULL(?:\s+OUTER)?\s+JOIN|NATURAL\s+JOIN)\b/iu;
	const unit = ' '.repeat(Math.max(1, indentSize));

	for (let i = 0; i < lines.length; i += 1) {
		const headerTrimmed = lines[i].trim();
		if (!clauseHeaderRegex.test(headerTrimmed)) {
			continue;
		}

		const headerIndent = /^\s*/u.exec(lines[i])?.[0] ?? '';
		let cursor = i + 1;
		let sawComment = false;

		while (cursor < lines.length) {
			const candidate = lines[cursor].trim();
			if (candidate.length === 0) {
				cursor += 1;
				continue;
			}
			if (isCommentLine(candidate)) {
				sawComment = true;
				cursor += 1;
				continue;
			}
			if (sawComment && !clauseHeaderRegex.test(candidate) && !/^\)/u.test(candidate)) {
				lines[cursor] = `${headerIndent}${unit}${candidate}`;
			}
			break;
		}
	}

	return lines.join('\n');
}

function ensureFromBlockJoinIndentation(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const unit = ' '.repeat(Math.max(1, indentSize));
	const joinHeaderRegex = /^(CROSS\s+JOIN|CROSS\s+APPLY|OUTER\s+APPLY|JOIN|INNER\s+JOIN|LEFT(?:\s+OUTER)?\s+JOIN|RIGHT(?:\s+OUTER)?\s+JOIN|FULL(?:\s+OUTER)?\s+JOIN|NATURAL\s+JOIN)\b/iu;
	const clauseBoundaryRegex = /^(WHERE|GROUP\s+BY|ORDER\s+SIBLINGS\s+BY|ORDER\s+BY|HAVING|UNION(?:\s+ALL)?|LIMIT|OFFSET|FETCH\s+FIRST|FETCH\s+NEXT)\b/iu;

	for (let i = 0; i < lines.length; i += 1) {
		const headerTrimmed = lines[i].trim();
		if (!/^FROM\b/iu.test(headerTrimmed)) {
			continue;
		}

		const headerIndent = /^\s*/u.exec(lines[i])?.[0] ?? '';
		const expectedIndent = `${headerIndent}${unit}`;
		let localDepth = 0;

		for (let cursor = i + 1; cursor < lines.length; cursor += 1) {
			const candidate = lines[cursor].trim();
			if (candidate.length === 0 || isCommentLine(candidate)) {
				continue;
			}

			if (localDepth === 0 && (clauseBoundaryRegex.test(candidate) || /^\)/u.test(candidate))) {
				break;
			}

			if (localDepth === 0 && joinHeaderRegex.test(candidate)) {
				lines[cursor] = `${expectedIndent}${candidate}`;
			}

			localDepth = Math.max(0, localDepth + getLineParenthesesDelta(candidate));
		}
	}

	return lines.join('\n');
}

function normalizeParenthesizedBlockIndentation(sql: string, indentSize: number): string {
	const lines = sql.split(/\r?\n/u);
	const unit = ' '.repeat(Math.max(1, indentSize));
	const blockStack: Array<{ openIndent: string; contentIndent: string }> = [];

	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		const trimmed = raw.trim();

		if (trimmed.length === 0) {
			continue;
		}

		if (/^\)/u.test(trimmed) && blockStack.length > 0) {
			const block = blockStack.pop();
			if (block) {
				lines[i] = `${block.openIndent}${trimmed}`;
			}
			continue;
		}

		if (blockStack.length > 0 && !isCommentLine(trimmed)) {
			const currentIndent = /^\s*/u.exec(raw)?.[0] ?? '';
			const targetIndent = blockStack[blockStack.length - 1]?.contentIndent ?? '';
			if (currentIndent.length < targetIndent.length) {
				lines[i] = `${targetIndent}${trimmed}`;
			}
		}

		if (/\(\s*$/u.test(trimmed)) {
			const openIndent = /^\s*/u.exec(lines[i])?.[0] ?? '';
			blockStack.push({
				openIndent,
				contentIndent: `${openIndent}${unit}`,
			});
		}
	}

	return lines.join('\n');
}

function removeBlankLinesBeforeClosingParentheses(sql: string): string {
	return sql.replace(/\n[\t ]*\n([\t ]*\))/gu, '\n$1');
}

function normalizeTopLevelCteIndentation(sql: string): string {
	const lines = sql.split(/\r?\n/u);
	const cteNameRegex = /^[\p{L}_][\p{L}\p{N}_$#]*\s+AS\s*\(/iu;
	let inWithBlock = false;
	let depth = 0;

	for (let i = 0; i < lines.length; i += 1) {
		const trimmed = lines[i].trim();
		if (trimmed.length === 0 || isCommentLine(trimmed)) {
			continue;
		}

		if (!inWithBlock && /^WITH(?:\s+RECURSIVE)?\b/iu.test(trimmed)) {
			inWithBlock = true;
			depth = Math.max(0, depth + getLineParenthesesDelta(trimmed));
			continue;
		}

		if (inWithBlock && depth === 0 && cteNameRegex.test(trimmed)) {
			lines[i] = trimmed;
		}

		if (inWithBlock && depth === 0 && /^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/iu.test(trimmed)) {
			inWithBlock = false;
		}

		depth = Math.max(0, depth + getLineParenthesesDelta(trimmed));
	}

	return lines.join('\n');
}

function normalizeInlineSubquerySpacing(sql: string): string {
	return sql.replace(/\([\t ]+(SELECT\b)/giu, '($1');
}

function inlineShortScalarSubqueries(sql: string, wordLimit: number): string {
	if (wordLimit < 0) {
		return sql;
	}

	const scalarSubqueryRegex = /(?<!AS[\t ])(?<!FROM[\t ])(?<!JOIN[\t ])(?<!APPLY[\t ])(?<!WITH[\t ])\(\s*\n([\t ]*SELECT[\s\S]*?)\n[\t ]*\)/giu;
	return sql.replace(scalarSubqueryRegex, (fullMatch, bodyRaw: string) => {
		const compactBody = bodyRaw.replace(/\s+/gu, ' ').trim();
		if (!/^SELECT\b/iu.test(compactBody)) {
			return fullMatch;
		}

		if (countWordTokens(compactBody) <= wordLimit) {
			return `(${compactBody})`;
		}

		return fullMatch;
	});
}

export function formatSqlDocument(input: string, config: SqlFormatterConfig, language: 'sql' | 'plsql' = 'sql'): string {
	if (!config.enabled || input.trim().length === 0) {
		return input;
	}

	const normalizedIndentSize = Math.max(1, Math.floor(config.indentSize));
	const normalizedCompactWordLimit = Math.max(0, Math.floor(config.compactParenthesesWordLimit));

	const { textWithoutComments, comments } = extractComments(input);
	const normalizedForParsing = normalizeRecursiveCteKeyword(textWithoutComments);
	if (!hasNonCommentSqlContent(normalizedForParsing)) {
		return input;
	}

	const keywordCase = config.keywordCase;
	const identifierCase = config.identifierCase ?? 'preserve';
	const formatOptions = {
		language,
		tabWidth: normalizedIndentSize,
		keywordCase,
		identifierCase,
		linesBetweenQueries: 1,
	} as any;

	const dialectAttempts = Array.from(new Set([
		language,
		language === 'sql' ? 'plsql' : 'sql',
		'postgresql',
		'sqlite',
	]));

	let formattedBase: string | undefined;
	for (const dialect of dialectAttempts) {
		try {
			formattedBase = formatSql(normalizedForParsing, {
				...formatOptions,
				language: dialect,
			});
			break;
		} catch {
			// Try next dialect.
		}
	}

	if (!formattedBase) {
		return input;
	}

	let formatted = formattedBase;
	if (config.clauseBreaks) {
		formatted = enforceClauseBreaks(formatted);
	}
	formatted = normalizeQualifiedJoinLineBreaks(formatted);
	formatted = applyCommaPlacement(formatted, config.commaPlacement);
	formatted = compactShortParentheses(formatted, normalizedCompactWordLimit);
	formatted = normalizeInlineSubquerySpacing(formatted);
	if (config.alignAliases) {
		formatted = alignSelectAliases(formatted, keywordCase);
	}
	formatted = normalizeStatementSeparators(formatted);
	formatted = normalizeIndentation(formatted, normalizedIndentSize);
	formatted = inlineShortScalarSubqueries(formatted, normalizedCompactWordLimit);

	const restored = restoreComments(formatted, comments);
	const normalizedSelectLists = normalizeSelectListIndentation(restored, normalizedIndentSize);
	const normalizedCaseExpressions = normalizeCaseExpressionIndentation(normalizedSelectLists, normalizedIndentSize);
	const normalizedFromJoins = ensureFromBlockJoinIndentation(normalizedCaseExpressions, normalizedIndentSize);
	const normalizedParentheses = normalizeParenthesizedBlockIndentation(normalizedFromJoins, normalizedIndentSize);
	const corrected = ensureClauseBodyIndentAfterComments(normalizedParentheses, normalizedIndentSize);
	const withoutEmptyLinesBeforeClosingParens = removeBlankLinesBeforeClosingParentheses(corrected);
	const normalizedTopLevelCtes = normalizeTopLevelCteIndentation(withoutEmptyLinesBeforeClosingParens);
	return normalizedTopLevelCtes.replace(/\s+$/u, '').concat('\n');
}

export function buildSqlHeaderTemplate(
	fileName: string = '{file_name}',
	authorName: string = 'Ranatchai',
	now: Date = new Date()
): string {
	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const day = String(now.getDate()).padStart(2, '0');
	const month = monthNames[now.getMonth()] ?? 'Jan';
	const year = now.getFullYear();
	const currentDate = `${day}-${month}-${year}`;
	const safeFileName = fileName.trim().length > 0 ? fileName.trim() : '{file_name}';
	const safeAuthorName = authorName.trim().length > 0 ? authorName.trim() : 'Ranatchai';
	return [
		'/************************************************************************************',
		`Object Name         : ${safeFileName}`,
		'Description         : ',
		'                                                                 ',
		'Author               Date                 Ver    Description                                ',
		'------------        ---------            ---    -------------------------------------------       ',
		`${safeAuthorName}           ${currentDate}          1.0    Initial draft  `,
		'************************************************************************************/',
		'',
	].join('\n');
}
