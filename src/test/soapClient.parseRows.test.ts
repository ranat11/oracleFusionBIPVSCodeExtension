import * as assert from 'assert';

import { parseRowsFromXml } from '../services/soapClient';

suite('SOAP row extraction', () => {
	test('extracts rows from escaped RESULT payload', () => {
		const xml = `<?xml version='1.0' encoding='utf-8'?>
<DATA_DS>
  <P_SQL>select * from ap_invoices_all fetch first 5 rows only</P_SQL>
  <G_1>
    <RESULT>&lt;ROWSET xmlns:xsi = "http://www.w3.org/2001/XMLSchema-instance"&gt;
      &lt;ROW&gt;
        &lt;INVOICE_ID&gt;1001&lt;/INVOICE_ID&gt;
        &lt;INVOICE_NUM&gt;492-2024 290091&lt;/INVOICE_NUM&gt;
      &lt;/ROW&gt;
      &lt;ROW&gt;
        &lt;INVOICE_ID&gt;1002&lt;/INVOICE_ID&gt;
        &lt;INVOICE_NUM&gt;510-2024 40130&lt;/INVOICE_NUM&gt;
      &lt;/ROW&gt;
    &lt;/ROWSET&gt;</RESULT>
  </G_1>
</DATA_DS>`;

		const parsed = parseRowsFromXml(xml);
		assert.strictEqual(parsed.rows.length, 2);
		assert.ok(parsed.columns.includes('INVOICE_ID'));
		assert.ok(parsed.columns.includes('INVOICE_NUM'));
		assert.strictEqual(parsed.rows[0].INVOICE_ID, '1001');
		assert.strictEqual(parsed.rows[1].INVOICE_NUM, '510-2024 40130');
	});

	test('still extracts direct ROW payloads', () => {
		const xml = `<DATA_DS><ROWSET><ROW><ID>1</ID><NAME>A</NAME></ROW></ROWSET></DATA_DS>`;
		const parsed = parseRowsFromXml(xml);
		assert.strictEqual(parsed.rows.length, 1);
		assert.strictEqual(parsed.rows[0].ID, '1');
	});

	test('treats xsi nil values as empty strings', () => {
		const xml = `<?xml version='1.0' encoding='utf-8'?>
<DATA_DS>
  <ROWSET>
    <ROW>
      <ID>1</ID>
      <OPTIONAL_VALUE xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></OPTIONAL_VALUE>
    </ROW>
  </ROWSET>
</DATA_DS>`;

		const parsed = parseRowsFromXml(xml);
		assert.strictEqual(parsed.rows.length, 1);
		assert.ok(parsed.columns.includes('OPTIONAL_VALUE'));
		assert.strictEqual(parsed.rows[0].OPTIONAL_VALUE, '');
	});
});
