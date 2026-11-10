/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { domainToASCII } from 'node:url';

const base = 'packages/backend/src/';
const upstreamCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to the pinned source checkout (regeneration only)');
assert(['--write', '--check'].includes(process.argv[2]), 'Use --write or --check');
const verifiedFiles = process.env.UPSTREAM_SOURCE_MODE === 'verified-files';
if (!verifiedFiles) {
	execFileSync('git', ['-C', root, 'cat-file', '-e', `${upstreamCommit}^{commit}`]);
}
// Git blob IDs read from ls-tree at upstreamCommit; fallback verifies every source byte.
const pinnedBlobs = {
	"core/UtilityService.ts": "e3ceebccaeb0c9058a919318ef7c4216f8e64649",
	"core/activitypub/misc/check-against-url.ts": "bbfe57f9fafc719037ef5749b22a2e25c32fd690",
	"core/activitypub/misc/validator.ts": "690beeffef5d9b2115079d0806c10decdb9e4ebe",
	"core/activitypub/models/ApPersonService.ts": "39396cb7411120352a719de531654fdf04424f52",
	"core/activitypub/models/tag.ts": "f75cc45f7e4f714709261d3daa761c3ed605c7e6",
	"core/activitypub/type.ts": "99668813a4cb9ae65cd33e51fb2faca0bbb1f7b2",
	"misc/check-https.ts": "15a54f6ce7e2f6ce7809e4d12a4294f005a93166",
	"misc/normalize-for-search.ts": "3f19617e1480f14167f980f2bec85fd3438fd7c1",
	"misc/prelude/array.ts": "f741a0c9133911688727cd72499b7476e3783a56",
	"misc/status-error.ts": "c3533db60759a0f82ca7ee82772b89899e5cc942",
	"misc/truncate.ts": "1c8a274609a122aa16521b22ac76618938ebc354",
};

function readSource(path) {
	if (!verifiedFiles) {
		return execFileSync('git', ['-C', root, 'show', `${upstreamCommit}:${base}${path}`], { encoding: 'utf8' });
	}
	const bytes = readFileSync(`${root}/${base}${path}`);
	const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
	assert.equal(blob, pinnedBlobs[path], `source differs from pin: ${path}`);
	return bytes.toString('utf8');
}

const fullFileSha256 = {
	"core/UtilityService.ts": "99f8779e002fc2c0aa2cd203613d31fcc87e7eaeb797ef65aae6c5175b62e331",
	"core/activitypub/models/ApPersonService.ts": "471168b426b6ec19294b345bd0f66ac1c46fd554475c7c396bdbd9d859624921"
};
for (const [path, sha] of Object.entries(fullFileSha256)) {
	assert.equal(createHash('sha256').update(readSource(path)).digest('hex'), sha, `full source binding: ${path}`);
}
const require = createRequire(`${root}/package.json`);
const backendRequire = createRequire(`${root}/packages/backend/package.json`);
const ts = require('typescript');
const expectedMethodSha256 = {
	"UtilityService.toPuny": "fcb70ffa3b4a1ad01eda9b2c97d696dd2b26fc5be8fad9f56ddb6a75e256e4d2",
	"UtilityService.punyHost": "5280ceda6a0817c4fc16ac3e3aada3538a1d268ccac1aaea6127cd3bd4450e71",
	"UtilityService.extractDbHost": "672fb1106e47f858fbd31fd15afb99fbe1303337a5bb4895665fd392b1a88609",
	"UtilityService.isUriLocal": "5829f403d08e17fa4891bb7392c939160ece5409c48f261893357346a7ab87a5",
	"UtilityService.isSelfHost": "a027a92bcc38e2b1b4b5384df22bfb1df8bad9e4eaac1d2ea15ea418c990cbb7",
	"UtilityService.isBlockedHost": "afaaf213f5f8358cb6ea4f29ce47cefc1b727e2e28f787504c842d1869872d36",
	"UtilityService.isFederationAllowedHost": "5cc884819669df334b78fb68226950e08a762ed70d1a2fc94ea5b228222293d1",
	"ApPersonService.validateActor": "da3ed624a237652d14ec90ecd267c6d6a905318e79b1f37dcc13965b79c80367",
	"ApPersonService.createPerson": "c2e3b8e9efd102fefcae50e7c51a17ba67741f1c9410148ee33a87b33838e7af",
	"ApPersonService.analyzeAttachments": "9c2bb9f0d0765fe963458fb7cc3432e91626a5b62bf9f367a5b516667a040658",
	"ApPersonService.isPublicCollection": "04640fbd0ef0f2a9cc68a133f7e2cf7c6dd5b2b68d94bedc87c1dd55d64f1973"
};
const methods = {};
const files = new Map();

function source(path) {
	if (!files.has(path)) {
		files.set(path, ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true));
	}
	return files.get(path);
}

function record(id, path, literal) {
	methods[id] = { path: base + path, sha256: createHash('sha256').update(literal).digest('hex') };
}

const now = 1800000000000;
class Clock extends Date {
	constructor(...args) {
		super(...(args.length ? args : [now]));
	}
	static now() {
		return now;
	}
}
class IdentifiableError extends Error {
	constructor(id, message) {
		super(message); this.id = id;
	}
}
const globals = {
	URL, Date: Clock, Error, Buffer, AbortController, process: { env: { NODE_ENV: 'production' } },
	IdentifiableError,
	IsNull: () => null, chalk: { magenta: x => x, yellow: x => x }, nameLength: 128, summaryLength: 2048
};

function evaluate(text) {
	return vm.runInNewContext(ts.transpile(text, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), globals);
}

function method(path, klass, name) {
	const sf = source(path);
	const c = sf.statements.find(s => ts.isClassDeclaration(s) && s.name.text === klass);
	const m = c.members.find(s => s.name?.getText(sf) === name);
	assert(m?.body, `${klass}.${name}`);
	const id = `${klass}.${name}`;
	record(id, path, m.getText(sf));
	assert.equal(methods[id].sha256, expectedMethodSha256[id], `method binding: ${id}`);
	return evaluate(`(${m.modifiers?.some(x => x.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function(${m.parameters.map(p => p.getText(sf)).join(',')})${m.body.getText(sf)})`);
}

function moduleSource(path) {
	const sf = source(path);
	const literal = sf.statements.filter(s => !ts.isImportDeclaration(s)).map(s => s.getText(sf)).join('\n');
	record(path, path, literal);
	const exports = {};
	vm.runInNewContext(ts.transpile(literal, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), { ...globals, exports });
	return exports;
}

const { StatusError } = moduleSource('misc/status-error.ts');
globals.StatusError = StatusError;
Object.assign(globals, moduleSource('core/activitypub/type.ts'));
Object.assign(globals, moduleSource('core/activitypub/misc/check-against-url.ts'));
Object.assign(globals, moduleSource('core/activitypub/misc/validator.ts'));
Object.assign(globals, moduleSource('misc/check-https.ts'), moduleSource('misc/normalize-for-search.ts'));
// The unicode implementation is the pinned source's own installed stringz tool.
globals.substring = backendRequire('stringz').substring;
Object.assign(globals, moduleSource('misc/truncate.ts'));
Object.assign(globals, moduleSource('misc/prelude/array.ts'));
Object.assign(globals, moduleSource('core/activitypub/models/tag.ts'));
const personPath = 'core/activitypub/models/ApPersonService.ts';
const f = {};
for (const name of ['validateActor', 'createPerson', 'analyzeAttachments', 'isPublicCollection']) {
	f[name] = method(personPath, 'ApPersonService', name);
}
const logger = { info() { }, error() { }, warn() { }, succ() { } };
globals.domainToASCII = domainToASCII;
const utilityService = {};
for (const name of ['toPuny', 'punyHost', 'extractDbHost', 'isUriLocal', 'isSelfHost', 'isBlockedHost', 'isFederationAllowedHost']) {
	utilityService[name] = method('core/UtilityService.ts', 'UtilityService', name).bind(utilityService);
}
utilityService.config = { host: 'local.test', url: 'https://local.test' };
utilityService.meta = { federation: 'all', blockedHosts: [] };
const config = { host: 'local.test', url: 'https://local.test', userAgent: 'source-probe' };

// Preserve own undefined properties distinctly from absent keys and explicit null.
function plain(value) {
	if (value === undefined) {
		return { $undefined: true };
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		return Array.from(value, plain);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).map(k => [k, plain(value[k])]));
	}
	return value;
}

const cases = [];

async function capture(id, input, run) {
	const savedInput = plain(input);
	const events = [];
	const event = (op, args) => events.push({ op, ...(args === undefined ? {} : { args: plain(args) }) });
	let expected;
	try {
		expected = { result: plain(await run(event)), events };
	} catch (e) {
		expected = { error: { message: e.message, ...(e.id ? { id: e.id } : {}) }, events };
	}
	cases.push({ id, provenance: 'literal-source-method', input: savedInput, expected });
	return cases.at(-1);
}

class MiUser {
	constructor(data) {
		Object.assign(this, data);
	}
}
class MiUserProfile extends MiUser { }
class MiUserPublickey extends MiUser { }
Object.assign(globals, { MiUser, MiUserProfile, MiUserPublickey, isDuplicateKeyValueError: e => e.code === '23505' });
f.createPerson = method(personPath, 'ApPersonService', 'createPerson');

function deferred() {
	let resolve; const promise = new Promise(yes => {
		resolve = yes;
	}); return { promise, resolve };
}

for (const input of [
	...[false, true].flatMap(duplicate => [false, true].map(stats => ({ duplicate, stats }))),
	{ stats: true, gate: 'register' }, { stats: true, gate: 'increment' },
	{ stats: true, duplicate: true, origin: 'https://ORIGIN.test/alias', canonicalHost: 'canonical.test' },
	...['User', 'Profile', 'Key'].map(fail => ({ stats: true, fail })),
	{ stats: true, duplicate: true, missing: true },
]) {
	const id = `instance-${cases.length + 1}`;
	await capture(id, input, async event => {
		const uri = input.origin ?? 'https://remote.test/users/a';
		const material = { type: 'Person', id: uri, preferredUsername: 'Alice', inbox: new URL('/inbox', uri).href, publicKey: { id: uri + '#key', publicKeyPem: 'key' } };
		const canonical = { id: 'canonical', uri, host: input.canonicalHost ?? 'remote.test', username: 'Alice', tags: [] };
		const register = deferred(); const increment = deferred();
		let registerPending = false; let incrementPending = false;
		const resolver = { resolve: async () => material, resolveCollection: async x => x };
		const ctx = {
			config, logger, utilityService, meta: { enableStatsForFederatedInstances: input.stats, enableChartsForFederatedInstances: true }, idService: { gen: () => 'new-user' },
			apResolverService: { createResolver: async () => resolver },
			usersRepository: {
				findOneBy: async () => {
					event('canonical'); return input.missing ? null : canonical;
				}, update: async () => { }
			},
			db: {
				transaction: async callback => {
					event('begin'); try {
						await callback({
							save: async entity => {
								const name = entity instanceof MiUserPublickey ? 'Key' : entity instanceof MiUserProfile ? 'Profile' : 'User'; event(name);
								if (input.fail === name) {
									throw Error(name + ' failed');
								}
								if (input.duplicate && name === 'User') {
									throw Object.assign(Error('duplicate'), { code: '23505' });
								}
								return entity;
							}
						}); event('commit');
					} catch (error) {
						event('rollback'); throw error;
					}
				}
			},
			apNoteService: { extractEmojis: async () => [] }, apMfmService: { htmlToMfm: x => x },
			cacheService: {
				uriPersonCache: {
					set() {
						event('cache');
					}
				}
			},
			federatedInstanceService: {
				fetchOrRegister(host) {
					event('register.start', { host }); registerPending = true; return register.promise.then(() => {
						registerPending = false; event('register.resolved'); return { id: 'instance', host };
					});
				}
			},
			instancesRepository: {
				increment(criteria, field, amount) {
					event('increment.start', { criteria, field, amount }); incrementPending = true; return increment.promise.then(() => {
						incrementPending = false; event('increment.resolved');
					});
				}
			},
			instanceChart: {
				newUser(host) {
					event('instanceChart.double', { host });
				}
			}, fetchInstanceMetadataService: {
				fetchInstanceMetadata(i) {
					event('metadata.double', i);
				}
			},
			usersChart: {
				update() {
					event('usersChart.double');
				}
			}, hashtagService: {
				updateUsertags() {
					event('hashtags');
				}
			},
			resolveAvatarAndBanner: async () => ({}), updateFeatured: async () => { },
		};
		for (const name of ['validateActor', 'analyzeAttachments', 'isPublicCollection']) {
			ctx[name] = f[name].bind(ctx);
		}
		if (input.gate !== 'register') {
			register.resolve();
		}
		if (input.gate !== 'increment') {
			increment.resolve();
		}
		let result; let error;
		try {
			result = await f.createPerson.call(ctx, uri, resolver);
		} catch (e) {
			error = e.message;
		}
		event('actor.settled', { registerPending, incrementPending, ...(error ? { error } : {}) });
		register.resolve(); increment.resolve(); await register.promise; await increment.promise;
		return { id: result?.id ?? null, error: error ?? null };
	});
	const observed = cases.at(-1).expected;
	const ops = observed.events.map(e => e.op);
	const launch = !input.fail && !input.missing && input.stats;
	assert.equal(ops.includes('register.start'), !!launch);
	if (launch) {
		assert(ops.indexOf('register.start') > ops.indexOf(input.duplicate ? 'canonical' : 'commit'));
		assert(ops.indexOf('register.start') < ops.indexOf('hashtags'));
		assert(ops.indexOf('increment.start') < ops.indexOf('metadata.double'));
		assert(ops.indexOf('increment.start') < ops.indexOf('instanceChart.double'));
		if (input.gate === 'register') {
			assert(ops.indexOf('actor.settled') < ops.indexOf('increment.start'));
		}
		if (input.gate === 'increment') {
			assert(ops.indexOf('metadata.double') < ops.indexOf('increment.resolved'));
		}
		assert.equal(observed.events.find(e => e.op === 'register.start').args.host, input.origin ? 'origin.test' : 'remote.test');
	}
	if (input.gate) {
		assert.equal(observed.events.find(e => e.op === 'actor.settled').args[input.gate + 'Pending'], true);
	}
}
const result = { schemaVersion: 1, upstreamCommit, fullFileSha256, upstreamHttpMeasured: false, boundary: 'Pinned real createPerson and Utility methods plus actual validation/tag/truncate helpers. Repositories/transaction/transport/media/cache/charts/metadata are explicit doubles; no full HTTP/DB claim. Register and increment gates are separate.', methods, cases };
const target = new URL('./actor-instance-registration-observations.json', import.meta.url);
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2] === '--write') {
	writeFileSync(target, output);
} else {
	assert.equal(readFileSync(target, 'utf8'), output);
}
console.log(`actor instance source: ${cases.length} cases OK`);
