/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createAnnouncementPublisher } from '../../src/platform/announcement-publisher.js';
import { createLogger } from '../../src/platform/logger.js';
import { createAccessRequest } from '../../src/modules/access/public.js';
import { createAnnouncements, renderAnnouncement } from '../../src/modules/announcement/public.js';
import publishObservations from '../../../../docs/superpowers/compatibility/announcements/publish-observations.json' with { type: 'json' };
import corpus from '../../../../docs/superpowers/compatibility/announcements/corpus.json' with { type: 'json' };
import observations from '../../../../docs/superpowers/compatibility/announcements/observations.json' with { type: 'json' };
import type { AnnouncementPorts, AnnouncementRow } from '../../src/modules/announcement/public.js';

const actor = () => createAccessRequest({ requireCredential: true, kind: 'write:account' }, { userId: 'alice', native: true });
const viewer = () => createAccessRequest({}, { userId: 'alice', native: true });
const anonymous = () => createAccessRequest({}, null);
const row: AnnouncementRow = { id: 'announcement', updatedAt: null, title: 'Title', text: 'Text', imageUrl: null, icon: 'info', display: 'normal', userId: null, needConfirmationToRead: false, silence: false };

function fixture() {
	const reads = new Set<string>();
	const events: string[] = [];
	let active = true;
	const ports: AnnouncementPorts = {
		list: async () => [{ ...row }], find: async id => id === row.id ? { ...row } : null,
		readIds: async () => reads, readActor: async () => ({ isSuspended: false, isModerator: false, isAdministrator: false }),
		insertRead: async (_id, _viewer, id) => {
			if (reads.has(id)) {
				throw Error('unique violation');
			}
			reads.add(id);
		},
		deactivate: async () => {
			active = false;
		},
		hasUnread: async () => false,
		readAll: async id => {
			events.push(id);
		},
		newId: () => 'newread', createdAtFromId: () => 0, idFromDate: () => 'datebound', now: () => new Date(0),
	};
	return { ports, reads, events, active: () => active };
}

test('source evidence binds the exact corpus and probe with one result per input step', () => {
	const hash = (name: string) => createHash('sha256').update(readFileSync(new URL(`../../../../docs/superpowers/compatibility/announcements/${name}`, import.meta.url))).digest('hex');
	expect(observations.corpusSha256).toBe(hash('corpus.json'));
	expect(observations.sourceProbeSha256).toBe(hash('source-probe.mjs'));
	expect(observations.cases.map(item => item.id)).toEqual(corpus.cases.map(item => item.id));
	expect(new Set(corpus.cases.map(item => item.id)).size).toBe(corpus.cases.length);
	for (const item of corpus.cases) {
		expect(observations.cases.find(observation => observation.id === item.id)!.steps).toHaveLength(item.steps.length);
	}
});

test('pure presentation omits anonymous read state and preserves all public fields', () => {
	expect(renderAnnouncement(row, null, undefined, 0)).toEqual({
		id: row.id, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: null, title: 'Title', text: 'Text', imageUrl: null,
		icon: 'info', display: 'normal', forYou: false, needConfirmationToRead: false, silence: false,
	});
	expect(renderAnnouncement({ ...row, userId: 'alice' }, 'alice', true, 0)).toMatchObject({ forYou: true, isRead: true });
});

test('list excludes a failed pack without refilling the requested page', async () => {
	const f = fixture();
	f.ports.list = async () => [{ ...row }, { ...row, id: 'broken' }];
	f.ports.createdAtFromId = id => id === 'broken' ? NaN : 0;
	const result = await createAnnouncements(f.ports).list(anonymous(), { limit: 2 });
	expect(result.map(item => item.id)).toEqual([row.id]);
});

test('read material failure excludes list items and fails a single show', async () => {
	const f = fixture();
	f.ports.readIds = async () => {
		throw Error('read store unavailable');
	};
	const app = createAnnouncements(f.ports);
	expect(await app.list(viewer(), {})).toEqual([]);
	await expect(app.show(viewer(), { announcementId: row.id })).rejects.toThrow('read store unavailable');
	expect(await app.list(anonymous(), {})).toHaveLength(1);
});

test('missing and another recipient share the same not-found error', async () => {
	const f = fixture();
	const app = createAnnouncements(f.ports);
	await expect(app.show(viewer(), { announcementId: 'missing' })).rejects.toMatchObject({ code: 'NO_SUCH_ANNOUNCEMENT', id: 'b57b5e1d-4f49-404a-9edb-46b00268f121' });
	f.ports.find = async () => ({ ...row, userId: 'bob' });
	await expect(app.show(viewer(), { announcementId: row.id })).rejects.toMatchObject({ code: 'NO_SUCH_ANNOUNCEMENT' });
	await expect(app.show(anonymous(), { announcementId: row.id })).rejects.toMatchObject({ code: 'NO_SUCH_ANNOUNCEMENT' });
});

test('duplicate reads do not emit another event or deactivate a public announcement', async () => {
	const f = fixture();
	const app = createAnnouncements(f.ports);
	await app.read(actor(), { announcementId: row.id });
	await app.read(actor(), { announcementId: row.id });
	expect([...f.reads]).toEqual([row.id]);
	expect(f.events).toEqual(['alice']);
	expect(f.active()).toBe(true);
});

test('any insertion error finishes without later mutations or events', async () => {
	const f = fixture();
	f.ports.insertRead = async () => {
		throw Error('connection unavailable');
	};
	await createAnnouncements(f.ports).read(actor(), { announcementId: row.id });
	expect(f.reads.size).toBe(0);
	expect(f.events).toEqual([]);
	expect(f.active()).toBe(true);
});

test('failure after inserting a read preserves the row and duplicate retry remains a no-op', async () => {
	const f = fixture();
	f.ports.find = async () => {
		throw Error('announcement store unavailable');
	};
	const app = createAnnouncements(f.ports);
	await expect(app.read(actor(), { announcementId: row.id })).rejects.toThrow('announcement store unavailable');
	expect([...f.reads]).toEqual([row.id]);
	await app.read(actor(), { announcementId: row.id });
	expect(f.events).toEqual([]);
});

test('suspension precedes malformed read input and leaves no read state', async () => {
	const f = fixture();
	f.ports.readActor = async () => ({ isSuspended: true, isModerator: false, isAdministrator: false });
	await expect(createAnnouncements(f.ports).read(actor(), {})).rejects.toMatchObject({ reason: 'YOUR_ACCOUNT_SUSPENDED' });
	expect(f.reads.size).toBe(0);
});

test('publication starts without awaiting the send and idle tracks accepted sends', async () => {
	let release!: () => void;
	const sending = new Promise<void>(resolve => {
		release = resolve;
	});
	const publisher = createAnnouncementPublisher(() => sending, createLogger('announcement-publish-test', () => {}));
	expect(publisher.publish('alice')).toBeUndefined();
	let settled = false;
	const idle = publisher.idle().then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	release();
	await idle;
	expect(settled).toBe(true);
});

test('publication failures are diagnosed and do not reject the drain', async () => {
	const lines: string[] = [];
	const publisher = createAnnouncementPublisher(async () => {
		throw Error('pubsub unavailable');
	}, createLogger('announcement-publish-test', line => lines.push(line)));
	publisher.publish('alice');
	await expect(publisher.idle()).resolves.toBeUndefined();
	expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'announcement-publish.failed', userId: 'alice' }));
});

test('deferred publication rejection matches the literal source result after the read returns', async () => {
	const f = fixture();
	f.ports.find = async () => ({ ...row, userId: 'alice' });
	let rejectDelivery!: (error: Error) => void;
	let publishAttempts = 0;
	let deliveryRejected = false;
	const delivery = new Promise<void>((_resolve, reject) => {
		rejectDelivery = reject;
	});
	const publisher = createAnnouncementPublisher(() => {
		publishAttempts++;
		return delivery;
	}, { info: () => {}, error: () => {
		deliveryRejected = true;
	} });
	f.ports.readAll = publisher.publish;
	const app = createAnnouncements(f.ports);
	await app.read(actor(), { announcementId: row.id });
	const returnedBeforeDelivery = !deliveryRejected;
	rejectDelivery(Error('PUBLISH unavailable'));
	await publisher.idle();
	await app.read(actor(), { announcementId: row.id });
	expect({ returnedBeforeDelivery, deliveryRejected, readCount: f.reads.size, isActive: f.active(), publishAttempts, duplicateWasNoOp: f.reads.size === 1 && publishAttempts === 1 }).toEqual(publishObservations.outcome);
	for (const [file, expected] of [['publish-corpus.json', publishObservations.corpusSha256], ['publish-source-probe.mjs', publishObservations.sourceProbeSha256]]) {
		expect(createHash('sha256').update(readFileSync(new URL(`../../../../docs/superpowers/compatibility/announcements/${file}`, import.meta.url))).digest('hex')).toBe(expected);
	}
});
