/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createLogger } from '../../src/platform/logger.js';
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
