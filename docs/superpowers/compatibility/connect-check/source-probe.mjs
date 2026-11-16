/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const { Redis } = require('ioredis');
const { DataSource } = require('typeorm');
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const sourcePath = 'packages/backend/scripts/check_connect.js';
const upstream = process.argv[2];
assert.ok(upstream, 'provide fixed upstream checkout');
const source = readFileSync(resolve(upstream, sourcePath));
assert.deepEqual(source, execFileSync('git', ['-C', upstream, 'show', `${pin}:${sourcePath}`]));
const body = source.toString().replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('Redis', 'loadConfig', 'createPostgresDataSource', body);
const db = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_DB_PORT ?? 55432), database: 'backend_next_test', username: 'postgres', password: 'foundation-test-only' };
const names = ['redis', 'redisForPubsub', 'redisForJobQueue', 'redisForTimelines', 'redisForReactions'];
const observations = [];
for (const failure of [null, 'database', ...names, 'fallback']) {
	const clients = [];
	const sources = [];
	class ObservedRedis extends Redis {
		constructor(options) { super(options); clients.push(this); }
	}
	const base = { host: '127.0.0.1', port: Number(process.env.BACKEND_NEXT_TEST_REDIS_PORT ?? 56379), retryStrategy: () => null };
	const config = Object.fromEntries(names.map(name => [name, failure === 'fallback' ? base : { ...base, ...(name === failure ? { password: 'source-private-marker', username: 'private-invalid-user' } : {}) }]));
	let rejects = false;
	try {
		await execute(ObservedRedis, () => config, () => {
			// Explicit binding: real PostgreSQL driver, no entity graph/config loader
			// or upstream query cache. The pinned script body itself is unmodified.
			const result = new DataSource({ type: 'postgres', ...db, ...(failure === 'database' ? { password: 'source-private-marker' } : {}), entities: [], synchronize: false, migrationsRun: false, installExtensions: false, extra: { connectionTimeoutMillis: 500 } });
			sources.push(result);
			return result;
		});
	} catch { rejects = true; }
	// Upstream Promise.all may reject before other checks settle. Let accepted
	// operations finish before inspecting cleanup; do not claim early-await parity.
	await new Promise(done => setTimeout(done, 100));
	assert.equal(rejects, failure !== null && failure !== 'fallback');
	assert.ok(clients.every(client => client.status === 'end'));
	assert.ok(sources.every(source => !source.isInitialized));
	observations.push({ id: failure ?? 'success', rejects, redisConnections: clients.length, released: true });
}
const result = { upstreamCommit: pin, manifest: { path: sourcePath, sha256: createHash('sha256').update(source).digest('hex') }, mode: 'literal-script-body-real-redis-pg-explicit-db-config-bindings', limitations: ['Not full upstream config loader, Entity graph, query cache or full server.', 'Failure cleanup observed after accepted operations settle; upstream Promise.all returns early.'], cases: observations };
writeFileSync(new URL('source-observations.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(`connect-check source: ${observations.length} cases PASS`);
