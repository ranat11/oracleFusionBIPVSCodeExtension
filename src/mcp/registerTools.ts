import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ActiveConnection } from '../models';
import { BipClient } from '../services/soapClient';

export function registerBipQueryTool(
	server: McpServer,
	resolveConnection: () => Promise<ActiveConnection>
): void {
	const client = new BipClient();

	server.tool(
		'bip_run_query',
		'Execute a SQL query against Oracle Fusion BI Publisher and return the results as JSON. ' +
		'Do NOT add FETCH FIRST, ROWNUM, or any row-limiting clause to the SQL — the server ' +
		'automatically limits results to 5 rows.',
		{
			sql: z.string().describe(
				'The SQL query to execute. Do not include FETCH FIRST or ROWNUM — row limiting is applied automatically.'
			),
		},
		async ({ sql }) => {
			const connection = await resolveConnection();
			const result = await client.runPagedQuery(connection, sql, 0, 5);

			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								columns: result.columns,
								rows: result.rows,
								rowCount: result.rows.length,
								executionMs: result.executionMs,
								timestamp: result.timestamp,
							},
							null,
							2
						),
					},
				],
			};
		}
	);
}