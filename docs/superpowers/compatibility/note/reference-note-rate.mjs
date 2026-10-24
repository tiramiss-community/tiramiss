/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Copy to packages/backend/test/note-rate.mjs and run AFTER the e2e probe.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import pg from 'pg';
import { loadConfig } from '../built/config.js';

const config = loadConfig();
assert.equal(config.db.host, '127.0.0.1');
assert.equal(config.db.port, 55167);
assert.equal(config.db.db, 'backend_next_test');
assert.equal(config.dbReplications, undefined);
assert.equal(config.redis.host, '127.0.0.1');
assert.equal(config.redis.port, 56167);
assert.equal(config.port, 61167);
// The production process does not drop/synchronize the e2e schema.
const portCheck = createServer();
portCheck.listen(61167, '127.0.0.1');
await once(portCheck, 'listening');
await new Promise(resolve => portCheck.close(resolve));
const db = new pg.Client({ host: config.db.host, port: config.db.port, database: config.db.db, user: config.db.user, password: config.db.pass });
await db.connect();
let server;
const observations = {};
const recording = process.env.NOTE_PROBE_RECORD === '1';
const output = new URL('./note-rate-observations.json', import.meta.url);
const expected = recording ? {} : JSON.parse(readFileSync(output, 'utf8'));
const base = `http://127.0.0.1:${config.port}`;

async function call(input, token) {
	const response = await fetch(`${base}/api/notes/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, i: token }), signal: AbortSignal.timeout(5000) });
	return { status: response.status, body: await response.json(), wwwAuthenticate: response.headers.get('www-authenticate') };
}

try {
	const { rows: [actor] } = await db.query('SELECT id, token FROM "user" WHERE "usernameLower" = $1 AND host IS NULL', ['probe_outsider']);
	assert.ok(actor?.token, 'run note e2e first');
	// 300 / factor300 = 1 request/hour; exercise the real production limiter cheaply.
	await db.query('INSERT INTO role (id,name,description,"updatedAt","lastUsedAt",policies) VALUES ($1,$2,$3,now(),now(),$4)', ['note167rateRole', 'rate probe', '', JSON.stringify({ rateLimitFactor: { useDefault: false, priority: 1, value: 300 } })]);
	await db.query('INSERT INTO role_assignment (id,"roleId","userId") VALUES ($1,$2,$3)', ['note167rateAssignment', 'note167rateRole', actor.id]);
	server = spawn(process.execPath, ['./built/entry.js'], { cwd: new URL('../', import.meta.url), env: { ...process.env, NODE_ENV: 'production', MK_ONLY_SERVER: '1', MK_DISABLE_CLUSTERING: '1', MK_NO_DAEMONS: '1', MK_QUIET: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	server.stderr.on('data', data => { stderr = `${stderr}${data}`.slice(-2000); });
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		assert.equal(server.exitCode, null, `production server exited: ${stderr}`);
		try {
			const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {}
		await delay(100);
	}
	assert.ok(ready, `production server not ready: ${stderr}`);
	const before = Number((await db.query('SELECT count(*) FROM note')).rows[0].count);
	const first = await call({}, actor.token);
	assert.equal(first.status, 400);
	assert.equal(first.body.error.code, 'INVALID_PARAM');
	observations['C2-rate-first-invalid'] = first;
	const second = await call({}, actor.token);
	assert.equal(second.status, 429);
	assert.equal(second.body.error.code, 'RATE_LIMIT_EXCEEDED');
	assert.equal(typeof second.body.error.info.reset, 'number');
	assert.ok(second.body.error.info.reset * 1000 > Date.now());
	assert.equal(typeof second.body.error.info.resetMs, 'number');
	assert.ok(second.body.error.info.resetMs > Date.now());
	second.body.error.info.reset = '$future-epoch-seconds';
	second.body.error.info.resetMs = '$future-epoch-milliseconds';
	observations['C2-rate-before-input'] = second;
	assert.equal(Number((await db.query('SELECT count(*) FROM note')).rows[0].count), before);
	observations['C2-rate-db-delta'] = { notes: 0 };
	if (recording) {
		writeFileSync(output, `${JSON.stringify(observations, null, 2)}\n`);
	} else {
		assert.deepEqual(observations, expected);
	}
	console.log('Production rate-limit HTTP/DB probe: PASS (invalid input consumes quota; 429 precedes validation; no note saved)');
} finally {
	if (server && server.exitCode === null) {
		const closed = once(server, 'exit');
		server.kill('SIGTERM');
		const forced = setTimeout(() => server.kill('SIGKILL'), 12000);
		await closed;
		clearTimeout(forced);
	}
	await db.query('DELETE FROM role_assignment WHERE id=$1', ['note167rateAssignment']);
	await db.query('DELETE FROM role WHERE id=$1', ['note167rateRole']);
	await db.end();
}
