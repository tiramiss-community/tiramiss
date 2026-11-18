/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createLogger } from '../../src/platform/logger.js';
import { DiagnosticError } from '../../src/platform/diagnostic-error.js';
test('writes structured events without credentials or raw error messages', () => {
	const output: string[] = [];
	const logger = createLogger('http', (line) => output.push(line));
	logger.error('startup.failed', {
		password: 'hidden',
		nested: { token: 'hidden' },
		error: new Error('postgres://user:hidden@host/db'),
	});
	expect(output[0]).not.toContain('hidden');
	expect(JSON.parse(output[0])).toMatchObject({
		level: 'error',
		event: 'startup.failed',
		process: 'http',
		pid: process.pid,
	});
});

test('redacts private key material under any privateKey field', () => {
	const output: string[] = [];
	const logger = createLogger('worker', (line) => output.push(line));
	logger.error('signing.failed', {
		privateKey: 'hidden',
		keyPair: { privateKeyPem: 'hidden', publicKeyPem: 'shown' },
		error: new DiagnosticError('SIGNING_FAILED', { PRIVATEKEY: 'hidden' }),
	});
	expect(output[0]).not.toContain('hidden');
	expect(JSON.parse(output[0])).toMatchObject({
		privateKey: '[REDACTED]',
		keyPair: { privateKeyPem: '[REDACTED]', publicKeyPem: 'shown' },
		error: { code: 'SIGNING_FAILED', details: { PRIVATEKEY: '[REDACTED]' } },
	});
});

afterEach(() => vi.unstubAllEnvs());

const defaults = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/worker-logging/observations.json', import.meta.url), 'utf8')) as { defaultLevels: { env: string | null; threshold: string }[] };

test.each(defaults.defaultLevels)('default debug threshold follows pinned NODE_ENV=$env without suppressing higher levels', ({ env, threshold }) => {
	vi.stubEnv('NODE_ENV', env ?? undefined);
	const lines: Record<string, unknown>[] = [];
	const logger = createLogger('worker', line => lines.push(JSON.parse(line)));
	logger.debug('job.active');
	logger.info('ready');
	logger.warn('job.stalled');
	logger.error('job.failed');
	expect(lines.map(line => line.level)).toEqual(threshold === 'info' ? ['info', 'warn', 'error'] : ['debug', 'info', 'warn', 'error']);
});
