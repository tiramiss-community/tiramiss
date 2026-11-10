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

const upstreamCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to the pinned source checkout (regeneration only)');
assert(['--write', '--check'].includes(process.argv[2]), 'Use --write or --check');
const verifiedFiles = process.env.UPSTREAM_SOURCE_MODE === 'verified-files';
if (!verifiedFiles) execFileSync('git', ['-C', root, 'cat-file', '-e', `${upstreamCommit}^{commit}`]);
// Git blob IDs read from ls-tree at upstreamCommit; fallback verifies every source byte.
const pinnedBlobs = {
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
	if (!verifiedFiles) return execFileSync('git', ['-C', root, 'show', `${upstreamCommit}:${base}${path}`], { encoding: 'utf8' });
	const bytes = readFileSync(`${root}/${base}${path}`);
	const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
	assert.equal(blob, pinnedBlobs[path], `source differs from pin: ${path}`);
	return bytes.toString('utf8');
}
const require = createRequire(`${root}/package.json`);
const backendRequire = createRequire(`${root}/packages/backend/package.json`);
const ts = require('typescript');
const methods = {};
const files = new Map();
const base = 'packages/backend/src/';
function source(path) {
	if (!files.has(path)) files.set(path, ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true));
	return files.get(path);
}
function record(id, path, literal) {
	methods[id] = { path: base + path, sha256: createHash('sha256').update(literal).digest('hex') };
}
const now = 1800000000000;
class Clock extends Date {
	constructor(...args) { super(...(args.length ? args : [now])); }
	static now() { return now; }
}
class IdentifiableError extends Error { constructor(id, message) { super(message); this.id = id; } }
const globals = { URL, Date: Clock, Error, Buffer, AbortController, process: { env: { NODE_ENV: 'production' } },
	IdentifiableError,
	IsNull: () => null, chalk: { magenta: x => x, yellow: x => x }, nameLength: 128, summaryLength: 2048 };
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
for (const name of ['validateActor', 'createPerson', 'updatePerson', 'analyzeAttachments', 'isPublicCollection']) f[name] = method(personPath, 'ApPersonService', name);
const logger = { info() {}, error() {}, warn() {}, succ() {} };
const utilityService = {
	toPuny: x => new URL(`https://${x}`).hostname,
	punyHost: x => new URL(x).host,
	isUriLocal: x => x.startsWith('https://local.test/'),
	isSelfHost: x => x === 'local.test',
	extractDbHost: x => new URL(x).hostname,
	isFederationAllowedHost: x => x !== 'blocked.test',
};
const config = { host: 'local.test', url: 'https://local.test', userAgent: 'source-probe' };
// Preserve own undefined properties distinctly from absent keys and explicit null.
function plain(value) {
	if (value === undefined) return { $undefined: true };
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return Array.from(value, plain);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(k => [k, plain(value[k])]));
	return value;
}
const cases = [];
async function capture(id, input, run) {
	const savedInput = plain(input);
	const events = [];
	const event = (op, args) => events.push({ op, ...(args === undefined ? {} : { args: plain(args) }) });
	let expected;
	try { expected = { result: plain(await run(event)), events }; }
	catch (e) { expected = { error: { message: e.message, ...(e.id ? { id: e.id } : {}) }, events }; }
	cases.push({ id, provenance: 'literal-source-method', input: savedInput, expected });
	return cases.at(-1);
}
class MiUser { constructor(data) { Object.assign(this, data); } }
class MiUserProfile extends MiUser {}
class MiUserPublickey extends MiUser {}
Object.assign(globals, { MiUser, MiUserProfile, MiUserPublickey, isDuplicateKeyValueError: e => e.code === '23505' });
f.createPerson = method(personPath, 'ApPersonService', 'createPerson');
for (const input of [
	{ operation: 'create' }, { operation: 'create', duplicate: true },
	{ operation: 'create', fail: 'Profile' }, { operation: 'create', fail: 'Key' },
	{ operation: 'refresh' }, { operation: 'refresh', deleted: true },
	...['User', 'Key', 'Profile', 'Following'].map(fail => ({ operation: 'refresh', fail })),
]) {
	const id = `hashtags-${input.operation}-${input.duplicate ? 'duplicate' : input.deleted ? 'deleted' : input.fail ?? 'success'}`;
	await capture(id, input, async event => {
		const material = { type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', tag: [{ type: 'Hashtag', name: '#Ａ' }, { type: 'Hashtag', name: '#a' }], publicKey: { id: 'https://remote.test/key', publicKeyPem: 'test-key' } };
		// This is a new URI-entry read, not the account snapshot taken before WebFinger.
		const existing = { id: 'remote', host: 'remote.test', username: 'Original', uri: material.id, tags: ['uri-entry-old'], movedToUri: null, movedAt: null };
		const resolver = { resolve: async () => { event('actor.resolve'); return material; }, resolveCollection: async value => value };
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		let started = false;
		const update = name => async () => {
			event(name);
			if (input.fail === name) throw Error(`${name} write failed`);
			return { affected: input.deleted && name === 'User' ? 0 : 1 };
		};
		const ctx = { config, logger, utilityService, meta: {}, idService: { gen: () => 'new-user' },
			apResolverService: { createResolver: async () => resolver },
			fetchPerson: async uri => { event('entry.snapshot', { uri, tags: existing.tags }); return { ...existing, tags: [...existing.tags] }; },
			usersRepository: { update: input.operation === 'refresh' ? update('User') : update('media.stub.update'), findOneBy: async () => { event('canonical'); return existing; } },
			userProfilesRepository: { update: update('Profile') }, userPublickeysRepository: { update: update('Key') }, followingsRepository: { update: update('Following') },
			db: { transaction: async callback => {
				event('begin');
				try {
					await callback({ save: async entity => {
						const name = entity instanceof MiUserPublickey ? 'Key' : entity instanceof MiUserProfile ? 'Profile' : 'User';
						await update(name)();
						if (input.duplicate && name === 'User') throw Object.assign(Error('duplicate'), { code: '23505' });
						return entity;
					} }); event('commit');
				} catch (e) { event('rollback'); throw e; }
			} },
			apNoteService: { extractEmojis: async () => [] }, apMfmService: { htmlToMfm: x => x }, mfmService: { fromHtml: x => x },
			resolveAvatarAndBanner: async () => ({}), updateFeatured: async () => {}, cacheService: { uriPersonCache: { set() {} } }, usersChart: { update() {} },
			hashtagService: { updateUsertags(user, tags) { started = true; event('hashtags', { id: user.id, host: user.host, oldTags: user.tags, tags }); return gate; } },
			globalEventService: { publishInternalEvent() {} },
		};
		for (const name of ['validateActor', 'analyzeAttachments', 'isPublicCollection']) ctx[name] = f[name].bind(ctx);
		let error;
		try {
			await (input.operation === 'refresh' ? f.updatePerson.call(ctx, material.id, resolver) : f.createPerson.call(ctx, material.id, resolver));
		} catch (e) { error = e.message; }
		// Awaiting either source method above settled while the hashtag promise is still held.
		event('actor.settled', { hashtagStarted: started, hashtagPending: started, ...(error ? { error } : {}) });
		release();
		await gate;
		return { storedCanonicalTags: existing.tags };
	});
}
const result = { schemaVersion: 1, upstreamCommit, upstreamHttpMeasured: false, boundary: 'Literal pinned ApPersonService methods; repositories, actor transport, media, charts, cache, events and hashtag work are explicit doubles. No full HTTP/real DB claim. Pending hashtag gate proves caller settlement only.', methods, cases };
const target = new URL('./user-hashtags-observations.json', import.meta.url);
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2] === '--write') writeFileSync(target, output);
else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`actor hashtag source: ${cases.length} cases OK`);
