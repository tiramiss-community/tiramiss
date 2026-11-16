/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import sharp from 'sharp';
import { expect } from 'vitest';
import type { AvatarImageSettings, ImageUser } from '../../src/modules/avatar-images/public.js';

const directory = new URL('../../../../docs/superpowers/compatibility/avatar-images/', import.meta.url);
export interface ImageCase { id: string; path: string; method?: string; meta?: Partial<AvatarImageSettings>; mediaProxy?: string; }
export const imageCorpus = JSON.parse(readFileSync(new URL('corpus.json', directory), 'utf8')) as {
	config: { url: string; host: string; mediaProxy: string };
	meta: AvatarImageSettings;
	emojis: { name: string; host: string | null; publicUrl: string; originalUrl: string }[];
	users: (ImageUser & { isSuspended?: boolean })[];
	cases: ImageCase[];
};
export const imageObservations = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; status: number; headers: Record<string, string | null>; body?: string; bodySha256?: string; metadata?: { width: number; height: number; format: string } }[];
};
assert.equal(new Set(imageCorpus.cases.map(item => item.id)).size, imageCorpus.cases.length, 'image corpus IDs must be unique');
assert.equal(new Set(imageObservations.cases.map(item => item.id)).size, imageObservations.cases.length, 'image observation IDs must be unique');
assert.deepEqual(imageCorpus.cases.map(item => item.id), imageObservations.cases.map(item => item.id), 'image corpus and observations must correspond one to one');
export function imageRequest(origin: string, item: Pick<ImageCase, 'path' | 'method'>) {
	return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
		const endpoint = new URL(origin);
		const req = request({ hostname: endpoint.hostname, port: endpoint.port, path: item.path, method: item.method }, async res => {
			const chunks: Buffer[] = [];
			for await (const chunk of res) {
				chunks.push(chunk);
			}
			resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
		});
		req.on('error', reject);
		req.end();
	});
}
export async function expectImageObservation(origin: string, item: ImageCase) {
	const expected = imageObservations.cases.find(row => row.id === item.id)!;
	const response = await imageRequest(origin, item);
	const metadata = expected.metadata ? await sharp(response.body).metadata().then(({ width, height, format }) => ({ width, height, format })) : undefined;
	expect({
		id: item.id, status: response.status,
		headers: Object.fromEntries(Object.keys(expected.headers).map(name => [name, response.headers[name] ?? null])),
		...(expected.bodySha256 ? { bodySha256: createHash('sha256').update(response.body).digest('hex'), metadata } : { body: response.body.toString() }),
	}).toEqual(expected);
}
