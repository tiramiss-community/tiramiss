/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Own the whole Redis server: FLUSHDB must never target the suite's prefix-shared service. */
export function createDisposableRedis() {
	const name = `backend-next-reset-${randomUUID()}`;
	const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const close = () => {
		docker('rm', '--force', name);
	};
	try {
		docker('run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::6379', 'redis:8', 'redis-server', '--save', '', '--appendonly', 'no');
		const mapping = docker('port', name, '6379/tcp');
		const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
		if (!match) {
			throw new Error('Disposable Redis did not expose its own loopback port');
		}
		return { host: '127.0.0.1', port: Number(match[1]), close };
	} catch (error) {
		try {
			close();
		} catch { /* Startup may fail before the named container exists. */ }
		throw error;
	}
}
