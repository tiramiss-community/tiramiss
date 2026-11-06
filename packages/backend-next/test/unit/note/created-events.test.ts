/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNoteCreatedEvents } from '../../../src/modules/note/created-events.js';
import type { PostNotification } from '../../../src/modules/notification/public.js';

function setup(options: { failMention?: boolean; failPublish?: boolean; failSave?: boolean; reply?: boolean; threadModes?: boolean[]; failThread?: boolean; subscribers?: string[]; slowSave?: Promise<void> } = {}) {
	const saved: PostNotification[] = [];
	const events: string[] = [];
	const run = createNoteCreatedEvents({
		read: async () => ({
			id: 'n', userId: 'a', visibility: 'public', visibleUserIds: [], mentions: ['b'], reply: options.reply ? { id: 'parent', userId: 'b' } : null, renote: null, pureRenote: false,
			localUserIds: new Set(['a', 'b']), threadMutedUserIds: new Set<string>(), subscribers: (options.subscribers ?? ['b']).map(userId => ({ userId, renoteMuted: false }))
		}),
		isThreadMuted: async () => {
			if (options.failThread) {
				throw new Error('thread read');
			} return options.threadModes?.shift() ?? false;
		},
		render: async (_id, viewer) => {
			events.push(`render:${viewer}`);
			if (viewer === 'b' && options.failMention) {
				throw new Error('mention pack');
			}
			return { id: 'n', viewer };
		},
		stream: {
			notes: async () => {
				events.push('notes'); if (options.failPublish) {
					throw new Error('publish');
				}
			},
			main: async (_id, type) => {
				events.push(type);
			},
		},
		readReception: async (recipientId, notifierId) => ({ recipientId, notifierId, mode: null, muted: false, followsNotifier: false, followedByNotifier: false, listContainsNotifier: false }),
		notifications: {
			run: work => work({
				save: async notification => {
					if (options.slowSave && notification.recipientId === 'c') {
						await options.slowSave;
					}
					if (options.failSave && notification.recipientId === 'b') {
						throw new Error('save');
					}
					saved.push(notification);
				}
			})
		},
		afterNotificationSaved: async n => {
			events.push(`saved:${n.type}`);
		},
		deliver: async () => {
			events.push('AP');
		},
		newId: () => `notification${saved.length}`, currentTime: () => 1000,
	});
	return { run, events, saved };
}

test('notification bodies persist independently and events precede AP preparation', async () => {
	const world = setup(); await world.run('n');
	expect(world.saved.map(n => n.type)).toEqual(['note', 'mention']);
	expect(world.events.indexOf('notes')).toBeLessThan(world.events.indexOf('mention'));
	expect(world.events.indexOf('mention')).toBeLessThan(world.events.indexOf('AP'));
	expect(world.saved).toContainEqual(expect.objectContaining({ recipientId: 'b', notifierId: 'a', createdAtMs: 1000 }));
});
test('mention packing failure stops manager and AP but not subscription notification', async () => {
	const world = setup({ failMention: true }); await expect(world.run('n')).rejects.toThrow();
	expect(world.saved.map(n => n.type)).toEqual(['note']);
	expect(world.events).not.toContain('AP');
});
test('publish failure keeps saved notification and does not prevent AP', async () => {
	const world = setup({ failPublish: true }); await expect(world.run('n')).rejects.toThrow();
	expect(world.saved.map(n => n.type)).toEqual(['note', 'mention']);
	expect(world.events).toContain('AP');
});
test('notification saving failure does not prevent AP', async () => {
	const world = setup({ failSave: true }); await expect(world.run('n')).rejects.toThrow();
	expect(world.saved).toEqual([]); expect(world.events).toContain('AP');
});

test.each([
	[[false, true], 'mention'], [[true, false], 'reply'],
] as const)('each candidate uses its own current thread decision %j', async (modes, type) => {
	const world = setup({ reply: true, threadModes: [...modes] });
	await world.run('n');
	expect(world.saved.map(n => n.type)).toEqual([type]);
});
test('thread read failure leaves started subscription but aborts manager and AP', async () => {
	const world = setup({ failThread: true });
	await expect(world.run('n')).rejects.toThrow();
	expect(world.saved.map(n => n.type)).toEqual(['note']);
	expect(world.events).not.toContain('AP');
});
test('failed subscriber does not end drain while another subscriber is saving', async () => {
	let release!: () => void;
	const slow = new Promise<void>(resolve => {
		release = resolve;
	});
	const world = setup({ failSave: true, subscribers: ['b', 'c'], slowSave: slow });
	let ended = false;
	const running = world.run('n').catch(() => { }).then(() => {
		ended = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(ended).toBe(false);
	release(); await running;
	expect(world.saved.map(n => n.recipientId)).toEqual(['c']);
});
