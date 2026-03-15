import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { FIXED_REPORT_PATH } from '../models';
import { BipClient } from '../services/soapClient';

function parseEnvValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (trimmed.length === 0) {
		return '';
	}

	const firstChar = trimmed[0];
	const lastChar = trimmed[trimmed.length - 1];
	if ((firstChar === '"' || firstChar === '\'') && lastChar === firstChar) {
		return trimmed.slice(1, -1);
	}

	const commentIndex = trimmed.indexOf(' #');
	return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

function loadEnvFile(filePath: string): void {
	if (!fs.existsSync(filePath)) {
		return;
	}

	const content = fs.readFileSync(filePath, 'utf8');
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		const separatorIndex = trimmed.indexOf('=');
		if (separatorIndex <= 0) {
			continue;
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		const value = parseEnvValue(trimmed.slice(separatorIndex + 1));
		if (key.length > 0 && process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

loadEnvFile(path.resolve(__dirname, '../../.env.test.local'));

suite('BipClient Integration Test Suite', function () {
	this.timeout(180000);

	const enabled = process.env.BIP_E2E_ENABLED === 'true';
	const installedUrl = process.env.BIP_INSTALLED_URL;
	const noReportUrl = process.env.BIP_NO_REPORT_URL;
	const username = process.env.BIP_USERNAME;
	const password = process.env.BIP_PASSWORD;
	const invalidUrl = process.env.BIP_INVALID_URL ?? 'https://invalid-host-for-bip-test.oraclecloud.invalid';
	const querySql = process.env.BIP_QUERY_SQL ?? 'select * from ap_invoices_all';

	const hasCredentials = Boolean(username && password);
	const client = new BipClient();
	const installedReportTest = enabled && hasCredentials && Boolean(installedUrl) ? test : test.skip;
	const noReportTest = enabled && hasCredentials && Boolean(noReportUrl) ? test : test.skip;
	const integrationTest = enabled && hasCredentials ? test : test.skip;

	installedReportTest('Valid URL + installed report should pass', async function () {
		const status = await client.testConnection({
			baseUrl: installedUrl!,
			username: username!,
			password: password!,
			reportPath: FIXED_REPORT_PATH
		});

		assert.strictEqual(status.urlReachable, true, 'Expected URL to be reachable.');
		assert.strictEqual(status.credentialsValid, true, `Expected credentials to be valid. fault=${status.faultMessage ?? 'none'}`);
		assert.strictEqual(status.reportInstalled, true, `Expected report to be installed at ${FIXED_REPORT_PATH}. fault=${status.faultMessage ?? 'none'}`); 
	});

	noReportTest('Valid URL + no report installed should fail only report check', async function () {
		const status = await client.testConnection({
			baseUrl: noReportUrl!,
			username: username!,
			password: password!,
			reportPath: FIXED_REPORT_PATH
		});

		assert.strictEqual(status.urlReachable, true, 'Expected URL to be reachable.');
		assert.strictEqual(status.credentialsValid, true, `Expected credentials to be valid. fault=${status.faultMessage ?? 'none'}`);
		assert.strictEqual(status.reportInstalled, false, 'Expected report to be missing for this environment.');
		assert.strictEqual(status.faultType, 'object-not-found', `Expected object-not-found fault. got=${status.faultType} message=${status.faultMessage ?? 'none'}`);
	});

	integrationTest('Invalid credentials should return invalid-credentials', async function () {
		const status = await client.testConnection({
			baseUrl: installedUrl!,
			username: username!,
			password: `${password!}_invalid`,
			reportPath: FIXED_REPORT_PATH
		});

		assert.strictEqual(status.urlReachable, true, 'Expected URL to be reachable.');
		assert.strictEqual(status.credentialsValid, false, 'Expected credentials to be rejected.');
		assert.strictEqual(status.faultType, 'invalid-credentials', `Expected invalid-credentials fault. got=${status.faultType} message=${status.faultMessage ?? 'none'}`);
	});

	installedReportTest('select * from ap_invoices_all should return columns and rows', async function () {
		const result = await client.runQuery({
			baseUrl: installedUrl!,
			username: username!,
			password: password!,
			reportPath: FIXED_REPORT_PATH
		}, querySql);

		assert.strictEqual(result.query, querySql, 'Expected query text to be preserved in the result payload.');
		assert.ok(result.executionMs >= 0, 'Expected execution time to be recorded.');
		assert.ok(result.columns.length > 0, 'Expected the query to return at least one column.');
		assert.ok(result.rows.length > 0, 'Expected the query to return at least one row.');

		for (const column of result.columns) {
			assert.ok(column.length > 0, 'Expected every column name to be non-empty.');
		}
	});

	integrationTest('Invalid URL should return unreachable URL state', async function () {
		const status = await client.testConnection({
			baseUrl: invalidUrl,
			username: username!,
			password: password!,
			reportPath: FIXED_REPORT_PATH
		});

		assert.strictEqual(status.urlReachable, false, 'Expected invalid URL to be unreachable.');
		assert.strictEqual(status.credentialsValid, false, 'Expected credentials check to fail when URL is unreachable.');
		assert.strictEqual(status.reportInstalled, false, 'Expected report check to fail when URL is unreachable.');
	});
});
