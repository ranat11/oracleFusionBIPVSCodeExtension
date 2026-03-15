import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('Activates extension', async () => {
		const extension = vscode.extensions.all.find((item) => item.packageJSON.name === 'oracle-fusion-bip-vscode-extension');
		assert.ok(extension, 'Development extension should be discoverable.');
		if (!extension!.isActive) {
			await extension!.activate();
		}
		assert.ok(extension!.isActive, 'Extension should be active.');
	});

	test('Registers BIP commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expected = [
			'oracleFusionBIPVSCodeExtension.configureConnection',
			'oracleFusionBIPVSCodeExtension.createConnection',
			'oracleFusionBIPVSCodeExtension.selectConnection',
			'oracleFusionBIPVSCodeExtension.editConnection',
			'oracleFusionBIPVSCodeExtension.setActiveConnection',
			'oracleFusionBIPVSCodeExtension.deleteConnection',
			'oracleFusionBIPVSCodeExtension.createParameter',
			'oracleFusionBIPVSCodeExtension.editParameter',
			'oracleFusionBIPVSCodeExtension.deleteParameter',
			'oracleFusionBIPVSCodeExtension.installReport',
			'oracleFusionBIPVSCodeExtension.stopQuery',
			'oracleFusionBIPVSCodeExtension.runQuery',
			'oracleFusionBIPVSCodeExtension.exportCsv',
			'oracleFusionBIPVSCodeExtension.exportXlsx',
			'oracleFusionBIPVSCodeExtension.clearOutput'
		];

		for (const command of expected) {
			assert.ok(commands.includes(command), `Missing command: ${command}`);
		}
	});
});
