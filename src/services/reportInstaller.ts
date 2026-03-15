import * as fs from 'fs/promises';
import * as path from 'path';

import JSZip from 'jszip';

import { ActiveConnection } from '../models';
import { BipClient } from './soapClient';

const SUPPORTED_EXTENSIONS = new Set(['.xdo', '.xdm', '.xdr', '.xdoz', '.xdmz', '.xdrz']);

function objectTypeFromExtension(fileExtension: string): string {
	switch (fileExtension.toLowerCase()) {
		case '.xdm':
		case '.xdmz':
			return 'xdmz';
		case '.xdr':
		case '.xdrz':
			return 'xdrz';
		default:
			return 'xdoz';
	}
}

async function collectFiles(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const results: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const nested = await collectFiles(fullPath);
			results.push(...nested);
			continue;
		}
		if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			results.push(fullPath);
		}
	}
	return results;
}

async function zipRawObject(filePath: string): Promise<Buffer> {
	const fileExt = path.extname(filePath).toLowerCase();
	if (fileExt.endsWith('z')) {
		return fs.readFile(filePath);
	}

	const zip = new JSZip();
	const fileName = path.basename(filePath);
	const fileData = await fs.readFile(filePath);
	zip.file(fileName, fileData);

	const catalogPath = `${filePath}.catalog`;
	try {
		const catalogData = await fs.readFile(catalogPath);
		zip.file(path.basename(catalogPath), catalogData);
	} catch {
		// Catalog companion is optional.
	}

	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export class ReportInstaller {
	public constructor(private readonly client: BipClient) {}

	public async installBundledZip(
		connection: ActiveConnection,
		bundleZipPath: string,
		targetRemotePath: string,
		objectType = 'xdoz'
	): Promise<void> {
		const payload = await fs.readFile(bundleZipPath);
		await this.client.uploadObject(connection, targetRemotePath, objectType, payload.toString('base64'));
	}

	public async installFolder(connection: ActiveConnection, sourceFolder: string, targetRoot: string): Promise<number> {
		const files = await collectFiles(sourceFolder);
		if (files.length === 0) {
			throw new Error('No report artifacts found. Expected .xdo/.xdm/.xdr or zipped variants.');
		}

		let uploaded = 0;
		for (const filePath of files) {
			const relative = path.relative(sourceFolder, filePath).replace(/\\/g, '/');
			const remotePath = `${targetRoot.replace(/\/+$/, '')}/${relative}`;
			const extension = path.extname(filePath);
			const objectType = objectTypeFromExtension(extension);
			const payload = await zipRawObject(filePath);
			await this.client.uploadObject(connection, remotePath, objectType, payload.toString('base64'));
			uploaded += 1;
		}

		return uploaded;
	}
}
