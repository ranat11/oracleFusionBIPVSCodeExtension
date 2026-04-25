import * as assert from 'assert';

import { buildSqlHeaderTemplate, formatSqlDocument, SqlFormatterConfig } from '../utils/sqlFormatter';

const baseConfig: SqlFormatterConfig = {
	enabled: true,
	keywordCase: 'upper',
	identifierCase: 'preserve',
	indentSize: 2,
	alignAliases: true,
	clauseBreaks: true,
	commaPlacement: 'trailing',
	compactParenthesesWordLimit: 5,
};

suite('SQL Formatter', () => {
	test('respects disabled switch', () => {
		const input = 'select col1 from dual';
		const output = formatSqlDocument(input, { ...baseConfig, enabled: false });
		assert.strictEqual(output, input);
	});

	test('formats clauses with uppercase keywords', () => {
		const input = 'select col1,col2 from dual where col1=1';
		const output = formatSqlDocument(input, baseConfig);
		assert.ok(output.includes('SELECT'));
		assert.ok(output.includes('\nFROM'));
		assert.ok(output.includes('\nWHERE'));
	});

	test('preserves comments', () => {
		const input = '-- keep me\nselect col1 from dual';
		const output = formatSqlDocument(input, baseConfig);
		assert.ok(output.includes('-- keep me'));
	});

	test('does not leak lowercase placeholder tokens when keyword and identifier case are lower', () => {
		const input = [
			'-- keep full-line comment',
			'SELECT col1 /* keep inline */',
			'FROM dual',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, keywordCase: 'lower', identifierCase: 'lower' }, 'sql');
		assert.ok(output.includes('-- keep full-line comment'));
		assert.ok(output.includes('/* keep inline */'));
		assert.ok(!/__bip_sql_comment_line__\d+__/iu.test(output));
		assert.ok(!/__bip_sql_comment__\d+__/iu.test(output));
	});

	test('preserves pure standalone dash comments without formatting errors', () => {
		const input = '--\n-- keep me\n';
		const output = formatSqlDocument(input, baseConfig);
		assert.strictEqual(output, input);
	});

	test('does not leak comment placeholder tokens when inline and full-line comments are adjacent', () => {
		const input = [
			'SELECT nvl(a, b, c) AS a_b, c',
			'FROM AP_INVOICE_DISTRIBUTIONS_ALL --adb',
			'-- fddf',
		].join('\n');
		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(!output.includes('__BIP_SQL_COMMENT_LINE__'));
		assert.ok(!output.includes('__BIP_SQL_COMMENT__'));
		assert.ok(output.includes('--adb'));
		assert.ok(output.includes('-- fddf'));
		assert.ok(/--adb\s*\n\s*-- fddf/u.test(output));
		assert.ok(!output.includes('--adb -- fddf'));
	});

	test('does not insert an empty line between FROM and full-line comment', () => {
		const input = [
			'SELECT nvl(a, b, c) AS a_b,',
			'       c',
			'FROM AP_INVOICE_DISTRIBUTIONS_ALL --adb',
			'  -- adf',
		].join('\n');
		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(!/--adb\s*\n\s*\n\s*-- adf/u.test(output));
		assert.ok(/--adb\s*\n\s*-- adf/u.test(output));
	});

	test('indents nested subquery FROM clause inside parentheses', () => {
		const input = [
			'SELECT a, b, c',
			'FROM AP_INVOICE_DISTRIBUTIONS_ALL, (SELECT 1, 1, 1 FROM dual)',
			'WHERE INVOICE_ID = :P_INVOICE_ID',
		].join('\n');
		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(/\n\s{2}\(\n\s{4}SELECT/u.test(output));
		assert.ok(/\n\s{4}FROM\n\s{6}dual/u.test(output));
	});

	test('keeps FROM table line indented when comment line appears before and after', () => {
		const input = [
			'SELECT nvl(a, b, c) AS a_b, c',
			'FROM',
			'  -- adf',
			'AP_INVOICE_DISTRIBUTIONS_ALL,',
			'asdfdf',
			'  -- adb',
			'  -- ddfdf',
		].join('\n');
		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(/\nFROM\n\s{2}-- adf\n\s{2}AP_INVOICE_DISTRIBUTIONS_ALL,/u.test(output));
		assert.ok(/\n\s{2}asdfdf\n\s{2}-- adb\n\s{2}-- ddfdf/u.test(output));
	});

	test('formats recursive CTE stress query without parser errors', () => {
		const input = [
			'/* PROJECT: Quarterly Performance Audit 2026 */',
			'WITH',
			'recursive employee_hierarchy AS (',
			'  -- Base case',
			'  SELECT id, name, manager_id, 1 AS depth',
			'  FROM employees',
			'  WHERE manager_id IS NULL',
			'  UNION ALL',
			'  SELECT e.id, e.name, e.manager_id, eh.depth + 1',
			'  FROM employees e',
			'  JOIN employee_hierarchy eh ON e.manager_id = eh.id',
			'),',
			'monthly_sales AS (',
			'  SELECT employee_id, EXTRACT(MONTH FROM sale_date) AS sales_month, SUM(amount) AS total_amt',
			'  FROM sales',
			'  GROUP BY 1, 2',
			')',
			'SELECT eh.name, ms.total_amt',
			'FROM employee_hierarchy eh',
			'LEFT JOIN monthly_sales ms ON eh.id = ms.employee_id',
			'ORDER BY eh.depth ASC, ms.total_amt DESC NULLS LAST',
		].join('\n');

		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(output.includes('WITH RECURSIVE'));
		assert.ok(!output.includes('__BIP_SQL_COMMENT_LINE__'));
		assert.ok(!output.includes('__BIP_SQL_COMMENT__'));
		assert.ok(output.includes('-- Base case'));
	});

	test('keeps qualified joins and select columns consistently indented for stress query with lateral and legacy oracle joins', () => {
		const input = [
			'/* STRESS TEST V3: "The Syntax Nightmare"',
			'   Testing: LATERAL joins, Full Outer Joins, and Oracle (+) Legacy Syntax',
			'*/',
			'WITH',
			'recursive employee_hierarchy AS (',
			'  SELECT',
			'    id,',
			'    NAME,',
			'    manager_id,',
			'    1 AS depth',
			'    FROM',
			'      employees',
			'    WHERE',
			'      manager_id IS NULL',
			'    UNION ALL',
			'    SELECT',
			'      e.id,',
			'      e.name,',
			'      e.manager_id,',
			'      eh.depth + 1',
			'    FROM',
			'      employees e',
			'    JOIN employee_hierarchy eh ON e.manager_id = eh.id',
			'),',
			'monthly_sales AS (',
			'  SELECT',
			'    employee_id,',
			'    EXTRACT(MONTH FROM sale_date) AS sales_month,',
			'    SUM(amount)                   AS total_amt',
			'    FROM',
			'      sales',
			'    WHERE',
			"      sale_date >= '2023-01-01'",
			'    GROUP BY',
			'      1,',
			'      2',
			')',
			'SELECT',
			'  eh.name AS employee_name,',
			'  pos.title,',
			'  ms.total_amt,',
			'  audit.change_log,',
			'  -- Testing legacy Oracle-style outer join syntax',
			'dep.dept_name,',
			'  mgr.mgr_name',
			'FROM',
			'  employee_hierarchy eh',
			'-- 1. Standard Left Join',
			'LEFT JOIN positions pos ON eh.id = pos.employee_id',
			'-- 2. LATERAL Join (Postgres style)',
			'  CROSS',
			'JOIN LATERAL (',
			'    SELECT',
			"      string_agg (log_desc, ' | ') AS change_log",
			'    FROM',
			'      audit_logs',
			'    WHERE',
			'      audit_logs.emp_id = eh.id',
			"      AND log_date > now () - INTERVAL '30 days'",
			') AS audit',
			'-- 3. Full Outer Join (Testing vertical alignment)',
			'FULL OUTER',
			'JOIN monthly_sales ms ON eh.id = ms.employee_id',
			"-- 4. Legacy Oracle Syntax (Where '+' is used for Outer Joins)",
			"-- Note: Many modern formatters fail here or try to add spaces around the '+'",
			'JOIN departments dep ON eh.dept_id = dep.id (+)',
			'JOIN managers mgr ON eh.mgr_code = mgr.mgr_code (+)',
			'WHERE',
			'  (eh.depth < 5 OR audit.change_log IS NOT NULL)',
			'/* Final checks */',
			'ORDER BY',
			'  1,',
			'  2 DESC',
			'  LIMIT 50',
			'  OFFSET',
			'  0;',
		].join('\n');

		const output = formatSqlDocument(input, baseConfig, 'sql');
		assert.ok(/\n\s{2}dep\.dept_name,/u.test(output));
		assert.ok(!/\n\s*CROSS\s*\n\s*JOIN\s+LATERAL\b/u.test(output));
		assert.ok(/\n\s{2}CROSS\s+JOIN\s+LATERAL\s*\(/u.test(output));
		assert.ok(/\n\s{2}FULL\s+OUTER\s+JOIN\s+monthly_sales\b/u.test(output));
		assert.ok(/\n\s{2}JOIN\s+departments\s+dep\b/u.test(output));
		assert.ok(/\n\s{2}JOIN\s+managers\s+mgr\b/u.test(output));
	});

	test('formats oracle mega stress query with where-continuation and order siblings indentation', () => {
		const input = [
			'/* ORACLE MEGA-STRESS TEST V5',
			'   Features: Nested CTEs, LATERAL joins, Legacy (+) Joins,',
			'   Hierarchical CONNECT BY, and XML/JSON serialization.',
			'*/',
			'WITH',
			'rEcurSive_base AS (',
			'  SELECT',
			'    employee_id,',
			'    manager_id,',
			'    last_name,',
			'    department_id,',
			'    salary,',
			'    1 AS lvl',
			'    FROM',
			'      employees',
			'      START WITH manager_id IS NULL',
			'      CONNECT BY PRIOR employee_id = manager_id',
			'),',
			'dept_stats AS (',
			'  SELECT',
			'    department_id,',
			'    AVG(salary) OVER (PARTITION BY department_id) AS avg_sal',
			'    FROM',
			'      employees',
			')',
			'SELECT',
			'  rb.last_name,',
			'  rb.lvl,',
			'  d.dept_name,',
			'  -- Testing LATERAL with a nested subquery',
			'  lat_info.total_assets,',
			'  lat_info.risk_factor,',
			'  -- Testing XML functions (common in complex Oracle environments)',
			'  XMLELEMENT (',
			'  "Emp",',
			'  XMLATTRIBUTES (rb.employee_id AS "ID"),',
			'  rb.last_name',
			').getClobVal ()                 AS xml_data',
			'FROM',
			'  rEcurSive_base rb',
			'-- 1. CROSS APPLY (The Oracle version of a LATERAL join)',
			'  CROSS APPLY (',
			'    SELECT',
			'      SUM(assets) AS total_assets,',
			'      CASE',
			"      WHEN COUNT(*) > 5 THEN 'HIGH'",
			"      ELSE 'LOW'",
			'      END         AS risk_factor',
			'    FROM',
			'      portfolio p',
			'    WHERE',
			'      p.owner_id = rb.employee_id -- Correlated reference',
			'',
			') lat_info',
			'-- 2. Modern LATERAL keyword usage',
			'  LEFT OUTER JOIN LATERAL (SELECT * FROM bonus_history bh WHERE bh.emp_id = rb.employee_id) bh_lat ON 1 = 1',
			'-- 3. The Legacy (+) "Formatter Breaker"',
			'-- Testing multiple joins with (+) and complex logic in the join condition',
			'  JOIN departments d ON rb.department_id = d.dept_id (+)',
			'  JOIN locations l ON d.loc_id = l.id (+)',
			"    AND l.country_id (+) = 'US'",
			'WHERE',
			'  rb.salary > (',
			'    SELECT',
			'      avg_sal',
			'    FROM',
			'      dept_stats ds',
			'    WHERE',
			'      ds.department_id = rb.department_id (+)',
			')',
			"AND rb.last_name NOT LIKE 'Test%'",
			'ORDER SIBLINGS BY',
			'rb.last_name;',
		].join('\n');

		const output = formatSqlDocument(input, baseConfig, 'plsql');
		assert.ok(/\n\s{2}AND rb\.last_name NOT LIKE 'Test%'/u.test(output));
		assert.ok(/\nORDER SIBLINGS BY\n\s{2}rb\.last_name;/u.test(output));
		assert.ok(/\n\s{2}CROSS APPLY\s*\(/u.test(output));
	});

	test('applies identifier case formatting when configured', () => {
		const input = [
			'with rEcurSive_base as (',
			'  select employee_id, Last_Name from Employees',
			')',
			'select rb.last_name from rEcurSive_base rb',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, identifierCase: 'upper' }, 'sql');
		assert.ok(output.includes('RECURSIVE_BASE'));
		assert.ok(output.includes('EMPLOYEE_ID'));
		assert.ok(output.includes('LAST_NAME'));
		assert.ok(output.includes('EMPLOYEES'));
	});

	test('indents START WITH and CONNECT BY as hierarchical clause headers', () => {
		const input = [
			'SELECT employee_id, manager_id',
			'FROM employees START WITH manager_id IS NULL CONNECT BY PRIOR employee_id = manager_id',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, keywordCase: 'upper' }, 'plsql');
		assert.ok(/\nFROM\n\s{2}employees\nSTART WITH manager_id IS NULL\nCONNECT BY PRIOR employee_id = manager_id/u.test(output));
	});

	test('aligns FROM with SELECT clause inside CTE', () => {
		const input = [
			'WITH cte AS (',
			'  SELECT employee_id, manager_id, 1 AS lvl FROM employees',
			')',
			'SELECT * FROM cte',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, keywordCase: 'upper' }, 'plsql');
		assert.ok(/\n\s{2}SELECT\n\s{4}employee_id,\n\s{4}manager_id,\n\s{4}1 AS lvl\n\s{2}FROM\n\s{4}employees/u.test(output));
	});

	test('indents WHEN and ELSE inside CASE expressions', () => {
		const input = [
			'SELECT',
			'  CASE',
			"  WHEN score >= 80 THEN 'A'",
			"  ELSE 'B'",
			'  END AS grade',
			'FROM exams',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, keywordCase: 'upper' }, 'sql');
		assert.ok(/\n\s{2}CASE\n\s{4}WHEN score >= 80 THEN 'A'\n\s{4}ELSE 'B'\n\s{2}END AS grade/u.test(output));
	});

	test('aligns closing parenthesis with opener and indents multiline function args', () => {
		const input = [
			'SELECT',
			'  rb.last_name,',
			'  XMLELEMENT (',
			'  "Emp",',
			'  XMLATTRIBUTES (rb.employee_id AS "ID"),',
			'  rb.last_name',
			').getClobVal () AS xml_data',
			'FROM rEcurSive_base rb',
			'CROSS APPLY (',
			'  SELECT SUM(assets) AS total_assets',
			'  FROM portfolio p',
			'  WHERE p.owner_id = rb.employee_id -- Correlated reference',
			') lat_info',
			'WHERE rb.salary > (',
			'  SELECT avg_sal',
			'  FROM dept_stats ds',
			'  WHERE ds.department_id = rb.department_id (+)',
			')',
		].join('\n');

		const output = formatSqlDocument(input, baseConfig, 'plsql');
		assert.ok(/\n\s{2}XMLELEMENT \(\n\s{4}"Emp",\n\s{4}XMLATTRIBUTES \(rb\.employee_id AS "ID"\),\n\s{4}rb\.last_name\n\s{2}\)\.getClobVal \(\)\s+AS xml_data/u.test(output));
		assert.ok(!/Correlated reference\s*\n\s*\n\s*\) lat_info/u.test(output));
		assert.ok(/\n\s{2}CROSS APPLY \([\s\S]*\n\s{2}\) lat_info/u.test(output));
		assert.ok(/\n\s{2}rb\.salary > \([\s\S]*\n\s{2}\)\n/u.test(output));
	});

	test('keeps top-level CTE names unindented after comma separator', () => {
		const input = [
			'WITH',
			'abs AS (',
			'  SELECT employee_id FROM employees',
			'),',
			'  dept_stats AS (',
			'    SELECT department_id FROM employees',
			')',
			'SELECT * FROM abs',
		].join('\n');

		const output = formatSqlDocument(input, baseConfig, 'plsql');
		assert.ok(/\n\),\ndept_stats AS \(/u.test(output));
	});

	test('inlines short multiline subquery in parentheses when under word limit', () => {
		const input = [
			'SELECT ABS(',
			'  salary - (',
			'    SELECT',
			'    AVG(salary)',
			'    FROM',
			'    employees',
			'  )',
			') AS salary_diff',
			'FROM employees',
		].join('\n');

		const output = formatSqlDocument(input, { ...baseConfig, compactParenthesesWordLimit: 12 }, 'plsql');
		assert.ok(output.includes('salary - (SELECT AVG(salary) FROM employees)'));
	});

	test('does not reformat full-line comments', () => {
		const input = '    -- keep exact spacing and case\nselect col1 from dual';
		const output = formatSqlDocument(input, baseConfig);
		assert.ok(output.includes('    -- keep exact spacing and case'));
	});

	test('keeps short parenthesized expression in one line', () => {
		const input = 'select * from dual where id in (\n  1\n)';
		const output = formatSqlDocument(input, { ...baseConfig, compactParenthesesWordLimit: 5 });
		assert.ok(output.includes('IN (1)') || output.includes('in (1)'));
	});

	test('builds default header template', () => {
		const template = buildSqlHeaderTemplate('my_report.sql', 'Ranat', new Date('2026-04-25T00:00:00.000Z'));
		assert.ok(template.includes('Object Name         : my_report.sql'));
		assert.ok(template.includes('Ranat           25-Apr-2026          1.0    Initial draft'));
		assert.ok(template.startsWith('/************************************************************************************'));
	});

	test('keeps standalone slash as pure separator line', () => {
		const input = 'begin\n  null;\n /\nselect 10/2 as result from dual';
		const output = formatSqlDocument(input, baseConfig, 'plsql');
		assert.ok(output.includes('\n/\n'));
		assert.ok(output.includes('10 / 2'));
	});
});
