/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

let directory: string;
let configPath: string;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'backend-cli-'));
	configPath = join(directory, 'config.yml');
	// Neither address is listening: CLI commands must not open dependencies.
	await writeFile(configPath, 'url: https://example.test\nport: 3000\ndb:\n  host: 127.0.0.1\n  port: 1\n  db: unused\n  user: unused\nredis:\n  host: 127.0.0.1\n  port: 1\n');
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

function execute(file: string, args: string[], config = configPath) {
	return new Promise<{ stdout: string; stderr: string; code: number | string; }>((done) => {
		execFile(file, args, {
			env: { ...process.env, MISSKEY_CONFIG_YML: config }, timeout: 5000,
		}, (error, stdout, stderr) => {
			done({ stdout, stderr, code: error ? (error.code ?? error.signal ?? 'PROCESS_FAILED') : 0 });
		});
	});
}

function run(args: string[], config = configPath) {
	return execute(process.execPath, ['--import', resolve('test/fixtures/cli-no-network.mjs'), resolve('built/entrypoints/cli.js'), ...args], config);
}

test('does not treat signal termination after expected stdout as success', async () => {
	const result = await execute(process.execPath, ['--eval', "process.stdout.write('pong\\n', () => process.kill(process.pid, 'SIGTERM'))"]);
	expect(result).toEqual({ stdout: 'pong\n', stderr: '', code: 'SIGTERM' });
});

test.each([{ args: [] }, { args: ['help'] }])('offers implemented commands and exits naturally: $args', async ({ args }) => {
	const result = await run(args);
	expect(result).toEqual({ stdout: 'Available commands:\n  help - Displays this help message\n  ping - Prints pong\n', stderr: '', code: 0 });
});

test('runs ping through the distribution package script', async () => {
	const result = await execute('pnpm', ['--silent', 'cli', 'ping']);
	expect(result).toEqual({ stdout: 'pong\n', stderr: '', code: 0 });
});

const observations = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/cli/source-observations.json', import.meta.url), 'utf8')) as {
	cases: { args: string[]; stdout: string; stderr: string; exitCode: number; }[];
};
test.each(observations.cases.filter(row => row.args.length && row.args[0] !== 'help'))('matches fixed upstream stdout/stderr/exit for $args', async (row) => {
	expect(await run(row.args)).toEqual({ stdout: row.stdout, stderr: row.stderr, code: row.exitCode });
});

test.each([{ args: ['ping'] }, { args: ['ping', 'ignored'] }])('prints pong without contacting configured dependencies: $args', async ({ args }) => {
	expect(await run(args)).toEqual({ stdout: 'pong\n', stderr: '', code: 0 });
});

test.each(['unknown', 'reset-captcha', '--help', ''])('rejects unsupported command %j with guidance', async (command) => {
	expect(await run([command])).toEqual({ stdout: '', stderr: `Unrecognized command: ${command}\nUse "help" to see available commands.\n`, code: 1 });
});

test.each([{ args: [] }, { args: ['help'] }, { args: ['ping'] }, { args: ['unknown'] }])('fails before dispatch when configuration initialization fails: $args', async ({ args }) => {
	const result = await run(args, join(directory, 'missing.yml'));
	expect(result.code).toBe(1);
	expect(result.stdout).toBe('');
	expect(result.stderr).toBe('CLI initialization failed.\n');
});

test('rejects malformed configuration without exposing its contents', async () => {
	const invalid = join(directory, 'invalid.yml');
	await writeFile(invalid, 'secret-password: private\n');
	expect(await run(['ping'], invalid)).toEqual({ stdout: '', stderr: 'CLI initialization failed.\n', code: 1 });
});
