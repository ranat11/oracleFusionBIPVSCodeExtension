import * as XLSX from 'xlsx';

import { QueryResult } from './models';

function csvEscape(value: string): string {
	if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function toCsv(result: QueryResult): string {
	const lines: string[] = [];
	lines.push(result.columns.map(csvEscape).join(','));
	for (const row of result.rows) {
		const line = result.columns.map((column) => csvEscape(row[column] ?? '')).join(',');
		lines.push(line);
	}
	return lines.join('\n');
}

export function toXlsxBuffer(result: QueryResult): Buffer {
	const rows = result.rows.map((row) => {
		const item: Record<string, string> = {};
		for (const column of result.columns) {
			item[column] = row[column] ?? '';
		}
		return item;
	});
	const worksheet = XLSX.utils.json_to_sheet(rows, { header: result.columns });
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
	return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
