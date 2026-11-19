/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { createAccessRequest } from '../../../src/modules/access/public.js';
import { createAvatarDecorationAdmin } from '../../../src/modules/avatar-decoration/admin.js';

function fixture() {
	const row = { id: 'decoration', updatedAt: null, name: 'star', description: '', url: 'url', category: null, roleIdsThatCanBeUsedThisDecoration: [] };
	const ports = {
		readActor: vi.fn(async () => ({ isSuspended: false, isModerator: false, isAdministrator: false, canManageAvatarDecorations: true })),
		getAll: vi.fn(async () => [row]), insert: vi.fn(async () => row),
		find: vi.fn(async () => row), update: vi.fn(async () => ({ ...row, name: 'changed' })), delete: vi.fn(async () => {}),
		publish: vi.fn(), audit: vi.fn(), newId: () => 'decoration', createdAtFromId: () => 1000,
	};
	const access = () => createAccessRequest({ requireCredential: true, kind: 'write:admin:avatar-decorations' }, { userId: 'actor', native: true });
	return { ports, app: createAvatarDecorationAdmin(ports), access };
}

test('create retains duplicate restrictions and arbitrary nonempty URL and publishes the saved row', async () => {
	const { ports, app, access } = fixture();
	const params = { name: 'star', description: '', url: 'url', roleIdsThatCanBeUsedThisDecoration: ['private', 'private', 'missing'] };
	await expect(app.create(access(), params, 1000)).resolves.toMatchObject({ createdAt: '1970-01-01T00:00:01.000Z', updatedAt: null });
	expect(ports.insert).toHaveBeenCalledWith({ id: 'decoration', ...params });
	expect(ports.publish).toHaveBeenCalledWith('avatarDecorationCreated', await ports.insert.mock.results[0].value);
	expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor', type: 'createAvatarDecoration' }));
});

test('partial update preserves absent properties and records complete before/after snapshots', async () => {
	const { ports, app, access } = fixture();
	await app.update(access(), { id: 'decoration', name: 'changed', category: null }, 1234);
	expect(ports.update).toHaveBeenCalledWith('decoration', { name: 'changed', category: null, updatedAt: new Date(1234) });
	expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateAvatarDecoration', info: { avatarDecorationId: 'decoration', before: await ports.find.mock.results[0].value, after: await ports.update.mock.results[0].value } }));
});

test('list validates paging fields but deliberately returns every supplied row in reader order', async () => {
	const { ports, app, access } = fixture();
	await expect(app.list(access(), { limit: 1, untilId: 'a', userId: null }, 1)).resolves.toHaveLength(1);
	expect(ports.getAll).toHaveBeenCalledWith(true);
	await expect(app.list(access(), { limit: 101 }, 1)).rejects.toMatchObject({ message: 'Invalid param.' });
});

test('policy denial precedes app scope and input; suspension precedes policy', async () => {
	const { ports, app } = fixture();
	ports.readActor.mockResolvedValue({ isSuspended: false, isModerator: true, isAdministrator: false, canManageAvatarDecorations: false });
	const access = () => createAccessRequest({ requireCredential: true, kind: 'write:admin:avatar-decorations' }, { userId: 'actor', native: false, permissions: new Set() });
	await expect(app.create(access(), {}, 1)).rejects.toMatchObject({ name: 'AvatarDecorationPolicyDenied' });
	ports.readActor.mockResolvedValue({ isSuspended: true, isModerator: true, isAdministrator: false, canManageAvatarDecorations: false });
	await expect(app.create(access(), {}, 1)).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	expect(ports.insert).not.toHaveBeenCalled();
});

test('failed mutation does not publish or audit', async () => {
	const { ports, app, access } = fixture();
	ports.delete.mockRejectedValue(new Error('DB failure'));
	await expect(app.delete(access(), { id: 'decoration' }, 1)).rejects.toThrow('DB failure');
	expect(ports.publish).not.toHaveBeenCalled();
	expect(ports.audit).not.toHaveBeenCalled();
});
