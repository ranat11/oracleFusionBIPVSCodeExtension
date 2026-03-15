export interface ConnectionProfile {
	baseUrl: string;
	username: string;
	reportPath: string;
}

export const FIXED_CATALOG_ROOT = '/Custom/VS Code Extension';
export const FIXED_REPORT_PATH = `${FIXED_CATALOG_ROOT}/VS_CODE_EXTENSION.xdo`;

export interface SavedConnection extends ConnectionProfile {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface StoredConnections {
	activeConnectionId?: string;
	connections: SavedConnection[];
}

export type ParameterValueType = 'auto' | 'string' | 'number' | 'date';
export type SavedParameterValueType = Exclude<ParameterValueType, 'auto'>;

export interface SavedParameter {
	name: string;
	value: string;
	type: SavedParameterValueType;
	createdAt: string;
	updatedAt: string;
}

export type StoredParametersByConnection = Record<string, SavedParameter[]>;

export type ConnectionFaultType = 'none' | 'invalid-credentials' | 'object-not-found' | 'other';

export interface ActiveConnection extends ConnectionProfile {
	password: string;
}

export interface ConnectionTestStatus {
	urlReachable: boolean;
	credentialsValid: boolean;
	reportInstalled: boolean;
	reportPath: string;
	details: string[];
	faultType: ConnectionFaultType;
	faultMessage?: string;
}

export interface QueryResult {
	columns: string[];
	rows: Array<Record<string, string>>;
	executionMs: number;
	query: string;
	timestamp: string;
}

export interface QueryPage extends QueryResult {
	baseQuery: string;
	offset: number;
	pageSize: number;
	hasMore: boolean;
}
