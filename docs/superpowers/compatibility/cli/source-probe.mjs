/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'UPSTREAM_ROOT must point to the fixed upstream checkout');
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const manifest = [];
function source(path) {
	const bytes = readFileSync(`${root}/${path}`);
	assert.deepEqual(bytes, execFileSync('git', ['-C', root, 'show', `${pin}:${path}`]));
	manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), gitBlob: execFileSync('git', ['-C', root, 'rev-parse', `${pin}:${path}`]).toString().trim() });
	return ts.createSourceFile(path, bytes.toString(), ts.ScriptTarget.Latest, true);
}
const boot = source('packages/backend/src/boot/cli.ts');
const service = source('packages/backend/src/cli/CommandService.ts');
source('packages/backend/src/cli/CommandModule.ts');
source('packages/backend/src/GlobalModule.ts');
source('packages/backend/src/core/CoreModule.ts');

if (process.argv[2] === '--case') {
	const { args, fail } = JSON.parse(process.argv[3]);
	const ping = service.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'CommandService').members.find(n => ts.isMethodDeclaration(n) && n.name.getText(service) === 'ping');
	const commandService = {
		ping: vm.runInNewContext(`(async function() ${ping.body.getText(service)})`, { console }),
		resetCaptcha() { throw new Error('Reset-captcha mutation is outside this probe'); },
	};
	// Execute every non-import boot statement, including its exit calls. Only
	// the Nest initialization boundary is doubled; ping's real source runs.
	const body = boot.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(boot)).join('\n');
	process.argv = [process.execPath, 'upstream-cli', ...args];
	await vm.runInNewContext(`(async () => { ${body} })()`, {
		process, console, Error, EventEmitter: { defaultMaxListeners: 10 },
		CommandModule: class {}, CommandService: class {}, NestLogger: class {},
		NestFactory: { async createApplicationContext() {
			if (fail) { throw new Error('CLI_INITIALIZATION_FAILED'); }
			return { get() { return commandService; } };
		} },
	});
} else {
	assert(['--write', '--check'].includes(process.argv[2]));
	const cases = [];
	for (const args of [[], ['help'], ['ping'], ['ping', 'ignored'], ['unknown'], ['--help'], ['']]) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', JSON.stringify({ args })], { env: process.env, encoding: 'utf8', timeout: 5000 });
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		cases.push({ args, stdout: result.stdout, stderr: result.stderr, exitCode: result.status });
	}
	const failure = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', JSON.stringify({ args: ['ping'], fail: true })], { env: process.env, encoding: 'utf8', timeout: 5000 });
	assert.equal(failure.status, 1);
	assert.equal(failure.stdout, '');
	assert(failure.stderr.includes('CLI_INITIALIZATION_FAILED'));
	const output = JSON.stringify({ upstreamCommit: pin, mode: 'source subprocess; Nest context doubled; real boot dispatch and ping body', manifest, cases, initializationFailure: { stdout: failure.stdout, exitCode: failure.status, stderrIncludes: 'CLI_INITIALIZATION_FAILED' } }, null, 2) + '\n';
	const target = new URL('./source-observations.json', import.meta.url);
	if (process.argv[2] === '--write') {
		writeFileSync(target, output);
	} else {
		assert.equal(readFileSync(target, 'utf8'), output);
	}
	console.log(`CLI source: ${cases.length} dispatch cases / 1 initialization failure ${process.argv[2]} PASS`);
}
