/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createEmojiImagesApi } from '../../src/http/emoji-images-api.js';
import { createEmojiImageAssets } from '../../src/platform/images/emoji-image-assets.js';
import { createEmojiImagesHttp } from '../../src/composition/emoji-images-http.js';

const directory = new URL('../../../../docs/superpowers/compatibility/emoji-images/', import.meta.url);
const corpus = JSON.parse(await readFile(new URL('corpus.json', directory), 'utf8')) as {
	cases: { id: string; path: string; method?: string; headers?: Record<string, string> }[];
};
const observations = JSON.parse(await readFile(new URL('observations.json', directory), 'utf8')) as {
	cases: { id: string; status: number; headers: Record<string, string | null>; body?: string; bodySha256?: string }[];
};
const require = createRequire(import.meta.url);
let assets: string;
let origin: string;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
	assets = await mkdtemp(join(tmpdir(), 'emoji-images-test-'));
	for (const [kind, name] of [['fluent-emoji', '1f600.png'], ['twemoji', '1f600.svg']]) {
		await mkdir(join(assets, kind), { recursive: true });
		await copyFile(require.resolve(`@misskey-dev/emoji-assets/${kind}/${name}`), join(assets, kind, name));
		await utimes(join(assets, kind, name), 946684800, 946684800);
	}
	await writeFile(join(assets, 'twemoji/1f601.svg'), 'invalid svg');
	const app = createEmojiImagesApi(createEmojiImageAssets({ fluentEmojiDir: join(assets, 'fluent-emoji'), twemojiDir: join(assets, 'twemoji') }));
	server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
	if (!server.listening) {
		await new Promise<void>(resolve => server.once('listening', resolve));
	}
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected an ephemeral TCP port');
	}
	origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
	if (assets) {
		await rm(assets, { recursive: true, force: true });
	}
});

for (const item of corpus.cases) {
	test(`emoji image HTTP matches pinned callbacks: ${item.id}`, async () => {
		const expected = observations.cases.find(row => row.id === item.id)!;
		const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
			const req = request(origin + item.path, { method: item.method, headers: item.headers }, async res => {
				const chunks: Buffer[] = [];
				for await (const chunk of res) {
					chunks.push(chunk);
				}
				resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
			});
			req.on('error', reject);
			req.end();
		});
		const headers = Object.fromEntries(Object.keys(expected.headers).map(name => [name, response.headers[name] ?? null]));
		if (['missing-badge', 'badge-error-head'].includes(item.id)) {
			headers['content-length'] = String(Number(headers['content-length']) - assets.length + '<assets>'.length);
		}
		expect({
			id: item.id,
			status: response.status,
			headers,
			...(expected.bodySha256 ? { bodySha256: createHash('sha256').update(response.body).digest('hex') } : { body: response.body.toString().replaceAll(assets, '<assets>') }),
		}).toEqual(expected);
	});
}

test('deployed composition resolves its own emoji asset package and renders the pinned badge pipeline', async () => {
	const app = createEmojiImagesHttp();
	const response = await app.request('/twemoji-badge/1f600.png');
	expect(response.status).toBe(200);
	const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
	expect({ width: metadata.width, height: metadata.height, format: metadata.format }).toEqual({ width: 512, height: 512, format: 'png' });
	for (const [path, file] of [['/twemoji/1f600.svg', 'twemoji/1f600.svg'], ['/fluent-emoji/1f600.png', 'fluent-emoji/1f600.png']]) {
		const image = await app.request(path);
		expect(image.status).toBe(200);
		expect(Buffer.from(await image.arrayBuffer())).toEqual(await readFile(require.resolve(`@misskey-dev/emoji-assets/${file}`)));
	}
});
