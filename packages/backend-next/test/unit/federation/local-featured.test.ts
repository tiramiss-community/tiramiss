/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import { preparePublishedNote } from '../../../src/composition/published-note.js';
import { createActivityPubNotesApi } from '../../../src/http/activitypub-notes-api.js';
import { readFeaturedNotes, renderFeaturedCollection, renderApNote, renderNoteActivity } from '../../../src/modules/federation/public.js';
import { featuredCorpus, featuredSource, publicationFixture, publicationOptions, serialized } from '../../helpers/local-featured.js';
// Wrong recursion depth, URI truthiness, omitted/null fields or a read moved ahead of a failure changes source output/events.
test.each(featuredCorpus.cases.filter(c => c.route === 'render'))('$id matches literal-source serialization and lazy failure order', async (c) => {
	const fixture = publicationFixture(c);
	const expected = featuredSource.cases.find(row => row.id === c.id)!.expected;
	try {
		if (expected.error) {
			await expect((async () => {
				const prepared = await preparePublishedNote(fixture.note, fixture.reader, { ...publicationOptions, ...c.config }, c.dive ?? true);
				return renderApNote(prepared, publicationOptions, c.dive ?? true);
			})()).rejects.toMatchObject(expected.error);
		} else {
			const prepared = await preparePublishedNote(fixture.note, fixture.reader, { ...publicationOptions, ...c.config }, c.dive ?? true);
			expect(serialized(renderApNote(prepared, publicationOptions, c.dive ?? true))).toEqual(expected.json);
		}
		expect(fixture.events).toEqual(expected.events);
	} finally {
		fixture.restore();
	}
});
// Omitting either route, filtering before mandatory lookup, eager hydration, wrong content negotiation or headers breaks this comparison.
test.each(featuredCorpus.cases.filter(c => c.route !== 'render'))('$id publishes the literal AP plugin HTTP contract', async (c) => {
	const fixture = publicationFixture(c);
	const expected = featuredSource.cases.find(row => row.id === c.id)!.expected;
	const app = createActivityPubNotesApi({
		allowExternalApRedirect: async () => c.allowExternalApRedirect ?? true, production: c.production ?? false, selfUrl: publicationOptions.selfUrl, logger: { error: vi.fn() },
		federationEnabled: async () => c.federation !== 'none', isSelfHost: host => host.toLowerCase() === 'local.example',
		async readFeatured(id) {
			const notes = await readFeaturedNotes(id, {
				async readLocalUser() {
					fixture.event('lookup');
					return c.missing || fixture.users[0].host !== null ? null : { id: 'alice' };
				},
				async readPinNoteIdsDescending() {
					fixture.event('pins');
					return [...(c.pins ?? [{ id: '1', noteId: fixture.note.id }])].sort((a, b) => b.id.localeCompare(a.id)).map(p => p.noteId);
				},
				async readPinnedNote(noteId) {
					fixture.event('pin-note');
					const row = fixture.notes.find(n => n.id === noteId);
					if (!row) {
						throw Error('pinned note missing');
					}
					return row;
				},
			});
			if (notes === null) {
				return null;
			}
			return renderFeaturedCollection(id, await Promise.all(notes.map(async (n) => renderApNote(await preparePublishedNote(n, fixture.reader, { ...publicationOptions, ...c.config }), publicationOptions))), publicationOptions.selfUrl);
		},
		async readPublicNote() {
			fixture.event('lookup');
			return c.missing || fixture.note.localOnly || !['public', 'home'].includes(fixture.note.visibility) ? null : fixture.note;
		},
		async renderNote(note) {
			return renderApNote(await preparePublishedNote(note, fixture.reader, { ...publicationOptions, ...c.config }, false), publicationOptions, false);
		},
	});
	try {
		const path = c.route === 'featured' ? '/users/alice/collections/featured' : `/notes/${fixture.note.id}`;
		const response = await app.request(path + (c.query ?? ''), { method: c.method ?? 'GET', headers: c.accept === null ? {} : { Accept: c.accept ?? 'application/activity+json' } });
		expect(response.status).toBe(expected.status);
		// Source full diagnostic error body and HTML fallback are deliberately outside this comparison.
		for (const [key, value] of Object.entries(expected.headers!)) {
			if (key === 'content-type' && response.status === 404 && fixture.events.length === 0) {
				continue;
			}
			expect(response.headers.get(key), key).toBe(value);
		}
		if (response.status === 200 && c.method !== 'HEAD') {
			expect(await response.json()).toEqual(expected.json);
		}
		if (expected.text) {
			expect(await response.text()).toBe(expected.text);
		}
		if (c.method === 'HEAD') {
			expect(await response.text()).toBe('');
		}
		expect(fixture.events).toEqual(expected.events);
	} finally {
		fixture.restore();
	}
});
// The shared truthy-URI fix must also affect delivery without changing delivery to embed replies.
test('delivery keeps dive=false with empty reply and quote URIs', async () => {
	const c = featuredCorpus.cases.find(row => row.id === 'delivery-empty-uris')!;
	const fixture = publicationFixture(c);
	try {
		const prepared = await preparePublishedNote(fixture.note, fixture.reader, publicationOptions, false);
		const legacy = { ...prepared, files: [] };
		const activity = renderNoteActivity(legacy, publicationOptions);
		expect(activity.type).toBe('Create');
		expect(serialized(activity.object)).toEqual(featuredSource.cases.find(row => row.id === c.id)!.expected.json);
	} finally {
		fixture.restore();
	}
});
