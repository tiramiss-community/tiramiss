/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dump } from 'js-yaml';
import type { RuntimeConfig } from '../../src/config/types.js';
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => {
		server.listen(0, '127.0.0.1', done);
	});
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((done, reject) => {
		server.close((error) => (error ? reject(error) : done()));
	});
	return port;
}
export async function configuration(config: RuntimeConfig) {
	const directory = await mkdtemp(join(tmpdir(), 'backend-process-'));
	const path = join(directory, 'config.yml');
	await writeFile(
		path,
		dump({
			url: config.url,
			port: config.http.port,
			socket: config.http.socket,
			db: {
				host: config.database.host,
				port: config.database.port,
				db: config.database.database,
				user: config.database.username,
				pass: config.database.password,
			},
			redis: config.redis,
			redisForPubsub: config.redisForPubsub,
			backendNext: config.processes,
		}),
	);
	return { path, directory, close: () => rm(directory, { recursive: true, force: true }) };
}
export function launch(entrypoint: string, configPath: string, extraEnv: NodeJS.ProcessEnv = {}) {
	const child = fork(resolve(entrypoint), [], {
		env: { ...process.env, MISSKEY_CONFIG_YML: configPath, ...extraEnv },
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	let output = '';
	child.stdout!.on('data', (chunk) => {
		output += chunk;
	});
	child.stderr!.on('data', (chunk) => {
		output += chunk;
	});
	const messages: unknown[] = [];
	child.on('message', (message) => {
		messages.push(message);
	});
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			done({ code, signal });
		});
	});
	const ready = new Promise<void>((done, reject) => {
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`Ready timeout: ${output}`));
		}, 15000);
		void exit
			.finally(() => {
				clearTimeout(timeout);
			})
			.catch(() => {});
		child.on('message', (message) => {
			if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
				clearTimeout(timeout);
				done();
			}
		});
		void exit.then(() => {
			reject(new Error(`Exited before ready: ${output}`));
		}, reject);
	});
	void ready.catch(() => {});
	return {
		child,
		ready,
		exit,
		messages,
		output: () => output,
		async close() {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
			await exit;
		},
	};
}
