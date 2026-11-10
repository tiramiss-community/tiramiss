/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createInstanceMetadata } from '../../../src/platform/instance-metadata.js';
import type { Redis } from 'ioredis';
import type { OutboundHttp } from '../../../src/application/outbound-http.js';
import type { InstanceLedger, InstancePatch } from '../../../src/modules/federation/public.js';

const source = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/instance-metadata/observations.json', import.meta.url), 'utf8'));

test.each(source.cases as { id: string; input: Record<string, any>; expected: { events: unknown[][]; patch: unknown; rejection: string | null } }[])('$id matches independent pinned-source operation events, patch and failure boundary', async fixture => {
	const input = fixture.input;
	let time = 1800000000000;
	const events: unknown[][] = [];
	let errors = 0;
	let patch: InstancePatch | null = null;
	const fetch = createInstanceMetadata({
		clock: () => time,
		reportFailure: () => {
			errors++;
		},
		redis: {
			del: async (key: string) => {
				events.push(['del', key]); if (input.unlockError && key.includes(':v2:')) {
					throw Error('unlock');
				} return 1;
			},
			set: async (...args: unknown[]) => {
				events.push(['set', ...args]); if (input.lockError) {
					throw Error('lock');
				} return input.lock ?? null;
			},
		} as unknown as Redis,
		ledger: {
			fetchOrRegisterInstance: async (host: string) => {
				events.push(['read', host]); if (input.readError) {
					throw Error('read');
				} return { infoUpdatedAtMs: input.age === undefined ? null : time - input.age };
			},
			updateInstance: async (id: string, updates: InstancePatch) => {
				events.push(['update', id]); patch = JSON.parse(JSON.stringify(updates)); if (input.updateError) {
					throw Error('update');
				}
			},
		} as unknown as InstanceLedger,
		http: {
			getJson: async (url: string) => {
				events.push(['json', url]);
				if (url.endsWith('/.well-known/nodeinfo')) {
					return { links: input.links ?? (input.versions ?? ['1.0', '2.0', '2.1']).map((v: string) => ({ rel: `http://nodeinfo.diaspora.software/ns/schema/${v}`, href: `https://remote.test/nodeinfo/${v}` })) };
				}
				if (url.endsWith('/manifest.json')) {
					if (!('manifest' in input)) {
						throw Error('manifest');
					} return input.manifest;
				}
				if (input.failSelected || !('info' in input)) {
					throw Error('nodeinfo');
				} return input.info;
			},
			getHtml: async (url: string) => {
				events.push(['html', url]); if (!('html' in input)) {
					throw Error('html');
				} return input.html;
			},
			send: async (url: string, options: unknown, extra: unknown) => {
				events.push(['head', url, options, { throwErrorWhenResponseNotOk: (extra as { okOnly: boolean }).okOnly }]); time += input.advance ?? 0; return { status: input.faviconStatus ?? 404 };
			},
		} as unknown as OutboundHttp,
	});
	let rejection: string | null = null;
	try {
		await fetch({ id: 'i', host: 'remote.test' }, input.force);
	} catch (error) {
		rejection = (error as Error).message;
	}
	const normalized = patch as Record<string, unknown> | null;
	if (normalized && 'infoUpdatedAtMs' in normalized) {
		normalized.infoUpdatedAt = new Date(normalized.infoUpdatedAtMs as number).toISOString(); delete normalized.infoUpdatedAtMs;
	}
	// Source helper diagnostics are separate from its operation catch; only the latter is our reporting port.
	const sourceOperationErrors = Number(input.readError || input.updateError || false);
	expect({ events, patch: normalized, rejection }).toEqual({ events: fixture.expected.events, patch: fixture.expected.patch, rejection: fixture.expected.rejection });
	expect(errors).toBe(sourceOperationErrors);
});
