/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomBytes, randomInt } from 'node:crypto';
import { ulid } from 'ulid';

export const idMethods = ['aid', 'aidx', 'meid', 'meidg', 'ulid', 'objectid'] as const;
export type IdMethod = typeof idMethods[number];

const epoch = 946684800000;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function createIdCodec(method: IdMethod) {
	const nodeId = randomInt(36 ** 4).toString(36).padStart(4, '0');
	let counter = randomInt(36 ** 4);

	return {
		createdAtFromId(id: string): number {
			switch (method) {
				case 'aid':
				case 'aidx': return Number.parseInt(id.slice(0, 8), 36) + epoch;
				case 'meid': return Number.parseInt(id.slice(0, 12), 16) - 0x800000000000;
				case 'meidg': return Number.parseInt(id.slice(1, 12), 16);
				case 'objectid': return Number.parseInt(id.slice(0, 8), 16) * 1000;
				case 'ulid': return [...id.slice(0, 10)].reduce((time, char) => time * 32 + alphabet.indexOf(char), 0);
			}
		},
		newId(atMs: number): string {
			const time = !atMs || atMs > Date.now() ? Date.now() : atMs;
			counter++;
			switch (method) {
				case 'aid': return Math.max(0, time - epoch).toString(36).padStart(8, '0') + counter.toString(36).padStart(2, '0').slice(-2);
				case 'aidx': return Math.max(0, time - epoch).toString(36).padStart(8, '0').slice(-8) + nodeId + counter.toString(36).padStart(4, '0').slice(-4);
				case 'meid': return (Math.max(0, time) + 0x800000000000).toString(16).padStart(12, '0') + randomBytes(6).toString('hex');
				case 'meidg': return 'g' + Math.max(0, time).toString(16).padStart(11, '0') + randomBytes(6).toString('hex');
				case 'objectid': return Math.floor(Math.max(0, time) / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');
				case 'ulid': return ulid(time);
			}
		},
	};
}
