/*
 * SPDX-FileCopyrightText: 2026 tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Test fixture helper: run as a separate stopped producer process on isolated Redis.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { capture, fixedCommit } = require('./reference-queue-handoff.cjs');

// Explicit test-input binding for captured arguments; this does not execute source.
function bindRecorded(fixture, bindings = {}) {
	const allowed = ['userId', 'noteId', 'webhookId', 'webhookUrl', 'deliverUrl', 'sharedInboxUrl', 'activity'];
	assert(Object.keys(bindings).every(key => allowed.includes(key)), 'Unknown recorded test binding');
	for (const item of fixture.fixtures) {
		for (const job of item.jobs) {
			if (item.queue === 'deliver') {
				if (bindings.userId) {
					job.data.user.id = bindings.userId;
				}
				const to = job.data.isSharedInbox ? bindings.sharedInboxUrl : bindings.deliverUrl;
				if (to) {
					job.data.to = to;
					job.name = to.replace('https://', '').replace('/inbox', '');
				}
				if (bindings.activity) {
					job.data.content = JSON.stringify(bindings.activity);
					job.data.digest = `SHA-256=${crypto.createHash('sha256').update(job.data.content).digest('base64')}`;
				}
			} else if (item.queue === 'endedPollNotification' && bindings.noteId) {
				job.name = bindings.noteId;
				job.data.noteId = bindings.noteId;
			} else if (item.queue === 'userWebhookDeliver') {
				if (bindings.userId) {
					job.data.userId = bindings.userId;
				}
				if (bindings.webhookId) {
					job.name = bindings.webhookId;
					job.data.webhookId = bindings.webhookId;
				}
				if (bindings.webhookUrl) {
					job.data.to = bindings.webhookUrl;
				}
				if (bindings.noteId && job.data.content.note) {
					job.data.content.note.id = bindings.noteId;
				}
			}
		}
		if (item.queue === 'deliver' && item.method === 'addBulk') {
			// The source builds a Map from the bound inbox pairs before deliverMany.
			item.jobs = [...new Map(item.jobs.map(job => [job.data.to, job])).values()];
		}
	}
	return fixture;
}

async function checkBindings(upstream) {
	const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'observations.json'), 'utf8'));
	const selected = fixture => fixture.fixtures.filter(item => ['deliver', 'endedPollNotification', 'userWebhookDeliver'].includes(item.queue));
	for (const sameInbox of [false, true]) {
		const bindings = {
			userId: 'bound-user', noteId: 'bound-note', webhookId: 'bound-hook',
			webhookUrl: 'http://127.0.0.1:12345/hook', deliverUrl: 'http://127.0.0.1:12345/inbox',
			sharedInboxUrl: sameInbox ? 'http://127.0.0.1:12345/inbox' : 'http://127.0.0.1:12345/shared',
			activity: { type: 'Create', object: { id: 'bound-note' } },
		};
		const recorded = bindRecorded(structuredClone(fixtures), bindings);
		const actual = await capture(upstream, undefined, bindings);
		assert.deepEqual(selected(recorded), selected(actual), sameInbox ? 'same inbox bindings' : 'distinct inbox bindings');
		const bulk = recorded.fixtures.find(item => item.id === 'deliver-bulk').jobs;
		assert.equal(bulk.length, sameInbox ? 1 : 2);
		assert.equal(bulk.at(-1).data.isSharedInbox, true);
		assert.equal(recorded.fixtures.find(item => item.id === 'deliver-single').jobs[0].data.isSharedInbox, false);
	}
	console.log('PASS recorded bindings match source: distinct inboxes and identical inbox Map last value');
}

async function generate(upstream, configuration, output) {
	const config = JSON.parse(fs.readFileSync(configuration, 'utf8'));
	assert(config.redis && typeof config.redis.prefix === 'string' && config.redis.prefix.length > 0, 'An isolated test Redis configuration with explicit prefix is required');
	assert(Array.isArray(config.fixtureIds), 'Select fixtureIds explicitly');
	const recorded = upstream === '--recorded';
	const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'observations.json'), 'utf8'));
	assert.equal(expected.sourceCommit, fixedCommit);
	let fixture;
	if (recorded) {
		fixture = bindRecorded(expected, config.bindings);
		const { keyPrefix: _keyPrefix, ...connection } = config.redis;
		for (const item of fixture.queueOptions) {
			item.options = { connection, prefix: `${config.redis.prefix}:queue:${item.queue}` };
		}
	} else {
		assert.deepEqual(await capture(upstream), expected);
		fixture = await capture(upstream, undefined, { ...config.bindings, queueRedis: config.redis });
	}
	const requireUpstream = createRequire(recorded ? path.resolve(__dirname, '../../../../packages/backend-next/package.json') : path.join(path.resolve(upstream), 'packages/backend/package.json'));
	const bullmqVersion = requireUpstream('bullmq/package.json').version;
	assert.equal(bullmqVersion, fixture.toolchain.upstreamBullmq);
	const { Queue } = requireUpstream('bullmq');
	const queues = new Map();
	const receipt = {
		sourceCommit: fixedCommit, bullmqVersion,
		mode: recorded ? 'recorded-arguments' : 'pinned-source',
		evidence: recorded ? 'Replay of frozen source argument fixtures with explicit test bindings and current installed BullMQ; no source invocation, full server or business workers' : 'Actual upstream-installed BullMQ generation from pinned source producer arguments; no full server or business workers',
		fixtures: [], schedulers: [],
	};
	const queue = name => {
		if (!queues.has(name)) {
			const options = fixture.queueOptions.find(item => item.queue === name).options;
			const handle = new Queue(name, options);
			handle.on('error', () => {});
			queues.set(name, handle);
		}
		return queues.get(name);
	};
	try {
		for (const id of config.fixtureIds) {
			const item = fixture.fixtures.find(candidate => candidate.id === id);
			assert(item, `Unknown fixture ${id}`);
			const handle = queue(item.queue);
			const jobs = item.method === 'addBulk' ? await handle.addBulk(item.jobs) : [await handle.add(item.jobs[0].name, item.jobs[0].data, item.jobs[0].opts)];
			const stored = [];
			for (const job of jobs) {
				stored.push({ id: job.id, name: job.name, data: job.data, opts: job.opts, state: await job.getState() });
			}
			receipt.fixtures.push({ id, queue: item.queue, qualifiedName: handle.qualifiedName, jobs: stored });
		}
		for (const id of config.schedulerIds || []) {
			const scheduler = fixture.schedulers.find(candidate => candidate.id === id);
			assert(scheduler, `Unknown scheduler ${id}`);
			const handle = queue('system');
			await handle.upsertJobScheduler(id, scheduler.repeat, scheduler.template);
			receipt.schedulers.push(await handle.getJobScheduler(id));
		}
	} finally {
		await Promise.all([...queues.values()].map(handle => handle.close()));
	}
	fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	console.log(JSON.stringify({ fixtures: receipt.fixtures.length, schedulers: receipt.schedulers.length, bullmqVersion }));
}

if (require.main === module) {
	const [upstream, configuration, output] = process.argv.slice(2);
	if (upstream === '--check-bindings') {
		assert(configuration, 'Pass a pinned upstream root for --check-bindings');
		checkBindings(configuration).catch(error => { console.error(error); process.exitCode = 1; });
	} else {
		assert(upstream && configuration && output, 'Usage: generate-bullmq.cjs upstream-root|--recorded test-config.json receipt.json');
		generate(upstream, configuration, output).catch(error => {
			// Redis exceptions can contain connection settings; retain only the error class.
			console.error(`Fixture generation failed (${error?.name || 'Error'})`);
			process.exitCode = 1;
		});
	}
}

module.exports = { generate, bindRecorded };
