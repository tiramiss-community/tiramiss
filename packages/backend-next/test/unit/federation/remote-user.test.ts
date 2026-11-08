/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createCreateNote } from '../../../src/modules/note/create-note.js';
import { normalizeAccount, classifyRemoteUser, webfingerUrl, selectWebfingerSelf } from '../../../src/modules/federation/public.js';
import { remoteSource, sourceNow, encode } from '../../helpers/remote-source.js';
import type { RemoteUserFacts, RemoteUserPorts, RemoteActorPlan } from '../../../src/modules/federation/public.js';
import type { NewNote, NoteWrites } from '../../../src/modules/note/public.js';

const cases = remoteSource.cases.filter((c: { id: string; }) => c.id.startsWith('resolve-'));
for (const fixture of cases) {
	test(`${fixture.id} runs resolution through the actual posting caller and preserves ordered source operations`, async () => {
		const input = fixture.input;
		const host = input.host === undefined ? 'REMOTE.TEST' : input.host;
		const account = normalizeAccount({ username: 'ALICE', host }, 'local.test');
		const row: RemoteUserFacts | null = input.age === undefined ? null : { id: 'remote', username: 'Alice', host: 'remote.test', uri: 'https://remote.test/old', lastFetchedAtMs: input.age === null ? null : sourceNow - input.age, isDeleted: false };
		const events: { op: string; args?: unknown; }[] = [];
		const notes: NewNote[] = [];
		const write: NoteWrites = {
			insertNote: async n => {
				notes.push(n);
			}, insertPoll: async () => {
				throw Error('unexpected poll');
			}
		};
		const ports: RemoteUserPorts = {
			selfHost: 'local.test', localId: uri => uri.startsWith('https://local.test/users/') ? 'local' : null,
			readByAccount: async value => {
				events.push({ op: 'User.find', args: { usernameLower: value.username, host: value.host } });
				return value.host === null ? { id: 'local', username: 'alice', host: null, uri: null, lastFetchedAtMs: null, isDeleted: false } : row && { ...row };
			},
			readByUri: async uri => {
				events.push({ op: 'User.find', args: { uri } }); return row;
			},
			readLocal: async () => ({ id: 'local', username: 'alice', host: null, uri: null, lastFetchedAtMs: null, isDeleted: false }),
			markAttempt: async (id, now) => {
				events.push({ op: 'User.update', args: { query: id, patch: { lastFetchedAt: new Date(now) } } });
				if (input.writeFail === 'timestamp') {
					throw Error('repository write failed');
				}
				row!.lastFetchedAtMs = now;
			},
			repairUri: async (_id, uri) => {
				events.push({ op: 'User.update', args: { query: { usernameLower: account.username, host: account.host }, patch: { uri } } });
				if (input.writeFail === 'uri') {
					throw Error('repository write failed');
				}
				row!.uri = uri;
			},
			webfinger: async value => {
				events.push({ op: 'WebFinger', args: `${value.username}@${value.host}` });
				if (input.webfingerFail) {
					throw Error('offline');
				}
				const links = input.links ?? [{ rel: 'SeLf', type: 'text/html', href: input.href ?? 'https://remote.test/new' }, { rel: 'self', href: 'https://ignored.test/u' }];
				const link = links.find((l: { rel: string; }) => l.rel.toLowerCase() === 'self');
				if (!link) {
					throw Error('self link not found');
				}
				return link.href;
			},
			acquireActor: async uri => {
				events.push({ op: row ? 'Person.update' : 'Person.create', args: uri });
				if (input.refreshFail) {
					throw Error('refresh failed');
				}
				return { uri } as RemoteActorPlan;
			},
			refreshActor: async () => 'updated',
			insertActor: async (_scope, plan) => ({ id: 'created', username: 'alice', host: 'remote.test', uri: plan.uri }),
			actorTransactions: {
				run: work => work({
					insertUser: async () => {
						throw Error('unexpected insert');
					}, insertProfile: async () => {
						throw Error('unexpected insert');
					}, insertPublickey: async () => {
						throw Error('unexpected insert');
					}
				})
			},
		};
		const useCase = createCreateNote({
			remoteUsers: ports, writes: write, transactions: { run: work => work(write) },
			readAuthor: async () => ({ id: 'author', username: 'author', host: account.host, isSuspended: false, movedToUri: null, isBot: false, canPublicNote: true, mentionLimit: 20, rateLimitFactor: 0, sensitiveWords: [], prohibitedWords: [] }),
			readUserIds: async () => [], readOwnedFiles: async () => [], readMentionedRemoteUsers: async () => [], readNote: async () => null,
			readChannel: async () => null, isBlocking: async () => false, isFollowing: async () => false, limit: async () => {
				throw Error('unexpected rate');
			},
			afterSaved: () => { }, currentTime: () => sourceNow, newId: () => 'note', matchesWords: () => false,
		});
		const post = () => useCase.createNote({ userId: 'author', canWriteNote: true }, { text: `@ALICE${host === null ? '' : '@' + host}` }, sourceNow, async id => id);
		await post();
		if (input.followup) {
			await post();
		}
		expect(encode(events)).toEqual(fixture.expected.events);
		const expected = input.followup ? fixture.expected.result.next : fixture.expected.result;
		expect(notes.at(-1)?.mentions).toEqual(expected ? [expected.id] : []);
		if (fixture.expected.state) {
			expect(row?.uri).toBe(fixture.expected.state.uri);
			expect(row?.lastFetchedAtMs === null ? null : new Date(row!.lastFetchedAtMs!).toISOString()).toBe(fixture.expected.state.lastFetchedAt);
		}
	});
}
test('normalization and exact 24h boundary do not widen source freshness', () => {
	expect(normalizeAccount({ username: 'ALICE', host: '例え.test' }, 'local.test')).toEqual({ username: 'alice', host: 'xn--r8jz45g.test' });
	const row: RemoteUserFacts = { id: 'a', username: 'a', host: 'remote.test', uri: null, lastFetchedAtMs: sourceNow - 86400000, isDeleted: false };
	expect(classifyRemoteUser(row, sourceNow)).toBe('fresh');
	expect(classifyRemoteUser(row, sourceNow + 1)).toBe('stale');
});

for (const fixture of remoteSource.cases.filter((c: { id: string; }) => c.id.startsWith('webfinger-'))) {
	test(`${fixture.id} compares the actual WebFinger URL against source HTTP arguments`, () => {
		if (fixture.expected.error) {
			expect(() => webfingerUrl(fixture.input.query, false)).toThrow(fixture.expected.error.message);
		} else {
			expect(webfingerUrl(fixture.input.query, false)).toBe(fixture.expected.events[0].args[0]);
		}
	});
}
test('WebFinger first case-insensitive self link has no MIME filter; explicit HTTP switch preserves source semantics', () => {
	expect(selectWebfingerSelf({ links: [{ rel: 'SeLf', href: 'https://other.test/u' }, { rel: 'self', href: 'https://ignored.test/u' }] })).toBe('https://other.test/u');
	expect(webfingerUrl('a@remote.test', true)).toMatch(/^http:\/\//);
});
