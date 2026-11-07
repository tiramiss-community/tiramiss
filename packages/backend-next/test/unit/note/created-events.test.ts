/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createNoteCreatedEvents } from '../../../src/modules/note/created-events.js';
import type { PostNotification } from '../../../src/modules/notification/public.js';

function setup(options: { channelAggregates?(): Promise<void>; failRole?: boolean; slowRole?: Promise<void>; failPack?: boolean; failWebhook?: boolean; failAP?: boolean; failMention?: boolean; failPublish?: boolean; failSave?: boolean; reply?: boolean; replyUser?: string; renoteUser?: string; threadModes?: boolean[]; failThread?: boolean; subscribers?: string[]; slowSave?: Promise<void>; mentions?: string[]; beforeReception?(recipientId: string): Promise<void> } = {}) {
	const saved: PostNotification[] = [];
	const notes: Record<string, unknown>[] = [];
	const roles: Record<string, unknown>[] = [];
	const events: string[] = [];
	const run = createNoteCreatedEvents({
		read: async () => ({
			id: 'n', userId: 'a', visibility: 'public', visibleUserIds: [], mentions: options.mentions ?? ['b'], reply: options.reply ? { id: 'parent', userId: options.replyUser ?? 'b' } : null, renote: options.renoteUser ? { id: 'original', userId: options.renoteUser } : null, pureRenote: false,
			localUserIds: new Set(['a', 'b']), threadMutedUserIds: new Set<string>(), subscribers: (options.subscribers ?? ['b']).map(userId => ({ userId, renoteMuted: false })),
		}),
		isThreadMuted: async () => {
			if (options.failThread) {
				throw new Error('thread read');
			} return options.threadModes?.shift() ?? false;
		},
		render: async (_id, viewer) => {
			events.push(`render:${viewer}`);
			if (viewer === null && options.failPack) {
				throw new Error('global pack');
			}
			if (viewer === 'b' && options.failMention) {
				throw new Error('mention pack');
			}
			return { id: 'n', viewer };
		},
		roleTimelines: async (noteId, userId, packed) => {
			roles.push(packed);
			events.push(`role:${noteId}:${userId}:${packed.viewer}`);
			await options.slowRole;
			if (options.failRole) {
				throw new Error('role');
			}
		},
		webhook: async (userId: string, type: string, note: Record<string, unknown>) => {
			events.push(`hook:${userId}:${type}:${note.viewer}`);
			if (options.failWebhook) {
				throw new Error('webhook');
			}
		},
		stream: {
			notes: async packed => {
				notes.push(packed);
				events.push('notes'); if (options.failPublish) {
					throw new Error('publish');
				}
			},
			main: async (_id, type) => {
				events.push(type);
			},
		},
		readReception: async (recipientId, notifierId) => {
			await options.beforeReception?.(recipientId);
			return { recipientId, notifierId, mode: null, muted: false, followsNotifier: false, followedByNotifier: false, listContainsNotifier: false };
		},
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
				},
			}),
		},
		afterNotificationSaved: async n => {
			events.push(`saved:${n.type}`);
		},
		deliver: async () => {
			events.push('AP');
			if (options.failAP) {
				throw new Error('AP');
			}
		},
		channelAggregates: options.channelAggregates,
		index: async () => {
			events.push('index');
		},
		newId: () => `notification${saved.length}`, currentTime: () => 1000,
	});
	return { run, events, saved, notes, roles };
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

test('at most eight subscriptions run concurrently, all recipients are attempted and failures still drain', async () => {
	let releaseReception!: () => void;
	let releaseSave!: () => void;
	const receptionGate = new Promise<void>(resolve => {
		releaseReception = resolve;
	});
	const saveGate = new Promise<void>(resolve => {
		releaseSave = resolve;
	});
	const attempted: string[] = [];
	let active = 0;
	let maximumActive = 0;
	const subscribers = ['b', 'c', ...Array.from({ length: 18 }, (_, i) => `subscriber${i}`)];
	const world = setup({
		subscribers, mentions: [], failSave: true, slowSave: saveGate,
		beforeReception: async recipientId => {
			attempted.push(recipientId);
			active++;
			maximumActive = Math.max(maximumActive, active);
			await receptionGate;
			active--;
		},
	});
	let ended = false;
	let failure: unknown;
	const running = world.run('n').catch(error => {
		failure = error;
	}).finally(() => {
		ended = true;
	});
	try {
		await new Promise(resolve => setImmediate(resolve));
		expect(active).toBe(8);
		expect(world.events).toContain('AP');
		releaseReception();
		await new Promise(resolve => setImmediate(resolve));
		expect(new Set(attempted)).toEqual(new Set(subscribers));
		expect(ended).toBe(false);
	} finally {
		releaseReception();
		releaseSave();
		await running;
	}
	expect(maximumActive).toBe(8);
	expect(failure).toBeInstanceOf(AggregateError);
	expect(new Set(world.saved.map(n => n.recipientId))).toEqual(new Set(subscribers.filter(id => id !== 'b')));
});

test('posting events enqueue the author and each eligible recipient with their packed view', async () => {
	const world = setup({ reply: true });
	await world.run('n');
	expect(world.events.filter(event => event.startsWith('hook:'))).toEqual(['hook:a:note:null', 'hook:b:mention:b', 'hook:b:reply:null']);
});

test('self mention and reply are not suppressed by notification self rules', async () => {
	const world = setup({ mentions: ['a'], reply: true, replyUser: 'a' });
	await world.run('n');
	expect(world.events.filter(event => event.startsWith('hook:'))).toEqual(['hook:a:note:null', 'hook:a:mention:a', 'hook:a:reply:null']);
});

test('muted mention and reply are omitted independently', async () => {
	const world = setup({ reply: true, threadModes: [true, true] });
	await world.run('n');
	expect(world.events.filter(event => event.startsWith('hook:'))).toEqual(['hook:a:note:null']);
});

test.each([['a', false], ['b', true], ['remote', false]] as const)('renote delivery to %s follows local and self checks', async (owner, expected) => {
	const world = setup({ mentions: [], renoteUser: owner });
	await world.run('n');
	expect(world.events.includes(`hook:${owner}:renote:null`)).toBe(expected);
});

test('search starts only after preparation succeeds and ignores detached publish failures', async () => {
	const failed = setup({ failMention: true });
	await expect(failed.run('n')).rejects.toThrow();
	expect(failed.events).not.toContain('index');
	const published = setup({ failPublish: true });
	await expect(published.run('n')).rejects.toThrow();
	expect(published.events).toContain('index');
	expect(published.events.indexOf('AP')).toBeLessThan(published.events.indexOf('index'));
});

test.each([{ failPack: true }, { failMention: true }, { failThread: true }])('awaited preparation failure suppresses search: %j', async options => {
	const world = setup(options);
	await expect(world.run('n')).rejects.toThrow();
	expect(world.events).not.toContain('index');
});
test.each([{ failPublish: true }, { failWebhook: true }, { failAP: true }])('detached failure preserves search: %j', async options => {
	const world = setup(options);
	await expect(world.run('n')).rejects.toThrow();
	expect(world.events).toContain('index');
});

test('role producer starts after successful global pack and notes stream, before webhooks', async () => {
	const world = setup();
	await world.run('n');
	expect(world.roles[0]).toBe(world.notes[0]);
	expect(world.events.slice(world.events.indexOf('render:null'), world.events.indexOf('render:b'))).toEqual(['render:null', 'notes', 'role:n:a:null', 'hook:a:note:null']);
});

test('failed global pack does not start role producer', async () => {
	const world = setup({ failPack: true });
	await expect(world.run('n')).rejects.toThrow();
	expect(world.events.some(event => event.startsWith('role:'))).toBe(false);
});

test('role failure preserves webhook, notifications, AP and search preparation', async () => {
	const world = setup({ failRole: true });
	await expect(world.run('n')).rejects.toThrow();
	expect(world.events).toEqual(expect.arrayContaining(['hook:a:note:null', 'AP', 'index']));
	expect(world.saved.map(n => n.type)).toEqual(['note', 'mention']);
});

test('created events wait for role work while independent AP and search already start', async () => {
	let release!: () => void;
	const world = setup({ slowRole: new Promise<void>(resolve => {
		release = resolve;
	}) });
	let done = false;
	const running = world.run('n').then(() => {
		done = true;
	});
	await new Promise(resolve => setImmediate(resolve));
	expect(world.events).toEqual(expect.arrayContaining(['AP', 'index']));
	expect(done).toBe(false);
	release();
	await running;
});

test.each(['pack', 'mention'] as const)('channel aggregates do not start after %s preparation failure', async (mode) => {
	const calls: string[] = [];
	const world = setup({
		failPack: mode === 'pack', failMention: mode === 'mention', channelAggregates: async () => {
			calls.push('channel');
		}
	});
	await expect(world.run('n')).rejects.toThrow();
	expect(calls).toEqual([]);
});
test('channel aggregates start after AP preparation and before indexing; their asynchronous failure does not gate indexing and is drained', async () => {
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	const world = setup({
		channelAggregates: async () => {
			world.events.push('channel');
			await held;
			throw new Error('channel count');
		}
	});
	let done = false;
	const run = world.run('n').catch(error => {
		done = true;
		return error;
	});
	await new Promise<void>(resolve => setImmediate(resolve));
	expect(world.events.indexOf('channel')).toBeGreaterThan(world.events.indexOf('AP'));
	expect(world.events.indexOf('index')).toBeGreaterThan(world.events.indexOf('channel'));
	expect(done).toBe(false);
	release();
	expect(await run).toBeInstanceOf(AggregateError);
});
