import * as assert from 'assert';

import { extractSqlParameters, resolveSqlParameters } from '../utils/sqlParameters';

suite('SQL Parameter Helpers', () => {
	test('extracts unique parameter names case-insensitively', () => {
		assert.deepStrictEqual(
			extractSqlParameters('select * from t where id = :p_id or manager_id = :P_ID and dept = :dept_no'),
			['P_ID', 'DEPT_NO']
		);
	});

	test('ignores timestamp text and comments during extraction', () => {
		assert.deepStrictEqual(
			extractSqlParameters(`
				select * from t
				where ts_text = '12:30'
				and run_time = to_timestamp('2026-03-15 08:45:00', 'YYYY-MM-DD HH24:MI:SS')
				-- :ignored_in_line_comment
				/* :ignored_in_block_comment */
				and id = :P_ID
			`),
			['P_ID']
		);
	});

	test('ignores placeholders inside quoted literals', () => {
		assert.deepStrictEqual(
			extractSqlParameters("select ':P_ID' as txt, col from t where name = 'A:VALUE' and id = :REAL_PARAM"),
			['REAL_PARAM']
		);
	});

	test('replaces parameters with typed literals and is case-insensitive', () => {
		const result = resolveSqlParameters(
			'select * from t where id = :p_id and dt = :P_DATE and code = :Code',
			[
				{ name: 'P_ID', value: '123', type: 'auto' },
				{ name: 'p_date', value: '2026-03-15', type: 'date' },
				{ name: 'CODE', value: "A'B", type: 'string' }
			]
		);

		assert.strictEqual(
			result.sql,
			"select * from t where id = 123 and dt = DATE '2026-03-15' and code = 'A''B'"
		);
		assert.deepStrictEqual(result.unresolvedParameters, []);
	});

	test('keeps unresolved placeholders unchanged', () => {
		const result = resolveSqlParameters('select * from t where id = :P_ID and code = :P_CODE', [
			{ name: 'P_ID', value: '88', type: 'number' }
		]);

		assert.strictEqual(result.sql, 'select * from t where id = 88 and code = :P_CODE');
		assert.deepStrictEqual(result.unresolvedParameters, ['P_CODE']);
	});

	test('replaces blank parameter value with NULL', () => {
		const result = resolveSqlParameters('select * from t where code = :P_CODE', [
			{ name: 'P_CODE', value: '   ', type: 'auto' }
		]);

		assert.strictEqual(result.sql, 'select * from t where code = NULL');
		assert.deepStrictEqual(result.unresolvedParameters, []);
	});

	test('does not replace inside comments and strings', () => {
		const result = resolveSqlParameters(
			"select ':P_ID' txt from t -- :P_ID\nwhere id = :P_ID /* :P_ID */",
			[{ name: 'P_ID', value: '10', type: 'number' }]
		);

		assert.strictEqual(result.sql, "select ':P_ID' txt from t -- :P_ID\nwhere id = 10 /* :P_ID */");
	});
});
