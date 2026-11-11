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
	"models/UserProfile.ts": "4bef1de617d8eb773e24545da3ecfa09c5ccb1f0",
	"core/MfmService.ts": "274966d9213a6a05dcb4167e0ab59b95fc984580",
	"core/activitypub/ApMfmService.ts": "a928ed5ccf7ec0e2425690e9ced6bec543c6f4ea",

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
	"models/UserProfile.ts": "afd7f32c99016cdd613a90b066570079db140d88a62f096267daea20ef2126ba",
	"core/MfmService.ts": "494918ebbe07f3e1850f923df5f57fffdb3241c35a08066efe417e542496b6c0",
	"core/activitypub/ApMfmService.ts": "d9efe129fff0ceffc711b4aed2f46ea34e2bd42ff45558b6c813211aac53acc4",

	"core/UtilityService.ts": "99f8779e002fc2c0aa2cd203613d31fcc87e7eaeb797ef65aae6c5175b62e331",
	"core/activitypub/misc/check-against-url.ts": "5d97319a42d8628455c1a0e041682ad99d62967f6a2cdbefda24e7ec885a117f",
	"core/activitypub/misc/validator.ts": "97bdbeb67557dfadb0135126fff1eb408756f039ebf7057fd87ff67a89f6da21",
	"core/activitypub/models/ApPersonService.ts": "471168b426b6ec19294b345bd0f66ac1c46fd554475c7c396bdbd9d859624921",
	"core/activitypub/models/tag.ts": "33aa8fa4002cdfe1d8333bc15a4cfa7a0bf6761ba6690f5becb25b9726afc874",
	"core/activitypub/type.ts": "ac649470214b7c03e8f72c599f091c3f765eafcefca933c0f85112fd2d69a8ef",
	"misc/check-https.ts": "2b631d396e4094749cc1513f652ba5681530a4038d8ea38cc4445fbd0c4666ef",
	"misc/normalize-for-search.ts": "cf40aaf03e5a13d69abd4966256c2cb44ee29c7b7bd038b04271e35ffb150ca6",
	"misc/prelude/array.ts": "8319bf6a858b2afb934e50595798c2d914388c077d6bf49a2338a5f0520bcdc4",
	"misc/status-error.ts": "81df1c128374e740d337e4b8167d1eca5cf62083a23005be68c5277aceacb49a",
	"misc/truncate.ts": "4922b83959680d550af043fd0f2ee37c9ed911393c2367f70bc835a0ffd95ebc",
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
	if (expectedMethodSha256[id]) assert.equal(methods[id].sha256, expectedMethodSha256[id], `method binding: ${id}`);
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

// The observed path uses upstream's installed real parser and literal converter bodies.
globals.htmlParser = backendRequire('node-html-parser');
for (const statement of source('core/MfmService.ts').statements) {
 if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => ['urlRegex', 'urlRegexFull'].includes(d.name.getText()))) {
  const literal = statement.getText(); record(statement.declarationList.declarations[0].name.getText(), 'core/MfmService.ts', literal);
  Object.assign(globals, evaluate(`(() => { ${literal}; return { ${statement.declarationList.declarations[0].name.getText()} }; })()`));
 }
}
const mfmService = { fromHtml: method('core/MfmService.ts', 'MfmService', 'fromHtml') };
const apMfmService = { htmlToMfm: method('core/activitypub/ApMfmService.ts', 'ApMfmService', 'htmlToMfm'), mfmService };
class MiUser { constructor(data) { Object.assign(this, data); } }
class MiUserProfile extends MiUser { }
class MiUserPublickey extends MiUser { }
Object.assign(globals, { MiUser, MiUserProfile, MiUserPublickey, isDuplicateKeyValueError: e => e.code === '23505' });
const profileFile = source('models/UserProfile.ts');
const profileClass = profileFile.statements.find(s => ts.isClassDeclaration(s) && s.name.text === 'MiUserProfile');
const description = profileClass.members.find(m => m.name?.getText(profileFile) === 'description');
record('MiUserProfile.description', 'models/UserProfile.ts', description.getText(profileFile));
const column = ts.getDecorators(description).find(d => d.expression.expression.getText(profileFile) === 'Column');
const descriptionMaxCharacters = evaluate(`(${column.expression.arguments[1].getText(profileFile)})`).length;
assert.equal(descriptionMaxCharacters, 2048);
const cases = [];
async function capture(id, area, input) {
 const saved = plain(input); const events = [];
 const event = (op, args) => events.push({ op, ...(args === undefined ? {} : { args: plain(args) }) });
 let result; let error;
 try {
  if (area === 'html') result = mfmService.fromHtml(input.html, input.hashtagNames);
  else if (area === 'attachment') result = f.analyzeAttachments.call({ mfmService }, input.attachment);
  else {
   const person = { type: 'Person', id: 'https://remote.test/users/a', preferredUsername: 'Alice', inbox: 'https://remote.test/inbox', ...structuredClone(input.patch) };
   const canonical = { id: 'remote', username: 'Original', host: 'remote.test', uri: person.id, movedToUri: null, movedAt: null, emojis: [], tags: [] };
   const resolver = { resolve: async () => person, resolveCollection: async value => { event('collection'); return value; } };
   const update = kind => async (_query, patch) => {
    event(`${kind}.update`, patch);
    if (input.fail === kind) throw Error(`${kind} failed`);
    return { affected: 1 };
   };
   const ctx = {
    config, logger, utilityService, meta: {}, idService: { gen: () => 'new-user' },
    fetchPerson: async () => canonical, apResolverService: { createResolver: async () => resolver },
    apNoteService: { extractEmojis: async () => { event('emoji'); return []; } },
    usersRepository: { update: update('User'), findOneBy: async () => { event('canonical'); return canonical; } },
    userProfilesRepository: { update: update('Profile') }, userPublickeysRepository: { update: update('Key') }, followingsRepository: { update: update('Following') },
    db: { transaction: async callback => {
     event('transaction.begin');
     try {
      await callback({ save: async entity => {
       const kind = entity instanceof MiUserPublickey ? 'Key' : entity instanceof MiUserProfile ? 'Profile' : 'User'; event(`${kind}.save`, entity);
       if (input.fail === kind) throw Error(`${kind} failed`);
       if (input.duplicate && kind === 'User') throw Object.assign(Error('duplicate'), { code: '23505' });
       return entity;
      } }); event('transaction.commit');
     } catch (e) { event('transaction.rollback'); throw e; }
    } },
    apMfmService, mfmService, resolveAvatarAndBanner: async () => ({}), updateFeatured: async () => {},
    cacheService: { uriPersonCache: { set() {} } }, usersChart: { update() {} },
    hashtagService: { updateUsertags() { event('hashtags'); } }, globalEventService: { publishInternalEvent() {} },
   };
   for (const name of ['validateActor', 'analyzeAttachments', 'isPublicCollection']) ctx[name] = f[name].bind(ctx);
   const value = await f[area === 'refresh' ? 'updatePerson' : 'createPerson'].call(ctx, person.id, resolver);
   result = area === 'refresh' ? value : { id: value.id };
  }
 } catch (e) { error = { name: e.name, message: e.message }; }
 await Promise.resolve(); await Promise.resolve();
 cases.push({ id, area, provenance: 'literal-source-method', methods: area === 'html' ? ['MfmService.fromHtml', 'misc/normalize-for-search.ts', 'urlRegex', 'urlRegexFull'] : area === 'attachment' ? ['ApPersonService.analyzeAttachments', 'core/activitypub/type.ts', 'MfmService.fromHtml'] : ['ApPersonService.' + (area === 'refresh' ? 'updatePerson' : 'createPerson'), 'ApPersonService.validateActor', 'ApPersonService.analyzeAttachments', 'ApMfmService.htmlToMfm', 'MfmService.fromHtml', 'core/activitypub/models/tag.ts', 'core/activitypub/type.ts', 'misc/normalize-for-search.ts', 'misc/truncate.ts'], doubles: ['html', 'attachment'].includes(area) ? [] : ['repositories', 'transaction', 'transport', 'clock', 'emoji', 'external-effects'], input: saved, expected: { ...(error ? { error } : { result: plain(result) }), events } });
}
const htmlCases = {
 formatting: '<h1>Title</h1><p><b>bold</b> <strong>strong</strong> <i>italic</i> <em>em</em> <s>strike</s> <small>small</small></p>',
 breaks: 'a<br>\nb<br />\r\nc<br>d',
 ruby: '<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp>字<rt>じ</rt></ruby>',
 'ruby-space-fallback': '<ruby>漢<rt>two words</rt></ruby>',
 'ruby-element-fallback': '<ruby><b>漢</b><rt>かん</rt></ruby>',
 code: '<p><code>a &lt; b</code></p><pre><code>x\ny</code></pre>',
 'pre-plain': '<pre>plain\ntext</pre>',
 blockquote: '<blockquote>one<br>two</blockquote><p>end</p>',
 entities: '&amp; &lt; &gt; &quot; &apos; &#x1F600; &nbsp;',
 blocks: '<div>a</div><ul><li>b</li><li>c</li></ul><h2>d</h2>',
 comments: '<!--comment--><!doctype html><span>text</span>',
 malformed: '<p>first<b>open<p>second &amp;',
 mention: '<a href="https://remote.test/@alice">@alice</a>',
 'mention-full': '<a href="https://remote.test/@alice">@alice@else.test</a>',
 'mention-me': '<a rel="me " href="https://remote.test/@alice">@alice</a>',
 'mention-me-exact': '<a rel="me" href="https://remote.test/@alice">@alice</a>',
 'mention-no-href': '<a>@alice</a>',
 'empty-links': '<a></a><a href="https://remote.test/a"></a><a>text</a>',
 links: '<a href="https://remote.test/a">https://remote.test/a</a> <a href="https://remote.test/日本">日本</a>',
 'invalid-url': '<a href="not-a-url">@a</a>',
};
for (const [id, html] of Object.entries(htmlCases)) await capture(`html-${id}`, 'html', { html });
const hashtag = { type: 'Hashtag', name: '#ＦＯＯ' };
const linkedTag = '<a href="https://remote.test/tags/foo">#foo</a>';
for (const [id, input] of Object.entries({
 empty: {}, plain: { patch: { summary: '<p>Hello <b>peer</b></p>' } },
 override: { patch: { summary: '<b>ignored</b>', _misskey_summary: '**native**' } },
 'empty-override': { patch: { summary: '<b>fallback</b>', _misskey_summary: '' } },
 'empty-summary': { patch: { summary: '' } },
 'limit-2048': { patch: { summary: 'a'.repeat(2048) } },
 'limit-2049': { patch: { summary: 'a'.repeat(2048) + 'X' } },
 unicode: { patch: { summary: '😀'.repeat(2048) + 'X' } },
 'truncated-html': { patch: { summary: 'a'.repeat(2045) + '<b>tail</b>' } },
 'expanded-html': { patch: { summary: '<b>'.repeat(600) + 'x' } },
 'override-limit': { patch: { _misskey_summary: '😀'.repeat(2048) + 'X' } },
 'tag-single': { patch: { summary: linkedTag, tag: hashtag } },
 'tag-array': { patch: { summary: linkedTag, tag: [{ type: ['Hashtag', 'Other'], name: '#FOO' }] } },
 'tag-unknown': { patch: { summary: linkedTag, tag: { type: 'Hashtag', name: '#bar' } } },
 fields: { patch: { summary: linkedTag, tag: hashtag, attachment: [{ type: 'PropertyValue', name: 'tag', value: linkedTag }, { type: ['PropertyValue', 'Other'], name: 'ruby', value: htmlCases.ruby }] } },
 'bad-summary': { patch: { summary: htmlCases['invalid-url'], publicKey: { id: 'https://remote.test/users/a#key', publicKeyPem: 'new' } } },
 'bad-summary-type': { patch: { summary: 17 } },
 'bad-tag': { patch: { summary: linkedTag, tag: [null] } },
 'attachment-priority': { patch: { attachment: [{ type: 'PropertyValue', name: 'site', value: htmlCases['invalid-url'] }, null] } },
 'attachment-conversion': { patch: { attachment: [{ type: 'PropertyValue', name: 'site', value: htmlCases['invalid-url'] }] } },
 'profile-write': { fail: 'Profile', patch: { summary: '<b>new</b>', publicKey: { id: 'https://remote.test/users/a#key', publicKeyPem: 'new' } } },
})) {
 for (const area of ['create', 'refresh']) await capture(`${area}-${id}`, area, input);
}
for (const [id, attachment] of Object.entries({
 singleton: { type: 'PropertyValue', name: 'ignored', value: '<b>x</b>' },
 absent: undefined, empty: [],
 guards: [{ type: 'Other', name: 'ignored', value: '<b>x</b>' }, { type: 'PropertyValue', name: 1, value: 'ignored' }, { type: 'PropertyValue', name: 'ignored', value: 1 }, { type: 'PropertyValue', name: '', value: '' }, { type: 'PropertyValue', name: 'first', value: '<b>x</b>' }],
 'type-second': [{ type: ['Other', 'PropertyValue'], name: 'ignored', value: '<b>x</b>' }],
})) await capture(`attachment-${id}`, 'attachment', { attachment });
await capture('create-canonical', 'create', { duplicate: true, patch: { summary: '<b>discarded</b>' } });
const get = id => cases.find(c => c.id === id).expected;
assert.equal(get('create-attachment-priority').error.message, "Cannot read properties of null (reading 'type')");
assert.equal(get('create-bad-summary').events.at(-1).op, 'transaction.rollback');
assert(get('refresh-bad-summary').events.some(e => e.op === 'Key.update'));
assert(!get('refresh-bad-summary').events.some(e => e.op === 'Profile.update'));
const result = {
 schemaVersion: 1, upstreamCommit, fullFileSha256, methods, upstreamHttpMeasured: false,
 sourceStorage: { descriptionMaxCharacters, method: 'MiUserProfile.description', boundary: 'Pinned column declaration only; source repository double does not enforce PostgreSQL length.' },
 boundary: 'Literal fromHtml/htmlToMfm/analyzeAttachments/validateActor/createPerson/updatePerson and real type/tag/normalize/truncate helpers. Upstream-installed real node-html-parser 9.0.4 and stringz. No transformer doubles. Finite source methods, not full upstream HTTP.',
 doubles: ['repositories record attempts (no real DB defaults/constraints)', 'transaction callback trace (not rollback proof)', 'transport/resolver supplies actor', 'fixed clock/IDs', 'emoji returns empty', 'images/featured/cache/charts/events no-op', 'instance meta disabled'],
 cases,
};
const target = new URL('./remote-profile-observations.json', import.meta.url);
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[2] === '--write') writeFileSync(target, output); else assert.equal(readFileSync(target, 'utf8'), output);
console.log(`remote profile source: ${cases.length} cases OK`);
