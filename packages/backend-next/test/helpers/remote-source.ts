/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
export const remoteSource = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/remote-user/observations.json', import.meta.url), 'utf8')) as {
	cases: {
		id: string;
		area: string;
		input: ReturnType<typeof JSON.parse>;
		expected: ReturnType<typeof JSON.parse>;
	}[];
};
export function encode(value: unknown): unknown {
	if (value === undefined) {
		return { $undefined: true };
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		return value.map(encode);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
	}
	return value;
}
export function decode(value: unknown): unknown {
	if (value && typeof value === 'object' && '$undefined' in value) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value.map(decode);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
	}
	return value;
}
export const sourceNow = Date.parse('2027-01-15T08:00:00.000Z');
