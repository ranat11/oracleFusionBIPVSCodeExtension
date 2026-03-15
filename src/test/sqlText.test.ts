import * as assert from 'assert';

import { buildPagedSql, getRunnableSql, hasTerminalPagingClause, stripTrailingSemicolon } from '../utils/sqlText';

suite('SQL Text Helpers', () => {
	test('strips trailing semicolons', () => {
		assert.strictEqual(
			stripTrailingSemicolon('select * from ap_invoices_all;   '),
			'select * from ap_invoices_all'
		);
	});

	test('detects terminal fetch first clause', () => {
		assert.strictEqual(
			hasTerminalPagingClause('select * from ap_invoices_all fetch first 25 rows only'),
			true
		);
	});

	test('detects terminal offset fetch clause', () => {
		assert.strictEqual(
			hasTerminalPagingClause('select * from ap_invoices_all offset 200 rows fetch next 25 rows only'),
			true
		);
	});

	test('builds offset fetch clause when query has no terminal paging', () => {
		assert.strictEqual(
			buildPagedSql('select * from ap_invoices_all', 50, 10),
			'select * from ap_invoices_all OFFSET 50 ROWS FETCH NEXT 10 ROWS ONLY'
		);
	});

	test('does not rewrite query when terminal paging already exists', () => {
		assert.strictEqual(
			buildPagedSql('select * from ap_invoices_all fetch first 25 rows only', 50, 10),
			'select * from ap_invoices_all fetch first 25 rows only'
		);
	});

	test('uses selected SQL when text is highlighted', () => {
		const editor = {
			selection: { isEmpty: false },
			document: {
				getText: (selection?: unknown) => (selection ? 'select * from ap_invoices_all;   ' : 'select * from ignored_table')
			}
		};

		assert.strictEqual(getRunnableSql(editor as any), 'select * from ap_invoices_all');
	});

	test('uses full editor SQL when no text is highlighted', () => {
		const editor = {
			selection: { isEmpty: true },
			document: {
				getText: () => 'select * from ap_invoices_all;   '
			}
		};

		assert.strictEqual(getRunnableSql(editor as any), 'select * from ap_invoices_all');
	});
});