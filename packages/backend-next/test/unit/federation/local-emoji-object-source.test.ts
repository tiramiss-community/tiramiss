/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test, vi } from 'vitest';
import corpus from '../../../../../docs/superpowers/compatibility/remote-user/local-emoji-object-corpus.json' with { type: 'json' };
import observed from '../../../../../docs/superpowers/compatibility/remote-user/local-emoji-object-observations.json' with { type: 'json' };
import { createActivityPubEmojiApi } from '../../../src/http/activitypub-emoji-api.js';
import { renderApEmoji } from '../../../src/modules/federation/public.js';
import { createLocalEmojiObjectReader } from '../../../src/platform/database/local-emoji-object.js';
import type { EntityManager } from 'typeorm';

interface Row {
	name: string; host: string | null; localOnly: boolean; updatedAt: string | null;
	type: string | null; publicUrl: string; originalUrl: string; license: string | null;
}
interface Case {
	id: string; rows?: Row[]; emoji?: Partial<Row>; extraRows?: Partial<Row>[];
	path?: string; method?: string; query?: string; accept?: string | null; fail?: string; federation?: string;
}

test('independent fixed-source fixture pins all finite cases', () => {
	expect(corpus.source).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	expect(observed.source).toBe(corpus.source);
	expect(observed.cases.map(c => c.id)).toEqual(corpus.cases.map(c => c.id));
	expect(new Set(corpus.cases.map(c => c.id)).size).toBe(53);
});

for (const c of corpus.cases as Case[]) {
	test(`source ${c.id}: public body, HTTP boundaries and semantic local lookup`, async () => {
		const rows = c.rows ?? [{ ...corpus.defaults.emoji, ...c.emoji }, ...(c.extraRows ?? []).map(row => ({ ...corpus.defaults.emoji, ...row }))];
		const before = JSON.stringify(rows);
		const events: unknown[][] = [];
		const manager = { getRepository: () => ({ async findOneBy(where: { name: string; host: { type: string } }) {
			events.push(['emoji', { name: where.name, host: where.host.type }]);
			if (c.fail === 'db') {
				throw new Error('injected repository diagnostic');
			}
			const row = rows.find(row => row.host === null && row.name === where.name);
			return row ? { ...row, updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt) } : null;
		} }) } as unknown as EntityManager;
		const logger = { error: vi.fn() };
		const app = createActivityPubEmojiApi({ federationEnabled: async () => c.federation !== 'none', readEmoji: createLocalEmojiObjectReader(manager), renderEmoji: emoji => renderApEmoji(emoji, corpus.defaults.selfUrl, Date.parse(corpus.defaults.now)), logger });
		const response = await app.request((c.path ?? '/emojis/hello') + (c.query ?? ''), { method: c.method ?? 'GET', headers: c.accept === null ? {} : { Accept: c.accept ?? 'application/activity+json' } });
		const source = observed.cases.find(row => row.id === c.id)!.expected;
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
		if (c.id === 'HEAD-malformed') {
			// Fastify injection exposes a router error body that Node's HTTP transport suppresses for HEAD.
			expect(source.body).toEqual({ statusCode: 400, error: 'Bad Request' });
			expect(body).toBe('');
		} else {
			expect(body).toEqual(source.body);
		}
		expect(events).toEqual(source.events);
		expect(JSON.stringify(rows)).toBe(before);
		if (response.status === 500) {
			expect(logger.error).toHaveBeenCalledExactlyOnceWith('activitypub-emoji.failed', { classification: 'unexpected-failure' });
			expect(text).not.toContain('injected repository diagnostic');
		} else {
			expect(logger.error).not.toHaveBeenCalled();
		}
	});
}
