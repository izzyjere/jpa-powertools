import { defineConfig } from '@vscode/test-cli';

const configs = [
	{
		label: 'integration',
		files: 'out/test/integration/**/*.test.js',
		workspaceFolder: './src/test/fixtures/spring-app',
		mocha: { ui: 'tdd', timeout: 60000 },
	},
];

// The scripted demo only runs when scripts/record-demo.js prepares a workspace for it.
if (process.env.JPT_DEMO_WORKSPACE) {
	configs.push({
		label: 'demo',
		files: 'out/test/demo/**/*.test.js',
		workspaceFolder: process.env.JPT_DEMO_WORKSPACE,
		launchArgs: [`--user-data-dir=${process.env.JPT_DEMO_USER_DATA}`],
		mocha: { ui: 'tdd', timeout: 15 * 60000 },
	});
}

export default defineConfig(configs);
