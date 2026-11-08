/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';

const upstreamCommit = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT;
assert(root, 'Set UPSTREAM_ROOT to the pinned source checkout (regeneration only)');
assert(['--write', '--check'].includes(process.argv[2]), 'Use --write or --check');
const verifiedFiles = process.env.UPSTREAM_SOURCE_MODE === 'verified-files';
if (!verifiedFiles) execFileSync('git', ['-C', root, 'cat-file', '-e', `${upstreamCommit}^{commit}`]);
// Git blob IDs read from ls-tree at upstreamCommit; fallback verifies every source byte.
const pinnedBlobs = {
  "core/HttpRequestService.ts": "f7c76f4705dbcb6b6082f1f3be6873d149a41d7a",
  "core/NoteCreateService.ts": "05e98541844d7f14e91263a78a03c9ec0139a89d",
  "core/RemoteUserResolveService.ts": "a2f1b73cdbd65d72a74aafe4ba125ea7cd3e890c",
  "core/WebfingerService.ts": "374536a7410113a0073d3ed95271d2a7f33dd412",
  "core/activitypub/ApRendererService.ts": "601edcebe931a2c98e1bf967debdbe8c91e508ad",
  "core/activitypub/ApRequestService.ts": "3eff199491c84654783574e41dbd5cf0a5bfd070",
  "core/activitypub/ApResolverService.ts": "0f51b1ce8d4fa8c6de2544fb758983b340ad76ca",
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
  "server/ActivityPubServerService.ts": "51b46a10c05f44a598a33938ef26ce12bbad2c59"
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
const htmlParser = backendRequire('node-html-parser');
const { RsaKeyPair, init } = backendRequire('slacc');
init(1);
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
	IdentifiableError, htmlParser, RsaKeyPair, promisify, createPublicKey,
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
globals.urlRegex = /^https?:\/\//;
globals.mRegex = /^([^@]+)@(.*)/;
globals.urlQuery = x => new URLSearchParams(x).toString(); // explicit URL-encoder double
const remotePath = 'core/RemoteUserResolveService.ts';
const personPath = 'core/activitypub/models/ApPersonService.ts';
const resolverPath = 'core/activitypub/ApResolverService.ts';
const requestPath = 'core/activitypub/ApRequestService.ts';
const rendererPath = 'core/activitypub/ApRendererService.ts';
const serverPath = 'server/ActivityPubServerService.ts';
const f = {};
for (const [path, klass, names] of [
	[remotePath, 'RemoteUserResolveService', ['resolveUser', 'resolveSelf']],
	['core/WebfingerService.ts', 'WebfingerService', ['webfinger', 'genUrl']],
	['core/NoteCreateService.ts', 'NoteCreateService', ['extractMentionedUsers']],
	[personPath, 'ApPersonService', ['validateActor', 'createPerson', 'updatePerson', 'analyzeAttachments', 'isPublicCollection']],
	[resolverPath, 'Resolver', ['resolve', 'resolveLocal']],
	[requestPath, 'ApRequestService', ['signedGet']],
	['core/HttpRequestService.ts', 'HttpRequestService', ['getActivityJson', 'send']],
	[rendererPath, 'ApRendererService', ['renderPerson', 'renderKey']],
	[serverPath, 'ActivityPubServerService', ['userInfo', 'setResponseType']],
]) for (const name of names) f[name] = method(path, klass, name);
const creator = source(requestPath).statements.find(s => ts.isClassDeclaration(s) && s.name.text === 'ApRequestCreator');
record('ApRequestCreator', requestPath, creator.getText(source(requestPath)));
globals.ApRequestCreator = evaluate(`(${creator.getText(source(requestPath)).replace(/^export /, '')})`);
const server = source(serverPath);
let negotiation;
function visit(node) {
	if (ts.isMethodDeclaration(node) && node.name?.getText(server) === 'deriveConstraint') negotiation = node;
	ts.forEachChild(node, visit);
}
visit(server);
record('ActivityPubServerService.deriveConstraint', serverPath, negotiation.getText(server));
globals.ACTIVITY_JSON = 'application/activity+json; charset=utf-8';
globals.LD_JSON = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8';
globals.accepts = backendRequire('accepts');
globals.vary = backendRequire('vary');
f.negotiate = evaluate(`(function(${negotiation.parameters.map(p => p.getText(server)).join(',')})${negotiation.body.getText(server)})`);
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
const doubles = {
	utility: 'UtilityService URL-based host/IDN normalization and local/blocked-host predicates supplied by harness; transitive UtilityService policy/DB logic is not executed.',
	logger: 'Logger methods discard diagnostics; diagnostic formatting is not compared.',
	db: 'In-memory Repository/EntityManager traces; constructor assigns fields, no Entity defaults, constraints or real rollback.',
	clock: `Fixed Date.now/new Date at ${now}.`,
	webfinger: 'JRD response/HTTP failure supplied by input; no peer network.',
	person: 'Transitive create/updatePerson result/failure in account resolver, not actor acquisition.',
	tokens: 'extractMentions returns supplied tokens; MFM parsing excluded.',
	actorServices: 'Media, emoji, featured, chart, instance, cache, hashtags, Move and events are explicit no-op/trace doubles; no compatibility PASS for these effects.',
	conversion: 'HTML-to-MFM and field HTML conversion return tagged input; full conversion excluded.',
	transport: 'fetch returns supplied response; timers recorded without waiting; agent/SSRF, network redirects, TLS and streaming limits excluded.',
	keys: 'Fixed public TEST RSA keypair; key repository returns it; real slacc signing and crypto SPKI export execute.',
	localFacts: 'Local user/profile reads and renderer ancillary media/tag inputs supplied; rich actor rendering excluded.',
	urlEncoder: 'WebFinger query uses URLSearchParams instead of transitive query helper (simple resources only).',
};
const cases = [];
async function capture(id, area, input, ids, boundaries, run) {
	const savedInput = plain(input);
	const events = [];
	const event = (op, args) => events.push({ op, ...(args === undefined ? {} : { args: plain(args) }) });
	let expected;
	try { expected = { result: plain(await run(event)), events }; }
	catch (e) { expected = { error: { message: e.message, ...(e.id ? { id: e.id } : {}) }, events }; }
	cases.push({ id, area, provenance: 'literal-source-method', methods: ids, input: savedInput, expected, doubles: [...new Set([...boundaries, 'logger', ...(area === 'resolve' || area === 'actor' || area === 'fetch' || area === 'publication' ? ['utility'] : [])])] });
	return cases.at(-1);
}
const rids = ['RemoteUserResolveService.resolveUser', 'RemoteUserResolveService.resolveSelf'];
async function account(id, input) {
	let row = input.age === undefined ? null : { id: 'remote', username: 'Alice', usernameLower: 'alice', host: 'remote.test', uri: 'https://remote.test/old', lastFetchedAt: input.age === null ? null : new Clock(now - input.age) };
	const c = await capture(id, 'resolve', input, rids, ['db', 'clock', 'webfinger', 'person'], async event => {
		const ctx = { config, logger, utilityService,
			usersRepository: {
				findOneBy: async query => { event('User.find', query); return query.host === null ? { id: 'local', host: null } : row; },
				update: async (query, patch) => { event('User.update', { query, patch }); if (input.writeFail === (patch.uri ? 'uri' : 'timestamp')) throw Error('repository write failed'); Object.assign(row, patch); },
			},
			webfingerService: { webfinger: async query => { event('WebFinger', query); if (input.webfingerFail) throw Error('offline'); return { links: input.links ?? [{ rel: 'SeLf', type: 'text/html', href: input.href ?? 'https://remote.test/new' }, { rel: 'self', href: 'https://ignored.test/u' }] }; } },
			apPersonService: {
				createPerson: async uri => { event('Person.create', uri); return { id: 'created', uri }; },
				updatePerson: async uri => { event('Person.update', uri); if (input.refreshFail) throw Error('refresh failed'); },
			},
			apDbResolverService: { parseUri: () => ({ local: true, type: 'users' }), getUserFromApId: async () => ({ id: 'local', host: null }) },
		};
		ctx.resolveSelf = f.resolveSelf.bind(ctx);
		const resolve = () => f.resolveUser.call(ctx, input.username ?? 'ALICE', input.host === undefined ? 'REMOTE.TEST' : input.host);
		if (input.followup) {
			let firstError; try { await resolve(); } catch (error) { firstError = error.message; }
			return { firstError, next: await resolve() };
		}
		return resolve();
	});
	c.expected.state = plain(row);
}
await account('resolve-local', { host: null });
await account('resolve-self-host', { host: 'LOCAL.TEST' });
await account('resolve-idn', { host: '例え.test' });
await account('resolve-cross-host-first-self', { href: 'https://other.test/u' });
await account('resolve-local-self-link', { href: 'https://local.test/users/l' });
await account('resolve-no-self', { links: [] });
for (const age of [0, 86400000, 86400001, null]) await account(`resolve-age-${age}`, { age });
await account('resolve-stale-refresh-failure', { age: 86400001, refreshFail: true });
await account('resolve-failed-refresh-next-fresh', { age: 86400001, refreshFail: true, followup: true });
await account('resolve-timestamp-write-failure', { age: null, writeFail: 'timestamp' });
await account('resolve-uri-write-failure', { age: null, writeFail: 'uri' });
await account('resolve-stale-webfinger-failure', { age: null, webfingerFail: true });
await account('resolve-stale-invalid-repair', { age: null, href: 'https://other.test/u' });
await capture('mentions-independent-duplicates', 'resolve', { tokens: ['alice', 'alice', 'alias', 'bob', 'alice'], outcomes: ['failure', 'alice', 'alice', 'bob', 'alice'], host: 'remote.test' }, ['NoteCreateService.extractMentionedUsers'], ['tokens', 'person'], async event => {
	globals.extractMentions = tokens => tokens.map(username => ({ username, host: null }));
	// Re-evaluate after installing the explicit token boundary.
	const extract = method('core/NoteCreateService.ts', 'NoteCreateService', 'extractMentionedUsers');
	let occurrence = 0;
	return extract.call({ remoteUserResolveService: { resolveUser: async (username, host) => {
		event('resolve', { username, host }); if (occurrence++ === 0) throw Error('offline'); return { id: username === 'alias' ? 'alice' : username };
	} } }, { host: 'remote.test' }, ['alice', 'alice', 'alias', 'bob', 'alice']);
});
for (const query of ['alice@remote.test', 'https://remote.test/@alice', 'invalid']) await capture(`webfinger-${query.includes('@remote') ? 'acct' : query.startsWith('http') ? 'url' : 'invalid'}`, 'resolve', { query }, ['WebfingerService.webfinger', 'WebfingerService.genUrl'], ['webfinger', 'urlEncoder'], async event => {
	const ctx = { httpRequestService: { getJson: async (...args) => { event('HTTP.getJson', args); return { links: [] }; } } };
	ctx.genUrl = f.genUrl.bind(ctx); return f.webfinger.call(ctx, query);
});
class MiUser { constructor(data) { Object.assign(this, data); } }
class MiUserProfile extends MiUser {}
class MiUserPublickey extends MiUser {}
Object.assign(globals, { MiUser, MiUserProfile, MiUserPublickey, isDuplicateKeyValueError: e => e.code === '23505' });
// Rebind methods with the Entity-constructor boundary in scope.
f.createPerson = method(personPath, 'ApPersonService', 'createPerson');
const actor = (patch = {}) => ({ type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', ...patch });
const aids = ['ApPersonService.validateActor', 'ApPersonService.createPerson', 'ApPersonService.updatePerson', 'ApPersonService.analyzeAttachments', 'ApPersonService.isPublicCollection'];
async function actorCase(id, input) {
	return capture(id, 'actor', input, [...aids, ...(input.collectionFail ? ['misc/status-error.ts'] : [])], ['db', 'clock', 'actorServices', 'conversion'], async event => {
		const material = actor(input.patch);
		const existing = { id: 'remote', username: 'Original', host: 'remote.test', uri: material.id, movedToUri: null, movedAt: null };
		const resolver = {
			resolve: async () => material,
			resolveCollection: async value => { if (input.collectionFail) throw new StatusError('collection unavailable', input.collectionFail); return value; },
		};
		const update = name => async (query, patch) => {
			event(`${name}.update`, { query, patch });
			if (input.fail === name) throw Error(`${name} write failed`);
			return { affected: (input.deleted && name === 'User') || (input.keyMissing && name === 'Key') ? 0 : 1 };
		};
		const ctx = { config, logger, utilityService, meta: {},
			idService: { gen: () => 'new-user' },
			apResolverService: { createResolver: async () => resolver }, fetchPerson: async () => existing,
			usersRepository: { update: update('User'), findOneBy: async query => { event('User.find', query); return input.duplicateMissing ? null : existing; } },
			userProfilesRepository: { update: update('Profile') }, userPublickeysRepository: { update: update('Key') }, followingsRepository: { update: update('Following') },
			db: { transaction: async callback => {
				event('transaction.begin');
				try {
					await callback({ save: async entity => {
						const name = entity instanceof MiUserPublickey ? 'Key' : entity instanceof MiUserProfile ? 'Profile' : 'User';
						event(`${name}.save`, entity);
						if (input.fail === name) throw Error(`${name} write failed`);
						if (input.duplicate && name === 'User') throw Object.assign(Error('duplicate'), { code: '23505' });
						return entity;
					} }); event('transaction.commit');
				} catch (e) { event('transaction.rollback'); throw e; }
			} },
			apNoteService: { extractEmojis: async () => [] },
			apMfmService: { htmlToMfm: x => `converted:${x}` }, mfmService: { fromHtml: x => `field:${x}` },
			resolveAvatarAndBanner: async () => ({}), updateFeatured: async () => {},
			cacheService: { uriPersonCache: { set() {} } }, usersChart: { update() {} }, hashtagService: { updateUsertags() {} },
			globalEventService: { publishInternalEvent() {} },
		};
		for (const name of ['validateActor', 'analyzeAttachments', 'isPublicCollection']) ctx[name] = f[name].bind(ctx);
		if (input.operation === 'validate') return ctx.validateActor(material, 'https://remote.test/request');
		if (input.operation === 'refresh') return f.updatePerson.call(ctx, material.id, resolver);
		return f.createPerson.call(ctx, 'https://remote.test/request', resolver);
	});
}
for (const type of ['Person', 'Service', 'Group', 'Organization', 'Application']) await actorCase(`actor-create-${type}`, { patch: { type } });
const key = { id: 'https://remote.test/users/a#key', publicKeyPem: 'test-key-material' };
const rich = { publicKey: key, name: 'N'.repeat(130), summary: 'S'.repeat(2050),
	manuallyApprovesFollowers: true, discoverable: false, isCat: true, requireSigninToViewContents: true,
	makeNotesFollowersOnlyBefore: '2026-01-01', makeNotesHiddenBefore: '2025-01-01',
	movedTo: undefined, alsoKnownAs: ['https://alias.test/u'],
	url: 'https://remote.test/@alice', endpoints: { sharedInbox: 'https://remote.test/shared' },
	following: { id: 'https://remote.test/following', type: 'Collection', items: [] }, followers: { id: 'https://remote.test/followers', type: 'OrderedCollection', orderedItems: [] },
	attachment: [{ type: 'PropertyValue', name: 'site', value: '<b>value</b>' }, { type: 'Note' }],
	'vcard:bday': '2000-01-02T00:00:00Z', 'vcard:Address': 'Somewhere', _misskey_followedMessage: 'hello',
	tag: [{ type: 'Hashtag', name: '#Example' }],
};
await actorCase('actor-create-object-attachment', { patch: { attachment: { type: 'PropertyValue', name: 'site', value: 'ignored' } } });
await actorCase('actor-create-profile-key', { patch: rich });
await actorCase('actor-refresh-profile-key', { operation: 'refresh', patch: rich });
await actorCase('actor-refresh-missing-key', { operation: 'refresh', patch: { publicKey: key }, keyMissing: true });
await actorCase('actor-refresh-defaults', { operation: 'refresh' });
await actorCase('actor-refresh-profile-failure', { operation: 'refresh', patch: { publicKey: key }, fail: 'Profile' });
await actorCase('actor-refresh-key-failure', { operation: 'refresh', patch: { publicKey: key }, fail: 'Key' });
await actorCase('actor-refresh-following-failure', { operation: 'refresh', fail: 'Following' });
await actorCase('actor-refresh-deleted', { operation: 'refresh', patch: { publicKey: key }, deleted: true });
await actorCase('actor-create-profile-failure', { fail: 'Profile' });
await actorCase('actor-create-duplicate-uri', { duplicate: true });
await actorCase('actor-create-duplicate-missing', { duplicate: true, duplicateMissing: true });
for (const operation of ['create', 'refresh']) {
	await actorCase(`actor-${operation}-foreign-url`, { operation, patch: { url: 'https://other.test/@a' } });
	await actorCase(`actor-${operation}-bad-scheme`, { operation, patch: { url: 'ftp://remote.test/a' } });
	await actorCase(`actor-${operation}-collection-transient`, { operation, patch: { following: 'https://remote.test/following' }, collectionFail: 503 });
	await actorCase(`actor-${operation}-collection-rate-limited`, { operation, patch: { following: 'https://remote.test/following' }, collectionFail: 429 });
	await actorCase(`actor-${operation}-collection-denied`, { operation, patch: { following: 'https://remote.test/following' }, collectionFail: 403 });
}
for (const [label, patch] of Object.entries({
	'bad-type': { type: 'Note' }, 'bad-id': { id: 'https://other.test/a' }, 'bad-inbox': { inbox: 'https://other.test/inbox' },
	'bad-username': { preferredUsername: '-invalid' }, 'bad-key-host': { publicKey: { id: 'https://other.test/key' } },
	'bad-key-id': { publicKey: { id: 1 } }, 'bad-followers': { followers: 'https://other.test/followers' },
	'foreign-shared': { endpoints: { sharedInbox: 'https://other.test/inbox' } }, 'empty-name': { name: '' },
	'bad-name': { name: 1 }, 'bad-summary': { summary: 1 }, 'missing-inbox': { inbox: undefined },
})) await actorCase(`actor-validation-${label}`, { operation: 'validate', patch });

// Replay the saved foreign-host input: regeneration must not serialize post-validation mutation.
const foreignShared = cases.find(c => c.id === 'actor-validation-foreign-shared');
const savedActor = actor(JSON.parse(JSON.stringify(foreignShared.input.patch)));
assert.deepEqual(plain(f.validateActor.call({ utilityService, logger }, savedActor, 'https://remote.test/request')),
	foreignShared.expected.result, 'saved foreign sharedInbox input must replay its own undefined outputs');

// Ephemeral signing keys never enter the serialized observation projection.
const generatedKeypair = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const keypair = { privateKey: generatedKeypair.privateKey, publicKey: generatedKeypair.publicKey };
// Public-only renderer input preserves the publication cases' existing SPKI projection.
const publicationKeypair = { publicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0WfHJp6pa3b43suvohW6\nCQ0IkKBDkJAbnLEvEWoeQZgQfdYiavxhxuxUNTaKCpnPlNs81OVnJl0Uz5q44NWq\nRHy+tFqQVuYAxtyJx5ODgXiCrtFEYCD4eb4z3JuMfHsjBKt6akvQYBi2crboTK3j\n8dpMN9kKGNHHRi1zSDkKWv3XboTy3b7KK+13BHW9S9Sn8mhwscsYLEz7iUqDUdkT\nJ6AJ01+GFDwDRTbYnEXrtZIQQ9Nwq0sWzzD38vxGprZttqGUTwFIe3DGmBSwmLr1\nZbuOoVmeubKEl+gonL2nq9MwIUISDugLhUp0tTYq9dno68JHVhR8iOiUWhtXnJPW\n0QIDAQAB\n-----END PUBLIC KEY-----\n" };
const activityContext = 'https://www.w3.org/ns/activitystreams';
async function fetchCase(id, input) {
	return capture(id, 'fetch', input, ['Resolver.resolve', 'ApRequestService.signedGet', 'ApRequestCreator', 'HttpRequestService.getActivityJson', 'HttpRequestService.send', 'core/activitypub/misc/check-against-url.ts', 'core/activitypub/misc/validator.ts'], ['transport', 'keys', 'clock', 'localFacts'], async event => {
		let requestIndex = 0;
		const fetch = async (url, options) => {
			const signature = options.headers.signature;
			const signingString = `(request-target): get ${new URL(url).pathname}${new URL(url).search}\ndate: ${new Clock().toUTCString()}\nhost: ${new URL(url).host}`;
			event('fetch', { url, method: options.method, size: options.size, headers: {
				...options.headers, ...(signature ? { signature: signature.replace(/signature="[^"]*"$/, 'signature="<verified separately>"') } : {}),
			}, signatureValid: signature ? verify('RSA-SHA256', Buffer.from(signingString), keypair.publicKey, Buffer.from(signature.match(/signature="([^"]+)"$/)[1], 'base64')) : null });
			const first = requestIndex++ === 0;
			const contentType = first && input.alternate ? 'text/html' : input.contentType ?? 'application/activity+json';
			const response = { ok: true, url: input.finalUrl ?? url,
				headers: { get: () => contentType },
				text: async () => `<html><head><link rel="alternate" type="application/activity+json" href="${input.alternate}"></head></html>`,
				json: async () => { event('response.json'); return { id: input.objectId ?? url, '@context': input.context ?? activityContext }; },
			};
			if (input.alternateFail && !first) throw Error('alternate unavailable');
			return response;
		};
		globals.fetch = fetch;
		globals.setTimeout = (_callback, timeout) => { event('timeout', timeout); };
		const send = method('core/HttpRequestService.ts', 'HttpRequestService', 'send');
		const http = { config, getAgentByUrl: () => { throw Error('agent must not be called by transport double'); } };
		http.send = send.bind(http); http.getActivityJson = f.getActivityJson.bind(http);
		const signed = { config, utilityService, userKeypairService: { getUserKeypair: async () => keypair }, httpRequestService: http };
		signed.signedGet = f.signedGet.bind(signed);
		const ctx = { logger, utilityService, history: new Set(input.repeated ? [input.url] : Array.from({ length: input.historySize ?? 0 }, (_, i) => `history:${i}`)), recursionLimit: 256,
			meta: { signToActivityPubGet: input.signed !== false },
			systemAccountService: { fetch: async name => { event('system.fetch', name); return { id: 'system' }; } },
			apRequestService: signed, httpRequestService: http,
			resolveLocal: async url => { event('local.resolve', url); return f.resolveLocal.call({ apDbResolverService: { parseUri: () => ({ local: true, type: 'users', id: 'local' }) }, usersRepository: { findOneByOrFail: async query => { event('User.localFind', query); return { id: 'local' }; } }, apRendererService: { renderPerson: async user => ({ id: url, userId: user.id }) } }, url); },
		};
		const result = await f.resolve.call(ctx, input.value ?? input.url ?? 'https://remote.test/a');
		if (input.second) return [result, await f.resolve.call(ctx, input.second)];
		return result;
	});
}
await fetchCase('fetch-signed', { url: 'https://remote.test/a' });
await fetchCase('fetch-lazy-signer', { url: 'https://remote.test/a', second: 'https://remote.test/b' });
await fetchCase('fetch-actual-repeat', { url: 'https://remote.test/a', second: 'https://remote.test/a' });
await fetchCase('fetch-unsigned', { url: 'https://remote.test/a', signed: false });
await fetchCase('fetch-alternate', { url: 'https://remote.test/a', alternate: 'https://remote.test/ap' });
await fetchCase('fetch-alternate-cross-host', { url: 'https://remote.test/a', alternate: 'https://other.test/ap' });
await fetchCase('fetch-alternate-relative', { url: 'https://remote.test/a', alternate: '/ap' });
await fetchCase('fetch-alternate-failure', { url: 'https://remote.test/a', alternate: 'https://remote.test/ap', alternateFail: true });
await fetchCase('fetch-unsigned-html', { signed: false, contentType: 'text/html' });
await fetchCase('fetch-ld-context', { contentType: `application/ld+json; profile="${activityContext}"`, context: [activityContext, {}] });
await fetchCase('fetch-invalid-context', { context: 'https://invalid.test/context' });
await fetchCase('fetch-json-content', { contentType: 'application/json' });
await fetchCase('fetch-www-normalization', { url: 'https://www.remote.test/a', finalUrl: 'https://remote.test/a', objectId: 'https://remote.test/a' });
await fetchCase('fetch-identity-mismatch', { url: 'https://remote.test/a', objectId: 'https://remote.test/b' });
await fetchCase('fetch-downgrade', { url: 'https://remote.test/a', finalUrl: 'http://remote.test/a' });
await fetchCase('fetch-fragment', { url: 'https://remote.test/a#key' });
await fetchCase('fetch-repeated', { url: 'https://remote.test/a', repeated: true });
await fetchCase('fetch-limit-256', { historySize: 256 });
await fetchCase('fetch-limit-257', { historySize: 257 });
await fetchCase('fetch-object-passthrough', { value: { type: 'Person' } });
await fetchCase('fetch-local', { url: 'https://local.test/users/l' });
await fetchCase('fetch-blocked', { url: 'https://blocked.test/a' });
let userRoute;
function findRoute(node) {
	if (ts.isCallExpression(node) && node.expression.getText(server) === 'fastify.get' && node.arguments[0]?.text === '/users/:user') userRoute = node.arguments.at(-1);
	ts.forEachChild(node, findRoute);
}
findRoute(server);
record('ActivityPubServerService.usersRoute', serverPath, userRoute.getText(server));
f.userRoute = evaluate(`(async function(${userRoute.parameters.map(p => p.getText(server)).join(',')})${userRoute.body.getText(server)})`);
const pids = ['ApRendererService.renderPerson', 'ApRendererService.renderKey', 'ActivityPubServerService.userInfo', 'ActivityPubServerService.setResponseType', 'ActivityPubServerService.deriveConstraint', 'ActivityPubServerService.usersRoute'];
async function publication(id, input) {
	await capture(id, 'publication', input, pids, ['keys', 'localFacts'], async event => {
		const user = { id: 'local', host: null, username: input.system ? 'instance.actor' : 'alice', name: null,
			isBot: input.bot ?? false, isLocked: true, isExplorable: false, tags: [], emojis: [], ...input.user };
		const renderer = { config,
			userEntityService: { genLocalUserUri: id => `${config.url}/users/${id}` },
			userProfilesRepository: { findOneByOrFail: async () => ({ fields: [], description: null }) },
			userKeypairService: { getUserKeypair: async () => publicationKeypair }, getEmojis: async () => [],
			renderIdenticon: () => null, renderSystemAvatar: () => null, renderSystemBanner: () => null,
		};
		renderer.renderKey = f.renderKey.bind(renderer);
		// Only consumed signer/identity fields are compared, after executing the complete literal renderer.
		renderer.renderPerson = async row => {
			const result = await f.renderPerson.call(renderer, row);
			return Object.fromEntries(['id', 'type', 'inbox', 'outbox', 'followers', 'following', 'sharedInbox', 'endpoints', 'url', 'preferredUsername', 'name', 'manuallyApprovesFollowers', 'discoverable', 'publicKey'].map(k => [k, result[k]]));
		};
		renderer.addContext = value => value; // context envelope is excluded, not a source observation
		const ctx = { config, utilityService, meta: { federation: input.federation ?? 'all' }, apRendererService: renderer,
			usersRepository: { findOneBy: async query => { event('User.find', query); return input.missing || (user.isSuspended && query.isSuspended === false) ? null : user; } },
		};
		ctx.userInfo = f.userInfo.bind(ctx); ctx.setResponseType = f.setResponseType.bind(ctx);
		const accept = input.accept ?? 'application/activity+json';
		const request = { headers: { accept }, params: { user: user.id }, accepts: () => globals.accepts({ headers: { accept } }) };
		const negotiation = f.negotiate({ headers: { accept } });
		event('negotiation', negotiation);
		const reply = { raw: { getHeader: () => undefined, setHeader: (name, value) => event('header', { name, value }) }, code: status => event('status', status), header: (name, value) => event('header', { name, value }), type: value => event('type', value), redirect: (uri, status) => event('redirect', { uri, status }) };
		if (negotiation !== 'ap') return { fallthrough: true };
		return f.userRoute.call(ctx, request, reply);
	});
}
await publication('publication-local', {});
await publication('publication-system', { system: true });
await publication('publication-bot', { bot: true });
await publication('publication-ld', { accept: 'application/ld+json' });
await publication('publication-html', { accept: 'text/html' });
await publication('publication-quality-html', { accept: 'application/activity+json;q=0.5,text/html;q=0.9' });
await publication('publication-quality-ap', { accept: 'application/activity+json;q=0.9,text/html;q=0.5' });
await publication('publication-none', { federation: 'none' });
await publication('publication-missing', { missing: true });
await publication('publication-suspended', { user: { isSuspended: true } });
await publication('publication-deleted', { user: { isDeleted: true } });
await publication('publication-remote', { user: { host: 'remote.test', uri: 'https://remote.test/u' } });
await publication('publication-remote-missing-uri', { user: { host: 'remote.test' } });
await publication('publication-remote-self-host', { user: { host: 'local.test', uri: 'https://local.test/u' } });
const bindings = {
	resolve: ['packages/backend-next/test/unit/federation/remote-user.test.ts', 'packages/backend-next/test/unit/note/create-note.test.ts'],
	actor: ['packages/backend-next/test/unit/federation/remote-actor.test.ts', 'packages/backend-next/test/integration/remote-user.test.ts'],
	fetch: ['packages/backend-next/test/unit/federation/activity-fetch.test.ts'],
	publication: ['packages/backend-next/test/unit/federation/local-actor.test.ts', 'packages/backend-next/test/integration/activitypub-actor.test.ts'],
};
// Fail loudly on broken harnesses rather than blessing ReferenceErrors as source failures.
for (const c of cases) assert(!/is not defined|is not a function|Cannot read properties/.test(c.expected.error?.message ?? ''), `${c.id}: ${c.expected.error?.message}`);
const data = { schemaVersion: 1, upstreamCommit, methods, bindings, doubles,
	exclusions: [
		'No upstream server HTTP or real DB evidence; transaction rollback is a double trace, not a PostgreSQL assertion.',
		'Emoji/media/hashtags, instance metadata/counts, charts, featured notes, Move, cache/events remain explicitly doubled; no rich actor compatibility claim.',
		'Local renderer projection only: context envelope, images, profile conversion and unrelated local objects excluded.',
		'HTTP responses are supplied: actual signature is computed/verified, but streaming limits, timeout enforcement, DNS/SSRF, redirects and TLS are not measured.',
		'Consumer bindings are declarations for Task 2; Task 3 must establish actual test consumers and runtime comparisons.',
	], cases };
const target = new URL('./observations.json', import.meta.url);
const serialized = `${JSON.stringify(data, null, 2)}\n`;
if (process.argv[2] === '--write') writeFileSync(target, serialized);
else assert.equal(readFileSync(target, 'utf8'), serialized, 'source observations changed; inspect per-case projections');
console.log(`${process.argv[2]}: ${cases.length} source-method cases; ${verifiedFiles ? 'pinned blob-verified files' : 'pinned git objects'}`);
