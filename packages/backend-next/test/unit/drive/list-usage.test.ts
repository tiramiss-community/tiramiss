/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createDriveListUsage } from '../../../src/modules/drive/list-usage.js';
import type { DriveListPorts } from '../../../src/modules/drive/list-usage.js';
const facts = { isSuspended: false, isModerator: false, isAdministrator: false };
const ports = (): DriveListPorts => ({
	readActor: async () => facts,
	readCapacityMb: async () => 7,
	readUsage: async () => 0,
	listFiles: async () => [], listFolders: async () => [],
	preload: async () => ({ proxyRemoteFiles: false }),
	media: { url: 'https://test', createdAtFromId: () => 0 }, idFromDate: () => 'date',
});
const access = () => createAccessRequest({ requireCredential: true, kind: 'read:drive' }, { userId: 'owner', native: true });
test('usage reads owned bytes before current capacity and converts MB without rounding', async () => {
	const p = ports();
	let read = false;
	p.readUsage = async selection => {
		expect(selection).toEqual({ userId: 'owner' });
		read = true;
		return 13;
	};
	p.readCapacityMb = async (userId, now) => {
		expect(read).toBe(true);
		expect([userId, now]).toEqual(['owner', 123]);
		return 0.5;
	};
	expect(await createDriveListUsage(p).usage(access(), {}, 123)).toEqual({ usage: 13, capacity: 524288 });
});
test('usage query failure is propagated before capacity lookup', async () => {
	const p = ports();
	p.readUsage = async () => {
 throw Error('read unavailable'); 
};
	p.readCapacityMb = async () => {
 throw Error('must not calculate capacity after failure'); 
};
	await expect(createDriveListUsage(p).usage(access(), {}, 0)).rejects.toThrow('read unavailable');
});
test('suspension and scope rejection precede invalid input and storage reads', async () => {
	const p = ports();
	p.readActor = async () => ({ ...facts, isSuspended: true });
	p.listFiles = async () => {
 throw Error('must not query before authorization'); 
};
	await expect(createDriveListUsage(p).files(access(), { limit: 0 }, 0)).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	p.readActor = async () => facts;
	const denied = createAccessRequest({ requireCredential: true, kind: 'read:drive' }, { userId: 'owner', native: false, permissions: new Set() });
	await expect(createDriveListUsage(p).files(denied, { limit: 0 }, 0)).rejects.toMatchObject({ reason: 'PERMISSION_DENIED' });
});
test('list failure and packing failure propagate rather than returning partial results', async () => {
	const p = ports();
	p.listFiles = async () => {
 throw Error('query unavailable'); 
};
	await expect(createDriveListUsage(p).stream(access(), {}, 0)).rejects.toThrow('query unavailable');
	p.listFiles = async () => [];
	p.preload = async () => {
 throw Error('materials unavailable'); 
};
	await expect(createDriveListUsage(p).files(access(), {}, 0)).rejects.toThrow('materials unavailable');
});
