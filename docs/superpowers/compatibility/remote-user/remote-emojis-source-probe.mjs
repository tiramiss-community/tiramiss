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
	"core/activitypub/models/ApNoteService.ts": "1835c1d49571b0e6d432df37d75269c60f7a892c",
	"core/activitypub/models/tag.ts": "f75cc45f7e4f714709261d3daa761c3ed605c7e6",
	"core/activitypub/type.ts": "99668813a4cb9ae65cd33e51fb2faca0bbb1f7b2",
	"misc/check-https.ts": "15a54f6ce7e2f6ce7809e4d12a4294f005a93166",
	"misc/normalize-for-search.ts": "3f19617e1480f14167f980f2bec85fd3438fd7c1",
	"misc/prelude/array.ts": "f741a0c9133911688727cd72499b7476e3783a56",
	"misc/status-error.ts": "c3533db60759a0f82ca7ee82772b89899e5cc942",
	"misc/truncate.ts": "1c8a274609a122aa16521b22ac76618938ebc354",
	"models/_.ts": "c4528e3a7731c98e90d99e9ed5f1a3a78523263b"
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
	"core/activitypub/misc/check-against-url.ts": "5d97319a42d8628455c1a0e041682ad99d62967f6a2cdbefda24e7ec885a117f",
	"core/activitypub/misc/validator.ts": "97bdbeb67557dfadb0135126fff1eb408756f039ebf7057fd87ff67a89f6da21",
	"core/activitypub/models/ApPersonService.ts": "471168b426b6ec19294b345bd0f66ac1c46fd554475c7c396bdbd9d859624921",
	"core/activitypub/models/ApNoteService.ts": "ae6d5ceaf20d13e167cba82b7a418e51c5e30b51f66f553d72c3f39c4257d12f",
	"core/activitypub/models/tag.ts": "33aa8fa4002cdfe1d8333bc15a4cfa7a0bf6761ba6690f5becb25b9726afc874",
	"core/activitypub/type.ts": "ac649470214b7c03e8f72c599f091c3f765eafcefca933c0f85112fd2d69a8ef",
	"misc/check-https.ts": "2b631d396e4094749cc1513f652ba5681530a4038d8ea38cc4445fbd0c4666ef",
	"misc/normalize-for-search.ts": "cf40aaf03e5a13d69abd4966256c2cb44ee29c7b7bd038b04271e35ffb150ca6",
	"misc/prelude/array.ts": "8319bf6a858b2afb934e50595798c2d914388c077d6bf49a2338a5f0520bcdc4",
	"misc/status-error.ts": "81df1c128374e740d337e4b8167d1eca5cf62083a23005be68c5277aceacb49a",
	"misc/truncate.ts": "4922b83959680d550af043fd0f2ee37c9ed911393c2367f70bc835a0ffd95ebc",
	"models/_.ts": "03554499d5eb569d3267040967d67959d1b1072abed11cd016094f6510032b26"
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
	"ApPersonService.updatePerson": "7a4865aa70d7ce75bb8ad762b35ebf52cedd8570ecbb09c7b63b74a1bed1ee7c",
	"ApPersonService.analyzeAttachments": "9c2bb9f0d0765fe963458fb7cc3432e91626a5b62bf9f367a5b516667a040658",
	"ApPersonService.isPublicCollection": "04640fbd0ef0f2a9cc68a133f7e2cf7c6dd5b2b68d94bedc87c1dd55d64f1973",
	"ApNoteService.extractEmojis": "f49064cf735191cb5f77bba3f8c17f58b944876e6525703d64650d86182c2d64",
	"miRepository.insertOne": "d43e5881e1ef3229c20e51a4570b9a956babba72a219c43e3dfa13f0b9d2b7a8"
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
	URL, Date: Clock, Error, Buffer, AbortController, In: names => ({ in: names }), process: { env: { NODE_ENV: 'production' } },
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
for (const name of ['validateActor', 'createPerson', 'updatePerson', 'analyzeAttachments', 'isPublicCollection']) {
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

const extract = method('core/activitypub/models/ApNoteService.ts', 'ApNoteService', 'extractEmojis');
const repoSource = source('models/_.ts');
const repoDeclaration = repoSource.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations).find(d => d.name.getText(repoSource) === 'miRepository');
const insertNode = repoDeclaration.initializer.expression.properties.find(p => p.name.getText(repoSource) === 'insertOne');
record('miRepository.insertOne', 'models/_.ts', insertNode.getText(repoSource));
assert.equal(methods['miRepository.insertOne'].sha256, expectedMethodSha256['miRepository.insertOne']);
const insertOne = evaluate(`(async function(${insertNode.parameters.map(p => p.getText(repoSource)).join(',')})${insertNode.body.getText(repoSource)})`);
class MiUser { constructor(data) { Object.assign(this, data); } }
class MiUserProfile extends MiUser { }
class MiUserPublickey extends MiUser { }
Object.assign(globals, { MiUser, MiUserProfile, MiUserPublickey, isDuplicateKeyValueError: e => e.code === '23505' });
f.createPerson = method(personPath, 'ApPersonService', 'createPerson');
const cases = [];
const emoji = (patch = {}) => ({ type: 'Emoji', name: ':wave:', id: 'https://remote.test/emoji/wave', updated: '2026-01-01', icon: { url: 'https://remote.test/wave.png' }, ...patch });
const stored = (patch = {}) => ({ id: 'stored', host: 'remote.test', name: 'wave', uri: 'https://remote.test/emoji/wave', originalUrl: 'https://remote.test/wave.png', publicUrl: 'https://cache.test/wave', updatedAt: new Date('2026-02-01'), aliases: ['alias'], license: 'old', ...patch });
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function repository(input, event) {
	const rows = structuredClone(input.rows ?? []);
	const held = gate(); const entered = gate();
	const repo = {
		async findBy(query) { event('find', { host: query.host, names: query.name.in }); if (input.fail === 'query') { throw Error('query failed'); } return structuredClone(rows.filter(r => r.host === query.host && query.name.in.includes(r.name))); },
		async update(query, patch) { event('update', { ...query, patch }); if (input.fail === 'update') { throw Error('update failed'); } const row = rows.find(r => r.host === query.host && r.name === query.name); for (const [k, v] of Object.entries(patch)) { if (v !== undefined) { row[k] = v; } } },
		async findOneBy(query) { event('refetch', query); if (input.fail === 'update-refetch') { return null; } return structuredClone(rows.find(r => r.host === query.host && r.name === query.name) ?? null); },
		async insert(row) {
			event('insert.start', row);
			if (input.gate === row.name) { entered.resolve(); await held.promise; }
			if (input.fail === 'insert' || input.failName === row.name) { throw Error('insert failed'); }
			if (rows.some(r => r.host === row.host && r.name === row.name)) { throw Object.assign(Error('duplicate emoji'), { code: '23505' }); }
			rows.push({ uri: null, ...row }); event('insert.done', { name: row.name }); return { identifiers: [{ id: row.id }] };
		},
		async findOneOrFail({ where }) { event('insert.refetch', where); if (input.fail === 'insert-refetch') { throw Error('insert refetch failed'); } return structuredClone(rows.find(r => r.id === where.id)); },
	};
	repo.insertOne = insertOne.bind(repo);
	return { repo, rows, held, entered };
}
async function capture(id, area, input) {
	const saved = plain(input); const events = [];
	const event = (op, args) => events.push({ op, ...(args === undefined ? {} : { args: plain(args) }) });
	const state = repository(input, event); let nextId = 0;
	const extractContext = { emojisRepository: state.repo, utilityService, logger, idService: { gen: () => { const id = `emoji-${++nextId}`; event('id', id); return id; } } };
	let result; let error;
	if (area === 'extract') {
		const work = extract.call(extractContext, structuredClone(input.tags), input.host ?? 'remote.test');
		if (input.gate) {
			await state.entered.promise;
			if (input.failName) { try { await work; } catch (e) { error = { name: e.name, message: e.message }; } event('response', { rows: plain(state.rows) }); }
			state.held.resolve();
		}
		try { result = await work; } catch (e) { error = { name: e.name, message: e.message }; }
	} else {
		const material = { type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', tag: [emoji()], ...input.patch };
		const canonical = { id: 'remote', username: 'Original', host: input.entryHost ?? 'remote.test', uri: material.id, movedToUri: null, movedAt: null, emojis: ['retained'], tags: [] };
		const resolver = { resolve: async () => material, resolveCollection: async value => { event('collection'); return value; } };
		const update = name => async (_query, patch) => { event(`${name}.update`, name === 'User' ? { emojis: patch.emojis } : undefined); return { affected: input.deleted && name === 'User' ? 0 : 1 }; };
		const ctx = {
			config, logger, utilityService, meta: {}, idService: { gen: () => { event('actor.id'); return 'new-user'; } },
			fetchPerson: async () => canonical, apResolverService: { createResolver: async () => resolver },
			apNoteService: { extractEmojis: (tags, host) => { event('extract', { host }); return extract.call(extractContext, tags, host); } },
			usersRepository: { update: update('User'), findOneBy: async () => { event('canonical'); return canonical; } }, userProfilesRepository: { update: update('Profile') }, userPublickeysRepository: { update: update('Key') }, followingsRepository: { update: update('Following') },
			db: {
				transaction: async callback => {
					event('transaction.begin'); try {
						await callback({
							save: async entity => {
								const kind = entity instanceof MiUserPublickey ? 'Key' : entity instanceof MiUserProfile ? 'Profile' : 'User'; event(`${kind}.save`, kind === 'User' ? { emojis: entity.emojis } : undefined);
								if (input.actorFail === kind) { throw Error(`${kind} failed`); }
								if (input.duplicate && kind === 'User') { throw Object.assign(Error('duplicate'), { code: '23505' }); } return entity;
							}
						}); event('transaction.commit');
					} catch (e) { event('transaction.rollback'); throw e; }
				}
			},
			apMfmService: { htmlToMfm: x => x }, mfmService: { fromHtml: x => x }, resolveAvatarAndBanner: async () => ({}), updateFeatured: async () => { },
			cacheService: { uriPersonCache: { set() { } } }, usersChart: { update() { } }, hashtagService: { updateUsertags() { } }, globalEventService: { publishInternalEvent() { } },
		};
		for (const name of ['validateActor', 'analyzeAttachments', 'isPublicCollection']) { ctx[name] = f[name].bind(ctx); }
		try { const value = await f[area === 'refresh' ? 'updatePerson' : 'createPerson'].call(ctx, 'https://remote.test/users/a', resolver); result = area === 'refresh' ? value : { id: value.id, emojis: value.emojis }; } catch (e) { error = { name: e.name, message: e.message }; }
	}
	// Allow source's already-started operations to settle for recording, after the response marker.
	await Promise.resolve(); await Promise.resolve();
	cases.push({ id, area, input: saved, expected: { ...(error ? { error } : { result: plain(result) }), events, rows: plain(state.rows) } });
}
for (const [id, input] of Object.entries({
	new: { tags: emoji() }, empty: { tags: [] }, absent: {},
	punycode: { host: '例え.テスト', tags: emoji({ name: ':w:a:ve:' }) }, port: { host: 'REMOTE.test:8080', tags: emoji() },
	unchanged: { rows: [stored()], tags: emoji() },
	'updated-null': { rows: [stored({ updatedAt: null })], tags: emoji() },
	'uri-null': { rows: [stored({ uri: null })], tags: emoji() },
	newer: { rows: [stored()], tags: emoji({ updated: '2026-03-01' }) },
	url: { rows: [stored()], tags: emoji({ icon: { url: 'https://remote.test/next.png' } }) },
	'license-only': { rows: [stored()], tags: emoji({ _misskey_license: { freeText: 'new' } }) },
	'id-only': { rows: [stored()], tags: emoji({ id: 'https://remote.test/other' }) },
	'public-url-only': { rows: [stored({ publicUrl: 'https://other.test/public' })], tags: emoji() },
	'undefined-uri': { rows: [stored({ updatedAt: null })], tags: emoji({ id: undefined }) },
	'null-uri': { rows: [stored({ updatedAt: null })], tags: emoji({ id: null }) },
	'license-null': { tags: emoji({ _misskey_license: { freeText: null } }) },
	'license-malformed': { tags: emoji({ _misskey_license: 'text' }) },
	'license-empty': { tags: emoji({ _misskey_license: { freeText: '' } }) },
	'type-first': { tags: emoji({ type: ['Emoji', 'Other'] }) }, 'type-second': { tags: emoji({ type: ['Other', 'Emoji'] }) },
	'icon-array': { tags: emoji({ icon: [{ url: 'https://remote.test/a' }] }) },
	'icon-missing': { tags: emoji({ icon: undefined }) }, 'icon-null': { tags: emoji({ icon: null }) },
	'icon-url-null': { tags: emoji({ icon: { url: null } }) }, 'name-missing': { tags: emoji({ name: undefined }) },
	'name-number': { tags: emoji({ name: 1 }) }, 'null-tag': { tags: [null] }, 'string-tag': { tags: ['Emoji'] },
	'duplicate-existing': { rows: [stored()], tags: [emoji(), emoji()] },
	'duplicate-new': { tags: [emoji(), emoji()] },
	'query-fail': { tags: [emoji()], fail: 'query' },
	'update-fail': { rows: [stored({ updatedAt: null })], tags: emoji(), fail: 'update' },
	'update-refetch-fail': { rows: [stored({ updatedAt: null })], tags: emoji(), fail: 'update-refetch' },
	'insert-fail': { tags: emoji(), fail: 'insert' }, 'insert-refetch-fail': { tags: emoji(), fail: 'insert-refetch' },
	'parallel-order': { tags: [emoji(), emoji({ name: ':other:' })], gate: 'wave' },
	'early-rejection': { tags: [emoji(), emoji({ name: ':other:' })], failName: 'other', gate: 'wave' },
})) { await capture(id, 'extract', input); }
for (const area of ['create', 'refresh']) {
	for (const [id, input] of Object.entries({
		success: {}, 'query-fail': { fail: 'query' }, 'bad-url': { patch: { url: 'ftp://remote.test/a' } },
		'bad-birthday': { patch: { 'vcard:bday': 17 } }, 'bad-attachment': { patch: { attachment: [null] } },
		'bad-tag': { patch: { tag: [null] } }, collection: { patch: { following: { type: 'Collection', id: 'https://remote.test/following', items: [] } } },
	})) { await capture(`${area}-${id}`, area, input); }
}
await capture('create-rollback', 'create', { actorFail: 'Profile' });
await capture('create-canonical', 'create', { duplicate: true });
await capture('refresh-deleted', 'refresh', { deleted: true });
await capture('refresh-entry-host', 'refresh', { entryHost: 'ENTRY.test' });
const get = id => cases.find(c => c.id === id).expected;
assert.equal(get('new').result[0].name, 'wave');
assert.equal(get('duplicate-existing').result.length, 2);
assert(get('duplicate-new').error); assert.equal(get('duplicate-new').rows.length, 1);
assert.deepEqual(get('parallel-order').result.map(r => r.name), ['wave', 'other']);
assert.equal(get('early-rejection').events.find(e => e.op === 'response').args.rows.length, 0);
assert.equal(get('early-rejection').rows[0].name, 'wave');
assert.equal(get('create-bad-url').rows.length, 0); assert.equal(get('refresh-bad-url').rows.length, 1);
assert.equal(get('create-canonical').result.emojis[0], 'retained');
assert.equal(get('create-rollback').rows.length, 1); assert.equal(get('refresh-deleted').rows.length, 1);
const result = {
	schemaVersion: 1, upstreamCommit, fullFileSha256, methods, upstreamHttpMeasured: false,
	boundary: 'Real pinned extractEmojis, insertOne, predicates/helpers and createPerson/updatePerson. Repository/clock/ID/transport/transaction/media/cache/charts/featured doubles; source transaction is not real DB proof.', cases
};
const target = new URL('./remote-emojis-observations.json', import.meta.url);
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2] === '--write') { writeFileSync(target, output); } else { assert.equal(readFileSync(target, 'utf8'), output); }
console.log(`remote emoji source: ${cases.length} cases OK`);
