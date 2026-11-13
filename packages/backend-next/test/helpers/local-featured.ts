/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createIdCodec } from '../../src/platform/id-codec.js';
import { vi } from 'vitest';
import * as mfm from '../../src/modules/mfm/public.js';
import type { NotePublicationRow, NotePublicationReader } from '../../src/modules/federation/public.js';
import type { NoteActivityMaterials } from '../../src/modules/federation/public.js';
export interface FeaturedCase {
	allowExternalApRedirect?: boolean;
	production?: boolean;
	id: string;
	route: 'render' | 'featured' | 'note';
	note?: Partial<NotePublicationRow>;
	notes?: NotePublicationRow[];
	user?: {
		host?: string;
		username?: string;
		isSuspended?: boolean;
	};
	missing?: boolean;
	dive?: boolean;
	fail?: string[];
	accept?: string | null;
	method?: string;
	federation?: string;
	query?: string;
	config?: {
		externalMediaProxyEnabled: boolean;
		mediaProxy: string;
	};
	pins?: {
		id: string;
		noteId: string;
	}[];
	files?: {
		id: string;
		type: string;
		webpublicType: string | null;
		webpublicUrl: string | null;
		url: string;
		comment: string | null;
		properties: {
			width?: number;
			height?: number;
		};
		isSensitive: boolean;
		uri: string | null;
		userHost: string | null;
		isLink: boolean;
		webpublicAccessKey: string | null;
	}[];
	poll?: {
		choices: string[];
		multiple: boolean;
		votes: number[];
		expiresAt: string | null;
	};
	emojis?: {
		name: string;
		type: string | null;
		publicUrl: string;
		originalUrl: string;
		license: string | null;
		localOnly: boolean;
		updatedAt: string | null;
	}[];
}
const directory = new URL('../../../../docs/superpowers/compatibility/remote-user/', import.meta.url);
export const featuredCorpus = JSON.parse(readFileSync(new URL('local-featured-corpus.json', directory), 'utf8')) as {
	defaults: {
		note: NotePublicationRow;
		selfUrl: string;
		now: string;
		users: {
			id: string;
			username: string;
			host: string | null;
			uri: string | null;
			isSuspended: boolean;
		}[];
	};
	cases: FeaturedCase[];
};
export const featuredSource = JSON.parse(readFileSync(new URL('local-featured-observations.json', directory), 'utf8')) as {
	cases: {
		id: string;
		expected: {
			json?: unknown;
			events: string[];
			error?: {
				name: string;
				message: string;
			};
			status?: number;
			headers?: Record<string, string | null>;
			bodyEmpty?: boolean;
			text?: string;
		};
	}[];
};
export const publicationOptions = { selfUrl: featuredCorpus.defaults.selfUrl, now: Date.parse(featuredCorpus.defaults.now), createdAtFromId: createIdCodec('aidx').createdAtFromId };
// The dependency doubles model repository reads; real MFM conversion remains in the pipeline.
export function publicationFixture(c: FeaturedCase) {
	const events: string[] = [];
	const event = (stage: string) => {
		events.push(stage);
		if (c.fail?.includes(stage)) {
			throw Error(`${stage} unavailable`);
		}
	};
	const note = { ...featuredCorpus.defaults.note, ...c.note };
	const notes = [note, ...(c.notes ?? [])];
	const users = featuredCorpus.defaults.users.map(u => u.id === 'alice' ? { ...u, ...c.user } : u);
	const reader: NotePublicationReader = {
		async readNote(id) {
			event(notes.some(n => n.replyId === id) ? 'reply' : 'quote');
			return notes.find(n => n.id === id) ?? null;
		},
		async authorExists(id) {
			event('author');
			return users.some(u => u.id === id);
		},
		async readMentionedUsers(ids) {
			event('mentions');
			return ids.flatMap(id => users.filter(u => u.id === id));
		},
		async readFiles(ids) {
			event('files');
			return ids.flatMap(id => (c.files ?? []).filter(f => f.id === id).map(f => ({ type: f.type, webpublicType: f.webpublicType, publicFile: f, proxyRemoteFiles: false, urlOptions: { url: featuredCorpus.defaults.selfUrl, ...c.config }, comment: f.comment, width: f.properties.width, height: f.properties.height, isSensitive: f.isSensitive })));
		},
		async readPoll() {
			event('poll');
			return c.poll ? { ...c.poll, expiresAtMs: c.poll.expiresAt === null ? null : Date.parse(c.poll.expiresAt) } : null;
		},
		async readEmojis(names) {
			event('emoji');
			return names.flatMap(name => (c.emojis ?? []).filter(e => e.name === name).map(e => ({ ...e, updatedAtMs: e.updatedAt === null ? null : Date.parse(e.updatedAt) })));
		},
	};
	const original = mfm.getNoteHtml;
	const spy = vi.spyOn(mfm, 'getNoteHtml').mockImplementation((...args) => {
		event('html');
		return original(...args);
	});
	return { events, event, note, notes, users, reader, restore: () => spy.mockRestore() };
}
export function serialized(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}
export type PublicationMaterials = NoteActivityMaterials;
