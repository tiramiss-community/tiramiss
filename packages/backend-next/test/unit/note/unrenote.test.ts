/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import type { DeletedNoteSnapshot } from '../../../src/modules/note/public.js';
import { createUnrenote } from '../../../src/modules/note/unrenote.js';

function setup() {
	const ports = {
		readActor: vi.fn(async () => ({ isSuspended: false, rateLimitFactor: 1 })),
		limit: vi.fn(async () => {}),
		readTarget: vi.fn(async () => true),
		readOwnRenotes: vi.fn(async () => [{ id: 'pure' }, { id: 'quote' }] as DeletedNoteSnapshot[]),
		startRemoval: vi.fn(),
	};
	return { ports, operation: createUnrenote(ports).unrenote };
}

const actor = { userId: 'alice', canWriteNote: true };

test('starts every own Renote and quote without awaiting deletion', async () => {
	const { ports, operation } = setup();
	ports.startRemoval.mockImplementation(() => new Promise(() => {}));
	await operation(actor, { noteId: 'target' }, 42);
	expect(ports.readOwnRenotes).toHaveBeenCalledWith('alice', 'target');
	expect(ports.startRemoval.mock.calls).toEqual([[{ id: 'pure' }, 'alice', 42], [{ id: 'quote' }, 'alice', 42]]);
});
test('existing target with no own Renotes succeeds, including repeat', async () => {
	const { ports, operation } = setup();
	ports.readOwnRenotes.mockResolvedValue([]);
	await operation(actor, { noteId: 'target' }, 42);
	await operation(actor, { noteId: 'target' }, 43);
	expect(ports.startRemoval).not.toHaveBeenCalled();
});
test('missing target is reported before selecting Renotes', async () => {
	const { ports, operation } = setup();
	ports.readTarget.mockResolvedValue(false);
	await expect(operation(actor, { noteId: 'missing' }, 42)).rejects.toMatchObject({ code: 'NO_SUCH_NOTE' });
	expect(ports.readOwnRenotes).not.toHaveBeenCalled();
});
test('credential, scope, suspension and validation precede target access', async () => {
	const { ports, operation } = setup();
	await expect(operation(null, {}, 42)).rejects.toMatchObject({ code: 'CREDENTIAL_REQUIRED' });
	ports.readActor.mockResolvedValueOnce(null as never);
	await expect(operation(actor, {}, 42)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
	await expect(operation({ ...actor, canWriteNote: false }, {}, 42)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
	ports.readActor.mockResolvedValueOnce({ isSuspended: true, rateLimitFactor: 1 });
	await expect(operation(actor, {}, 42)).rejects.toMatchObject({ code: 'YOUR_ACCOUNT_SUSPENDED' });
	await expect(operation(actor, { noteId: '' }, 42)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
	expect(ports.readTarget).not.toHaveBeenCalled();
});
