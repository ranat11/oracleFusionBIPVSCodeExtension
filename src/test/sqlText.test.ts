import * as assert from 'assert';

import { buildPagedSql, extractStatementAtCursor, getRunnableSql, hasTerminalPagingClause, stripTrailingSemicolon } from '../utils/sqlText';

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

	test('uses full editor SQL when no text is highlighted and single statement', () => {
		const editor = {
			selection: { isEmpty: true, active: {} },
			document: {
				getText: () => 'select * from ap_invoices_all;   ',
				offsetAt: () => 0
			}
		};

		assert.strictEqual(getRunnableSql(editor as any), 'select * from ap_invoices_all');
	});

	suite('extractStatementAtCursor', () => {
		test('returns single statement when no delimiter present', () => {
			assert.strictEqual(
				extractStatementAtCursor('select * from dual', 5),
				'select * from dual'
			);
		});

		test('returns first statement when cursor is before semicolon', () => {
			const text = 'select 1 from dual;\nselect 2 from dual;';
			// cursor at position 5, inside "select 1 from dual"
			assert.strictEqual(extractStatementAtCursor(text, 5), 'select 1 from dual');
		});

		test('returns second statement when cursor is in second block', () => {
			const text = 'select 1 from dual;\nselect 2 from dual;';
			// cursor past the first newline (position 20), inside second statement
			assert.strictEqual(extractStatementAtCursor(text, 22), 'select 2 from dual');
		});

		test('returns statement when cursor is on the semicolon itself', () => {
			const text = 'select 1 from dual;\nselect 2 from dual;';
			// semicolon is at index 18; cursorOffset 18 < delimEnd 19
			assert.strictEqual(extractStatementAtCursor(text, 18), 'select 1 from dual');
		});

		test('returns trailing text when cursor is after all delimiters', () => {
			const text = 'select 1 from dual;\n\nselect 2 from dual';
			// cursor at end of file, past the only semicolon
			assert.strictEqual(extractStatementAtCursor(text, text.length - 1), 'select 2 from dual');
		});

		test('splits on Oracle-style standalone slash delimiter', () => {
			const text = 'select 1 from dual\n/\nselect 2 from dual\n/';
			// cursor at position 5, inside first statement
			assert.strictEqual(extractStatementAtCursor(text, 5), 'select 1 from dual');
			// cursor past first slash (position > index of \n after first /)
			const secondStart = text.indexOf('select 2');
			assert.strictEqual(extractStatementAtCursor(text, secondStart + 2), 'select 2 from dual');
		});

		test('returns empty string when cursor is after a trailing delimiter with no more text', () => {
			const text = 'select 1 from dual;';
			// cursor right after the semicolon — nothing follows
			assert.strictEqual(extractStatementAtCursor(text, text.length), '');
		});
	});
});