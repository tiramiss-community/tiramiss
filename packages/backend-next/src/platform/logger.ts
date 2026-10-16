/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DiagnosticError } from './diagnostic-error.js';

export interface Logger {
	info(event: string, fields?: Record<string, unknown>): void;
	error(event: string, fields?: Record<string, unknown>): void;
}

function sanitize(value: unknown): unknown {
	if (value instanceof DiagnosticError) return { name: value.name, code: value.code, details: sanitize(value.details) };
	if (value instanceof Error) return { name: value.name, code: 'code' in value ? value.code : undefined };
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === 'object') return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/pass|token|secret|authorization|config/i.test(key) ? '[REDACTED]' : sanitize(item),
			]),
		);
	return value;
}

export function createLogger(
	role: string,
	sink: (line: string) => void = (line) => {
		process.stdout.write(`${line}\n`);
	},
): Logger {
	const emit = (level: string, event: string, fields: Record<string, unknown> = {}) => {
		sink(
			JSON.stringify({
				...(sanitize(fields) as object),
				timestamp: new Date().toISOString(),
				level,
				event,
				process: role,
				pid: process.pid,
			}),
		);
	};
	return {
		info: (event, fields) => {
			emit('info', event, fields);
		},
		error: (event, fields) => {
			emit('error', event, fields);
		},
	};
}
