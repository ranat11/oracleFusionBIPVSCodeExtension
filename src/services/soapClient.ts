import { XMLParser } from 'fast-xml-parser';

import { ActiveConnection, ConnectionFaultType, ConnectionTestStatus, QueryPage, QueryResult } from '../models';
import { buildPagedSql, hasTerminalPagingClause, stripTrailingSemicolon } from '../utils/sqlText';

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === 'AbortError';
	}
	if (error instanceof Error) {
		return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
	}
	return false;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

function withTimeout(timeoutMs: number): AbortSignal {
	return AbortSignal.timeout(timeoutMs);
}

function withOptionalTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	if (!signal) {
		return withTimeout(timeoutMs);
	}

	return AbortSignal.any([signal, withTimeout(timeoutMs)]);
}

function deepFind(node: unknown, keyName: string): unknown {
	if (node === null || node === undefined) {
		return undefined;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			const match = deepFind(item, keyName);
			if (match !== undefined) {
				return match;
			}
		}
		return undefined;
	}
	if (typeof node === 'object') {
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === keyName) {
				return value;
			}
			const nested = deepFind(value, keyName);
			if (nested !== undefined) {
				return nested;
			}
		}
	}
	return undefined;
}

function toArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

function normalizeConnectionTestError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const normalized = raw.toLowerCase();
	if (normalized.includes('aborted') || normalized.includes('timeout')) {
		return 'Request timed out while contacting Fusion BIP service.';
	}
	return raw;
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}


function splitSqlIntoChunks(sql: string, maxBytesPerChunk: number = 32767, maxCharsPerChunk: number = 40000): string[] {
	const chunks: string[] = [];
	let remaining = sql;
	const maxChunks = 10;

	while (remaining.length > 0) {
		if (chunks.length >= maxChunks) {
			throw new Error('SQL exceeds maximum supported payload.');
		}

		if (Buffer.byteLength(remaining, 'utf8') <= maxBytesPerChunk && remaining.length <= maxCharsPerChunk) {
			chunks.push(remaining);
			remaining = '';
			break;
		}

		let byteCount = 0;
		let lastSpaceIndex = -1;
		let forceSplitAt = remaining.length;

		for (let i = 0; i < remaining.length; i++) {
			const charBytes = Buffer.byteLength(remaining[i], 'utf8');
			if (byteCount + charBytes > maxBytesPerChunk || i >= maxCharsPerChunk) {
				forceSplitAt = i;
				break;
			}
			byteCount += charBytes;
			if (remaining[i] === ' ') {
				lastSpaceIndex = i;
			}
		}

		if (lastSpaceIndex > 0) {
			chunks.push(remaining.slice(0, lastSpaceIndex));
			remaining = remaining.slice(lastSpaceIndex + 1); // consume the space
		} else {
			throw new Error(
				`SQL chunking failed: no space found within ${Math.min(maxBytesPerChunk, maxCharsPerChunk)} limit. ` +
				'SQL must contain spaces so it can be split safely into p_sql...p_sql10 parameters.'
			);
		}
	}

	return chunks.length > 0 ? chunks : [''];
}

function normalizeRowValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return JSON.stringify(value);
	}
	if (typeof value !== 'object') {
		return String(value);
	}

	const record = value as Record<string, unknown>;
	if (record['@_nil'] === 'true' || record['@_nil'] === true || record['@_xsi:nil'] === 'true' || record['@_xsi:nil'] === true) {
		return '';
	}

	const textValue = record['#text'];
	if (typeof textValue === 'string' || typeof textValue === 'number' || typeof textValue === 'boolean') {
		return String(textValue);
	}

	return JSON.stringify(value);
}

function collectRows(rowsRaw: Array<Record<string, unknown>>): { columns: string[]; rows: Array<Record<string, string>> } {
	const columns: string[] = [];
	const rows: Array<Record<string, string>> = [];

	for (const rowNode of rowsRaw) {
		if (!rowNode || typeof rowNode !== 'object') {
			continue;
		}
		const rowData: Record<string, string> = {};
		for (const [key, value] of Object.entries(rowNode)) {
			if (!columns.includes(key)) {
				columns.push(key);
			}
			rowData[key] = normalizeRowValue(value);
		}
		rows.push(rowData);
	}

	return { columns, rows };
}

function parseXmlObject(parser: XMLParser, xml: string): Record<string, unknown> | undefined {
	try {
		return parser.parse(xml) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function parseRowsFromXml(reportXml: string): { columns: string[]; rows: Array<Record<string, string>> } {
	const parser = new XMLParser({
		ignoreAttributes: false,
		parseTagValue: false,
		trimValues: true,
		removeNSPrefix: true
	});
	const parsed = parseXmlObject(parser, reportXml);
	if (!parsed) {
		return { columns: [], rows: [] };
	}

	const rowsNode = deepFind(parsed, 'ROW');
	const rowsRaw = toArray(rowsNode as Record<string, unknown> | Array<Record<string, unknown>> | undefined);
	const directRows = collectRows(rowsRaw);
	if (directRows.rows.length > 0) {
		return directRows;
	}

	const resultNode = deepFind(parsed, 'RESULT');
	if (typeof resultNode !== 'string' || resultNode.trim().length === 0) {
		return directRows;
	}

	const nestedXml = decodeXmlEntities(resultNode.trim());
	const nestedParsed = parseXmlObject(parser, nestedXml);
	if (!nestedParsed) {
		return directRows;
	}

	const nestedRowsNode = deepFind(nestedParsed, 'ROW');
	const nestedRowsRaw = toArray(nestedRowsNode as Record<string, unknown> | Array<Record<string, unknown>> | undefined);
	return collectRows(nestedRowsRaw);
}

// Normalise whitespace and surface the meaningful error portion.
// For Oracle faults, start from the first ORA- code; otherwise strip
// the leading Java exception class chain and return the tail segment.
function cleanFaultText(raw: string): string {
	const normalized = raw.replace(/\s+/g, ' ').trim();
	const oraIndex = normalized.search(/ORA-\d+/);
	if (oraIndex !== -1) {
		const oracleMessage = normalized.slice(oraIndex).match(/^ORA-\d+:.*?(?=\s+ORA-\d+:|$)/);
		return (oracleMessage?.[0] ?? normalized.slice(oraIndex)).trim();
	}
	// Strip "SomeException: AnotherException: ..." prefix chains
	const parts = normalized.split(/:\s+/);
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i].trim();
		if (part.length > 0 && !/^[a-z][\w.]+Exception/.test(part) && !/^[a-z][\w.]+Error/.test(part)) {
			return part;
		}
	}
	return normalized;
}

function extractXmlTextValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const textValue = (value as Record<string, unknown>)['#text'];
	if (typeof textValue === 'string' && textValue.trim().length > 0) {
		return textValue;
	}

	return undefined;
}

function extractSoapFault(xml: string): string | undefined {
	const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, removeNSPrefix: true });
	let parsed: unknown;
	try {
		parsed = parser.parse(xml);
	} catch {
		return undefined;
	}
	const faultstring = deepFind(parsed, 'faultstring');
	const faultStringValue = extractXmlTextValue(faultstring);
	if (faultStringValue) {
		return cleanFaultText(faultStringValue);
	}
	const reasonText = deepFind(parsed, 'Text');
	const reasonTextValue = extractXmlTextValue(reasonText);
	if (reasonTextValue) {
		return cleanFaultText(reasonTextValue);
	}
	return undefined;
}

async function postSoap(url: string, envelope: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers,
		body: envelope,
		signal: withOptionalTimeout(timeoutMs, signal)
	});
}

export class BipClient {
	public constructor(private readonly logger?: (message: string) => void) {}

	private readonly requestTimeoutMs = 120000;
	private readonly testTimeoutMs = 30000;
	private readonly maxAttempts = 3;

	private log(message: string): void {
		this.logger?.(message);
	}

	public publicReportEndpoint(baseUrl: string): string {
		return `${normalizeBaseUrl(baseUrl)}/xmlpserver/services/ExternalReportWSSService`;
	}

	public catalogEndpoint(baseUrl: string): string {
		return `${normalizeBaseUrl(baseUrl)}/xmlpserver/services/v2/CatalogService`;
	}

	public async testConnection(connection: ActiveConnection): Promise<ConnectionTestStatus> {
		const details: string[] = [];
		const urlReachable = await this.checkUrlReachable(connection.baseUrl);
		details.push(urlReachable ? 'URL is reachable.' : 'URL is not reachable.');

		if (!urlReachable) {
			return {
				urlReachable,
				credentialsValid: false,
				reportInstalled: false,
				reportPath: connection.reportPath,
				details,
				faultType: 'other'
			};
		}

		let check: { credentialsValid: boolean; reportInstalled: boolean; faultType: ConnectionFaultType; faultMessage?: string };
		try {
			check = await this.checkCredentialsAndReport(connection, this.testTimeoutMs, 1);
		} catch (error) {
			const msg = normalizeConnectionTestError(error);
			details.push(`Connection check failed: ${msg}`);
			return {
				urlReachable,
				credentialsValid: false,
				reportInstalled: false,
				reportPath: connection.reportPath,
				details,
				faultType: 'other',
				faultMessage: msg
			};
		}

		details.push(check.credentialsValid ? 'Credentials are valid.' : 'Credentials were rejected.');
		if (check.credentialsValid) {
			details.push(check.reportInstalled ? `Report found at ${connection.reportPath}.` : `Report not found at ${connection.reportPath}.`);
		}

		return {
			urlReachable,
			credentialsValid: check.credentialsValid,
			reportInstalled: check.reportInstalled,
			reportPath: connection.reportPath,
			details,
			faultType: check.faultType,
			faultMessage: check.faultMessage
		};
	}

	public async runQuery(connection: ActiveConnection, sql: string, signal?: AbortSignal): Promise<QueryResult> {
		const started = Date.now();
		const parsedRows = await this.executeReportQuery(connection, sql, signal);
		this.log(`runQuery rows=${parsedRows.rows.length} columns=${parsedRows.columns.length} executionMs=${Date.now() - started}`);
		return {
			columns: parsedRows.columns,
			rows: parsedRows.rows,
			executionMs: Date.now() - started,
			query: sql,
			timestamp: new Date().toISOString()
		};
	}

	public async runPagedQuery(
		connection: ActiveConnection,
		baseSql: string,
		offset: number,
		pageSize: number,
		signal?: AbortSignal
	): Promise<QueryPage> {
		const started = Date.now();
		const normalizedBaseSql = stripTrailingSemicolon(baseSql);
		const safeOffset = Math.max(0, Math.floor(offset));
		const safePageSize = Math.max(1, Math.floor(pageSize));
		const pagedQuery = buildPagedSql(normalizedBaseSql, safeOffset, safePageSize + 1);

		if (hasTerminalPagingClause(normalizedBaseSql)) {
			this.log('Detected terminal paging clause in user SQL. Server-managed paging controls will be limited to this fixed query.');
		}

		this.log(`runPagedQuery offset=${safeOffset} pageSize=${safePageSize} sql="${pagedQuery}"`);
		const parsedRows = await this.executeReportQuery(connection, pagedQuery, signal);
		const hasMore = parsedRows.rows.length > safePageSize;
		const rows = hasMore ? parsedRows.rows.slice(0, safePageSize) : parsedRows.rows;

		this.log(`runPagedQuery rows=${rows.length} hasMore=${hasMore} columns=${parsedRows.columns.length} executionMs=${Date.now() - started}`);

		return {
			columns: parsedRows.columns,
			rows,
			executionMs: Date.now() - started,
			query: pagedQuery,
			timestamp: new Date().toISOString(),
			baseQuery: normalizedBaseSql,
			offset: safeOffset,
			pageSize: safePageSize,
			hasMore
		};
	}

	private async executeReportQuery(connection: ActiveConnection, sql: string, signal?: AbortSignal): Promise<{ columns: string[]; rows: Array<Record<string, string>> }> {
		const endpoint = this.publicReportEndpoint(connection.baseUrl);
		const envelope = this.buildRunReportEnvelope(sql, connection.reportPath);
		const response = await this.postWithRetry(endpoint, envelope, {
			Authorization: basicAuth(connection.username, connection.password),
			'Content-Type': 'application/soap+xml; charset=utf-8',
			SOAPAction: '#POST'
		}, this.requestTimeoutMs, this.maxAttempts, signal);
		const body = await response.text();
		const fault = extractSoapFault(body);
		if (fault) {
			this.log(`SOAP fault for SQL: ${fault}`);
			throw new Error(fault);
		}

		const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, removeNSPrefix: true });
		const parsed = parser.parse(body);
		const reportBytes = deepFind(parsed, 'reportBytes');
		let reportXml: string;
		if (typeof reportBytes === 'string' && reportBytes.trim().length > 0) {
			reportXml = Buffer.from(reportBytes.trim(), 'base64').toString('utf8');
			this.log(`BIP report content extracted from reportBytes, xmlLength=${reportXml.length}`);
		} else {
			const reportContent = deepFind(parsed, 'reportContent');
			if (typeof reportContent !== 'string') {
				this.log('BIP response did not include reportBytes or reportContent.');
				throw new Error('BIP response did not include report content.');
			}
			reportXml = reportContent;
			this.log(`BIP report content extracted from reportContent, xmlLength=${reportXml.length}`);
		}

		const parsedRows = parseRowsFromXml(reportXml);
		this.log(`Parsed report XML rows=${parsedRows.rows.length} columns=${parsedRows.columns.join(',') || '(none)'}`);
		return parsedRows;
	}

	public async uploadObject(connection: ActiveConnection, remotePath: string, objectType: string, base64Payload: string): Promise<void> {
		const endpoint = this.catalogEndpoint(connection.baseUrl);
		const envelope = this.buildUploadObjectEnvelope(remotePath, objectType, base64Payload, connection.username, connection.password);
		const response = await this.postWithRetry(endpoint, envelope, {
			'Content-Type': 'text/xml; charset=utf-8',
			SOAPAction: 'uploadObject',
			Authorization: basicAuth(connection.username, connection.password)
		});
		const body = await response.text();
		const fault = extractSoapFault(body);
		if (fault) {
			throw new Error(`Upload failed for ${remotePath}: ${fault}`);
		}
		if (!body.includes('uploadObjectReturn')) {
			throw new Error(`Upload did not return success marker for ${remotePath}.`);
		}
	}

	private async checkUrlReachable(baseUrl: string): Promise<boolean> {
		const probeUrl = `${normalizeBaseUrl(baseUrl)}/xmlpserver`;
		try {
			const response = await fetch(probeUrl, {
				method: 'GET',
				signal: withTimeout(10000)
			});
			return response.status < 500;
		} catch {
			return false;
		}
	}

	private async checkCredentialsAndReport(
		connection: ActiveConnection,
		timeoutMs = this.requestTimeoutMs,
		maxAttempts = this.maxAttempts
	): Promise<{ credentialsValid: boolean; reportInstalled: boolean; faultType: ConnectionFaultType; faultMessage?: string }> {
		const endpoint = this.catalogEndpoint(connection.baseUrl);
		const envelope = this.buildDownloadObjectEnvelope(connection.reportPath, connection.username, connection.password);
		const response = await this.postWithRetry(endpoint, envelope, {
			'Content-Type': 'text/xml; charset=utf-8',
			SOAPAction: 'downloadObject',
			Authorization: basicAuth(connection.username, connection.password)
		}, timeoutMs, maxAttempts);
		const body = await response.text();
		const fault = extractSoapFault(body);
		if (!fault) {
			return {
				credentialsValid: true,
				reportInstalled: body.includes('downloadObjectReturn'),
				faultType: 'none'
			};
		}

		const faultType = this.classifyFault(fault);
		if (faultType === 'invalid-credentials') {
			return { credentialsValid: false, reportInstalled: false, faultType, faultMessage: fault };
		}
		if (faultType === 'object-not-found') {
			return { credentialsValid: true, reportInstalled: false, faultType, faultMessage: fault };
		}

		return { credentialsValid: true, reportInstalled: false, faultType: 'other', faultMessage: fault };
	}

	private classifyFault(fault: string): ConnectionFaultType {
		const normalized = fault.toLowerCase();
		if (this.isCredentialFault(normalized)) {
			return 'invalid-credentials';
		}
		if (this.isObjectNotFoundFault(normalized)) {
			return 'object-not-found';
		}
		return 'other';
	}

	private isCredentialFault(fault: string): boolean {
		return (
			fault.includes('invalid username') ||
			fault.includes('invalid password') ||
			fault.includes('invalid username or password') ||
			fault.includes('failed to log into') ||
			fault.includes('failed to login') ||
			fault.includes('securityexception') ||
			fault.includes('security exception') ||
			fault.includes('credential') ||
			fault.includes('unauthorized') ||
			fault.includes('login')
		);
	}

	private isObjectNotFoundFault(fault: string): boolean {
		return (
			fault.includes('not found') ||
			fault.includes('does not exist') ||
			fault.includes('not exist') ||
			fault.includes('unable to find') ||
			fault.includes('no object') ||
			fault.includes('reportobject')
		);
	}

	private buildRunReportEnvelope(sql: string, reportPath: string): string {
		const chunks = splitSqlIntoChunks(sql);
		const paramItems = chunks
			.map((chunk, i) => {
				const name = i === 0 ? 'p_sql' : `p_sql${i + 1}`;
				return `          <pub:item>\n            <pub:name>${name}</pub:name>\n            <pub:values>\n              <pub:item><![CDATA[${chunk}]]></pub:item>\n            </pub:values>\n          </pub:item>`;
			})
			.join('\n');
		return `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:pub="http://xmlns.oracle.com/oxp/service/PublicReportService">\n  <soap:Body>\n    <pub:runReport>\n      <pub:reportRequest>\n        <pub:attributeFormat>xml</pub:attributeFormat>\n        <pub:byPassCache>true</pub:byPassCache>\n        <pub:reportAbsolutePath>${escapeXml(reportPath)}</pub:reportAbsolutePath>\n        <pub:sizeOfDataChunkDownload>-1</pub:sizeOfDataChunkDownload>\n        <pub:parameterNameValues>\n${paramItems}\n        </pub:parameterNameValues>\n      </pub:reportRequest>\n    </pub:runReport>\n  </soap:Body>\n</soap:Envelope>`;
	}

	private buildDownloadObjectEnvelope(reportPath: string, userId: string, password: string): string {
		return `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://xmlns.oracle.com/oxp/service/v2">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <v2:downloadObject>\n      <v2:reportAbsolutePath>${escapeXml(reportPath)}</v2:reportAbsolutePath>\n      <v2:userID>${escapeXml(userId)}</v2:userID>\n      <v2:password>${escapeXml(password)}</v2:password>\n    </v2:downloadObject>\n  </soapenv:Body>\n</soapenv:Envelope>`;
	}

	private buildUploadObjectEnvelope(remotePath: string, objectType: string, base64Payload: string, userId: string, password: string): string {
		return `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://xmlns.oracle.com/oxp/service/v2">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <v2:uploadObject>\n      <v2:reportObjectAbsolutePathURL>${escapeXml(remotePath)}</v2:reportObjectAbsolutePathURL>\n      <v2:objectType>${escapeXml(objectType)}</v2:objectType>\n      <v2:objectZippedData>${base64Payload}</v2:objectZippedData>\n      <v2:userID>${escapeXml(userId)}</v2:userID>\n      <v2:password>${escapeXml(password)}</v2:password>\n    </v2:uploadObject>\n  </soapenv:Body>\n</soapenv:Envelope>`;
	}

	private async postWithRetry(
		url: string,
		envelope: string,
		headers: Record<string, string>,
		timeoutMs = this.requestTimeoutMs,
		maxAttempts = this.maxAttempts,
		signal?: AbortSignal
	): Promise<Response> {
		let attempt = 0;
		let delayMs = 1000;
		while (true) {
			if (signal?.aborted) {
				throw new DOMException('The operation was aborted.', 'AbortError');
			}

			attempt += 1;
			let response: Response;
			try {
				response = await postSoap(url, envelope, headers, timeoutMs, signal);
			} catch (error) {
				if (isAbortError(error)) {
					throw error;
				}
				if (attempt >= maxAttempts) {
					throw error;
				}
				await this.delay(delayMs, signal);
				delayMs = Math.min(delayMs * 2, 30000);
				continue;
			}

			if (response.ok || !RETRYABLE_HTTP_STATUS.has(response.status) || attempt >= maxAttempts) {
				return response;
			}

			await this.delay(delayMs, signal);
			delayMs = Math.min(delayMs * 2, 30000);
		}
	}

	private async delay(ms: number, signal?: AbortSignal): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, ms);

			const onAbort = () => {
				clearTimeout(timer);
				reject(new DOMException('The operation was aborted.', 'AbortError'));
			};

			if (signal?.aborted) {
				onAbort();
				return;
			}

			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}
}
