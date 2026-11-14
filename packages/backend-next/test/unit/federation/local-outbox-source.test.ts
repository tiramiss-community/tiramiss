/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import rawCorpus from '../../../../../docs/superpowers/compatibility/remote-user/local-outbox-activity-corpus.json' with { type: 'json' };
import rawObservations from '../../../../../docs/superpowers/compatibility/remote-user/local-outbox-activity-observations.json' with { type: 'json' };
import { createActivityPubOutboxApi } from '../../../src/http/activitypub-outbox-api.js';
import { readOutboxNotes, renderOutboxCollection } from '../../../src/modules/federation/public.js';
import { preparePublishedActivity } from '../../../src/composition/published-activity.js';
import { createIdCodec } from '../../../src/platform/id-codec.js';
import type { NotePublicationRow, NotePublicationReader, OutboxReader } from '../../../src/modules/federation/public.js';

interface FixtureUser {
	id: string; username: string; host: string | null; uri: string | null;
	isSuspended: boolean; notesCount?: number;
}
type Stored = NotePublicationRow & {
	channelId: string | null; visibleUserIds: string[];
	replyUserId: string | null; replyUserHost: string | null; renoteUserId: string | null;
};
interface FixtureFile {
	id: string; type: string; url: string; webpublicUrl: string | null;
	comment: string | null; properties: { width?: number; height?: number }; isSensitive: boolean;
}
interface FixtureEmoji {
	name: string; localOnly: boolean; type?: string | null; publicUrl?: string;
	originalUrl?: string; license?: string | null; updatedAt?: string | null;
}
interface Case {
	id: string; route: 'outbox' | 'activity'; note?: Partial<Stored>; notes?: Partial<Stored>[];
	relatedNotes?: Partial<Stored>[]; files?: FixtureFile[]; emojis?: FixtureEmoji[];
	dataset?: string; user?: Pick<FixtureUser, 'isSuspended'>; missing?: boolean; federation?: 'all' | 'none';
	accept?: string | null; method?: string; path?: string; query?: string; fanout?: boolean;
	visitor?: 'all' | 'local' | 'none'; redis?: 'null' | 'reject' | 'command-error'; fail?: 'root' | 'user' | 'db';
	lists?: string[][]; poll?: { choices: string[]; votes: number[]; multiple: boolean };
}
interface Corpus {
	source: string;
	defaults: { selfUrl: string; now: string; note: Stored; users: FixtureUser[] };
	datasets: Record<string, Partial<Stored>[]>;
	cases: Case[];
}
interface Observations { source: string; cases: { id: string; expected: { status: number; headers: Record<string, string | null>; body: unknown; events: unknown[][] } }[] }
const corpus = rawCorpus as Corpus;
const observations = rawObservations as Observations;
const expected = new Map(observations.cases.map(row => [row.id, row.expected]));
const { createdAtFromId } = createIdCodec('aidx');
const options = { selfUrl: corpus.defaults.selfUrl, now: Date.parse(corpus.defaults.now), createdAtFromId };

test('static independent fixture coverage is complete and pinned to authoritative source', () => {
	expect(corpus.source).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	expect(observations.source).toBe(corpus.source);
	expect(observations.cases.map(c => c.id)).toEqual(corpus.cases.map(c => c.id));
	expect(new Set(corpus.cases.map(c => c.id)).size).toBe(115);
});
test.for(corpus.cases)('$id compares fixed-source HTTP contract and semantic reads', async c => {
	const root = { ...corpus.defaults.note, ...c.note };
	// Repository doubles resolve declared identities; filtering/rendering remains in the product.
	const users = corpus.defaults.users.map(user => user.id === 'alice' ? { ...user, ...c.user } : user);
	const userById = new Map(users.map(user => [user.id, user]));
	const rows = c.dataset ? corpus.datasets[c.dataset] : [c.note ?? {}, ...(c.notes ?? [])];
	const notes: Stored[] = [...rows, ...(c.relatedNotes ?? [])].map(row => ({ ...corpus.defaults.note, ...row }));
	const noteById = new Map(notes.map(note => [note.id, note]));
	const reads = { user: 0, redis: 0, related: [] as string[], materials: [] as unknown[][], candidates: [] as string[][], fallback: [] as unknown[][] };
	const facts: NotePublicationReader = {
		async readNote(id) {
			reads.related.push(id); return noteById.get(id) ?? null;
		},
		async authorExists(id) {
			reads.materials.push(['author', id]); return userById.has(id);
		},
		async readMentionedUsers(ids) {
			reads.materials.push(['mentions']);
			return ids.flatMap(id => userById.has(id) ? [userById.get(id)!] : []);
		},
		async readFiles(ids) {
			reads.materials.push(['files']);
			return ids.flatMap(id => (c.files ?? []).filter(file => file.id === id)).map(file => ({
				type: file.type, webpublicType: null, comment: file.comment,
				width: file.properties.width, height: file.properties.height, isSensitive: file.isSensitive,
				publicFile: { uri: null, userHost: null, isLink: false, webpublicAccessKey: null, webpublicUrl: file.webpublicUrl, url: file.url },
				proxyRemoteFiles: false, urlOptions: { url: options.selfUrl, externalMediaProxyEnabled: false },
			}));
		},
		async readPoll() {
			reads.materials.push(['poll']); return c.poll ? { ...c.poll, expiresAtMs: null } : null;
		},
		async readEmojis(names) {
			reads.materials.push(['emoji']);
			return names.flatMap(name => (c.emojis ?? []).filter(emoji => emoji.name === name).map(emoji => ({
				name: emoji.name, localOnly: emoji.localOnly, type: emoji.type ?? null,
				publicUrl: emoji.publicUrl ?? '', originalUrl: emoji.originalUrl ?? '', license: emoji.license ?? null,
				updatedAtMs: emoji.updatedAt ? Date.parse(emoji.updatedAt) : null,
			})));
		},
	};
	const reader: OutboxReader = {
		async readLocalUser(id) {
			reads.user++;
			if (c.fail === 'user') {
				throw new Error('injected lookup failure');
			}
			const user = users.find(user => user.id === id && user.host === null);
			return c.missing || !user ? null : { id: user.id, notesCount: user.notesCount! };
		},
		async readTimelineIds() {
			reads.redis++;
			if (c.redis === 'reject' || c.redis === 'command-error') {
				throw new Error('injected Redis failure');
			}
			return c.redis === 'null' ? [] : c.lists ?? [[], []];
		},
		async readCandidates(ids) {
			reads.candidates.push(ids);
			return notes.filter(note => ids.includes(note.id) && userById.has(note.userId)).map(note => {
				const reply = note.replyId ? noteById.get(note.replyId) : undefined;
				const renote = note.renoteId ? noteById.get(note.renoteId) : undefined;
				return {
					note, authorSuspended: userById.get(note.userId)!.isSuspended,
					replyUserId: reply?.userId ?? null, replyUserHost: reply?.userHost ?? null,
					renoteUserId: renote?.userId ?? null,
					replyAuthorSuspended: reply ? userById.get(reply.userId)?.isSuspended ?? false : false,
					renoteAuthorSuspended: renote ? userById.get(renote.userId)?.isSuspended ?? false : false,
				};
			});
		},
		async readDbPage(userId, bounds, limit) {
			if (c.fanout) {
				reads.fallback.push([bounds.untilId, bounds.sinceId, limit]);
			}
			if (c.fail === 'db') {
				throw new Error('injected DB failure');
			}
			const ascending = Boolean(bounds.sinceId && !bounds.untilId);
			return notes.filter(note => note.userId === userId && !note.localOnly && ['public', 'home'].includes(note.visibility) && (!bounds.untilId || note.id < bounds.untilId) && (!bounds.sinceId || note.id > bounds.sinceId))
				.sort((a, b) => ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)).slice(0, limit);
		},
	};
	const app = createActivityPubOutboxApi({
		logger: { error: () => { } }, federationEnabled: async () => c.federation !== 'none',
		async readLocalActivityNote(id) {
			if (c.fail === 'root') {
				throw new Error('injected lookup failure');
			}
			return c.missing ? null : notes.find(row => row.id === id && row.userHost === null && !row.localOnly && ['public', 'home'].includes(row.visibility)) ?? null;
		},
		renderActivity: row => preparePublishedActivity(row, facts, options),
		async readOutbox(id, page, bounds) {
			const user = await reader.readLocalUser(id);
			if (user === null) {
				return null;
			}
			if (!page) {
				return renderOutboxCollection(id, user.notesCount, null, options.selfUrl);
			}
			const selected = await readOutboxNotes(id, bounds, c.fanout ?? false, { blockedHosts: ['blocked.test'], ugcVisibilityForVisitor: c.visitor ?? 'all' }, reader);
			if (bounds.sinceId) {
				selected.reverse();
			}
			return renderOutboxCollection(id, user.notesCount, { bounds, notes: selected, activities: await Promise.all(selected.map(row => preparePublishedActivity(row, facts, options))) }, options.selfUrl);
		},
	});
	const path = c.path ?? `${c.route === 'activity' ? `/notes/${root.id}/activity` : '/users/alice/outbox'}${c.query ?? ''}`;
	const response = await app.request(path, { method: c.method ?? 'GET', headers: c.accept === null ? {} : { Accept: c.accept ?? 'application/activity+json' } });
	const source = expected.get(c.id)!;
	expect(response.status).toBe(source.status);
	for (const [name, value] of Object.entries(source.headers)) {
		expect(response.headers.get(name), name).toBe(value);
	}
	const text = await response.text();
	let body: unknown = text;
	if (text && response.headers.get('content-type')?.includes('json')) {
		body = JSON.parse(text);
		if (response.status >= 400) {
			const error = body as { statusCode: number; error: string };
			body = { statusCode: error.statusCode, error: error.error };
		}
	}
	if (c.id === 'fanout-command-error-no-fallback') {
		// The literal probe throws a VM-realm TypeError. Fastify serializes that foreign Error as {},
		// unlike same-realm production errors. Keep this diagnostic limitation explicit; status,
		// headers, read trace and absence of DB fallback below are still compared without exclusions.
		expect(source.body).toEqual({});
		expect(body).toEqual({ statusCode: 500, error: 'Internal Server Error' });
	} else {
		expect(body).toEqual(source.body);
	}
	expect(reads.related).toEqual(source.events.filter(e => e[0] === 'target' || e[0] === 'related-note').map(e => (e[1] as { id: string }).id));
	expect(reads.materials).toEqual(source.events.filter(e => ['author', 'mentions', 'files', 'poll', 'emoji'].includes(e[0] as string)).map(e => e[0] === 'author' ? ['author', (e[1] as { id: string }).id] : [e[0]]));
	expect(reads.redis).toBe(source.events.filter(e => e[0] === 'redis').length);
	expect(reads.fallback).toEqual(source.events.filter(e => e[0] === 'fallback').map(e => e.slice(1)));
	expect(reads.candidates).toEqual(source.events.filter(e => e[0] === 'hydrate').map(e => ((e[1] as { clauses: [string, { noteIds: string[] }][] }).clauses[0][1].noteIds)));
	// Failure injection precedes the source's user trace; successful lookup traces still pin index/read gating.
	if (c.fail !== 'user') {
		expect(reads.user).toBe(source.events.filter(e => e[0] === 'user').length);
	}
});
