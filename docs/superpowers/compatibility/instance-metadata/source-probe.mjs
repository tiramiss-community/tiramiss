/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const root = process.env.UPSTREAM_ROOT ?? '/tmp/tiramiss-relay171-upstream';
const require = createRequire(`${root}/packages/backend/package.json`);
const ts = require('typescript');
const tinycolor = require('tinycolor2');
const htmlParser = require('node-html-parser');
const sha = value => createHash('sha256').update(value).digest('hex');
const guards = {
	"core/FetchInstanceMetadataService.ts": {
		"file": "5b6fe1894bfff41c16a17a56713ed0ecdd830db0d44dab03eb92ea20d95386a6",
		"methods": {
			"tryLock": "ba51396b65964e41b353301aa1f24636b8cb0a52797b07ccc1674296a24e3f71",
			"unlock": "d613060c1bfeb66f29bea62b5676960210f968a723af719802edab8f53ce2e4c",
			"fetchInstanceMetadata": "6dbf830af4d7959f6c7c943ddedfc6992230e3ba54512232702365f98b0f9f89",
			"fetchNodeinfo": "52c7379d3a6f8e43629e1d982025daa02bd51c7faac5edbb7c0b2b2a374b0e95",
			"fetchDom": "cf5b66f6fade9da65adb99a703d2880f2217f1023dcc8a66c22716387b4d7ac9",
			"fetchManifest": "cb2df44516bd4b2d4596e0284e3a465bb2810d0a5ce8ae7928bede2ac999c88f",
			"fetchFaviconUrl": "1751ad53e7de40f1d76696673f2646e7a698662d480f4dd835bcc38e25d12e33",
			"fetchIconUrl": "a2fa79a8d4e368bb53766f6e18aceb7a08658ea83a5764262105b6eb679e6549",
			"getThemeColor": "6a1c2b93b3b86830204034e661c37646391b11493e6eae318b22049cfdc5a600",
			"getSiteName": "c3ef64e08d8d205062c8d37fb9f48dd507d2c238f7da3c8f72508f07d0a3b06c",
			"getDescription": "2d8fc24a82fcf48b28dcd253c9858f2240712ec117553fd954458cda9e3d097a"
		}
	},
	"core/HttpRequestService.ts": {
		"file": "3b91d82af54f5988b7a5f12f3467a35e161fb015c53f441451afcf7d4e730af2",
		"methods": {
			"getHtml": "bb147571755d78f6124f0d3e3b815426e25dd2e7474d21458a50daf51f3182f7"
		}
	}
};
Object.assign(guards, {
	"queue/processors/DeliverProcessorService.ts": {
		"file": "1837a7bcc1871c88e25d7a90035730c2c7ddd17b238a56415c33f3e7301ffd85",
		"methods": {
			"process": "31ff95370a57f8090db84d8fc333780d85aab0c4b239fa9b8ea81d23e9dada9d"
		}
	}
});
const methods = {};

function extract(file, klass, name) {
	const text = readFileSync(`${root}/packages/backend/src/${file}`, 'utf8');
	assert.equal(sha(text), guards[file].file, `pinned source ${file}`);
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const declaration = sf.statements.find(s => ts.isClassDeclaration(s) && s.name.text === klass);
	const member = declaration.members.find(m => m.name?.getText(sf) === name);
	const literal = member.getText(sf);
	assert.equal(sha(literal), guards[file].methods[name], `pinned method ${name}`);
	methods[`${klass}.${name}`] = sha(literal);
	return { member, sf };
}

let time = 1800000000000;
const scheduled = [];
class Clock extends Date {
	constructor(...args) {
		super(...(args.length ? args : [time]));
	}
	static now() {
		return time;
	}
}

function method(file, klass, name) {
	const { member, sf } = extract(file, klass, name);
	const async = member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
	const literal = `(${async}function(${member.parameters.map(p => p.getText(sf)).join(',')}) ${member.body.getText(sf)})`;
	return vm.runInNewContext(ts.transpile(literal, { target: ts.ScriptTarget.ES2022 }), { URL, Date: Clock, tinycolor, htmlParser, process: { nextTick: callback => scheduled.push(callback) } });
}

const file = 'core/FetchInstanceMetadataService.ts';
const names = ['tryLock', 'unlock', 'fetchInstanceMetadata', 'fetchNodeinfo', 'fetchDom', 'fetchManifest', 'fetchFaviconUrl', 'fetchIconUrl', 'getThemeColor', 'getSiteName', 'getDescription'];
const prototype = Object.fromEntries(names.map(name => [name, method(file, 'FetchInstanceMetadataService', name)]));
const htmlMethod = method('core/HttpRequestService.ts', 'HttpRequestService', 'getHtml');
const cases = [
	{ id: 'all-sources', info: { software: { name: 'MiSsKeY', version: '2026' }, openRegistrations: true, metadata: { nodeName: 'Node', nodeDescription: 'About', themeColor: 'red', maintainer: { name: 'Maintainer', email: 'm@example.test' } } }, html: '<link rel="icon" href="/first.ico"><link rel="icon" href="/last.ico"><link rel="apple-touch-icon" href="/apple.png"><meta property="og:title" content="HTML"><meta name="description" content="HTML about"><meta name="theme-color" content="blue">', manifest: { name: 'Manifest', theme_color: 'green', icons: [{ src: '/manifest.png' }] } },
	{ id: 'html-precedence', html: '<link rel="icon" href="/first.ico"><link rel="icon shortcut" href="/multi.ico"><link rel="icon" href="/last.ico"><link rel="apple-touch-icon" href="/apple.png"><link rel="apple-touch-icon-precomposed other" href="/pre.png"><meta property="og:title" content="HTML"><meta name="description" content="HTML description"><meta property="og:description" content="OG"><meta name="theme-color" content="rgb(1, 2, 3)">' },
	{ id: 'manifest-fallback', manifest: { name: 'Manifest', description: 'ignored', theme_color: 'rebeccapurple', icons: [{ src: '/icon.png' }] } },
	{ id: 'manifest-short', manifest: { short_name: 'Short' } },
	{ id: 'node-alternate', info: { metadata: { name: 'Name', description: 'Description' } } },
	{ id: 'empty-node-blocks-fallback', info: { metadata: { nodeName: '', nodeDescription: '', themeColor: '' } }, html: '<meta property="og:title" content="HTML"><meta name="description" content="HTML"><meta name="theme-color" content="red">', manifest: { name: 'Manifest' } },
	{ id: 'invalid-color-no-fallback', info: { metadata: { themeColor: 'invalid!' } }, html: '<meta name="theme-color" content="red">', manifest: { theme_color: 'blue' } },
	{ id: 'og-description', html: '<meta property="og:description" content="OG">' },
	{ id: 'data-png-icon', manifest: { icons: [{ src: 'data:image/png;base64,AA==' }] }, faviconStatus: 200 },
	{ id: 'invalid-icon-independent-fields', info: { metadata: { nodeName: 'Retained' } }, manifest: { icons: [{ src: 'https://[' }] }, faviconStatus: 404 },
	{ id: 'all-fetches-fail', faviconStatus: 404 },
	{ id: 'raw-values', info: { software: { name: 42, version: 123 }, openRegistrations: 'invalid', metadata: { maintainer: { name: false }, nodeName: 'X'.repeat(257) } } },
	{ id: 'version-2.0', versions: ['1.0', '2.0'], info: { software: { name: 'Two' } } },
	{ id: 'version-1.0', versions: ['1.0'], info: { software: { name: 'One' } } },
	{ id: 'preferred-fetch-fails', info: { software: { name: 'Must not use' } }, failSelected: true },
	{ id: 'malformed-links', links: [null] },
	{ id: 'fresh-minus-one', age: 86399999 },
	{ id: 'exact-24h', age: 86400000 },
	{ id: 'future-fresh', age: -1 },
	{ id: 'locked-contender', lock: '1' },
	{ id: 'other-lock-value', lock: 'other' },
	{ id: 'force-existing-lock', force: true, lock: '1', age: 0 },
	{ id: 'lock-error', lockError: true },
	{ id: 'read-error', readError: true },
	{ id: 'update-error', updateError: true },
	{ id: 'unlock-error', unlockError: true },
	{ id: 'completion-clock', advance: 3456 },
];

async function observe(input) {
	time = 1800000000000;
	const events = [];
	const report = [];
	let patch = null;
	const logger = {
		info() { }, succ() { }, error() {
			report.push('error');
		}
	};
	const target = { id: 'i', host: 'remote.test' };
	const service = Object.assign(Object.create(prototype), {
		logger,
		redisClient: {
			del: async key => {
				events.push(['del', key]); if (input.unlockError && key.includes(':v2:')) {
					throw Error('unlock');
				} return 1;
			},
			set: async (...args) => {
				events.push(['set', ...args]); if (input.lockError) {
					throw Error('lock');
				} return input.lock ?? null;
			},
		},
		federatedInstanceService: {
			fetchOrRegister: async host => {
				events.push(['read', host]); if (input.readError) {
					throw Error('read');
				} return { infoUpdatedAt: input.age === undefined ? null : new Date(time - input.age) };
			},
			update: async (id, updates) => {
				events.push(['update', id]); patch = JSON.parse(JSON.stringify(updates)); if (input.updateError) {
					throw Error('update');
				}
			},
		},
		httpRequestService: {
			getJson: async url => {
				events.push(['json', url]);
				if (url.endsWith('/.well-known/nodeinfo')) {
					return { links: input.links ?? (input.versions ?? ['1.0', '2.0', '2.1']).map(v => ({ rel: `http://nodeinfo.diaspora.software/ns/schema/${v}`, href: `https://remote.test/nodeinfo/${v}` })) };
				}
				if (url.endsWith('/manifest.json')) {
					if (!('manifest' in input)) {
						throw Error('manifest');
					} return input.manifest;
				}
				if (input.failSelected || !('info' in input)) {
					throw Error('nodeinfo');
				} return input.info;
			},
			getHtml: async url => {
				events.push(['html', url]); if (!('html' in input)) {
					throw Error('html');
				} return input.html;
			},
			send: async (url, options, extra) => {
				events.push(['head', url, options, extra]); time += input.advance ?? 0; return { ok: (input.faviconStatus ?? 404) < 300 };
			},
		},
	});
	let rejection = null;
	try {
		await service.fetchInstanceMetadata(target, input.force);
	} catch (error) {
		rejection = error.message;
	}
	return { id: input.id, input, expected: { events, patch, errors: report.length, rejection } };
}

const observations = [];
for (const input of cases) {
	observations.push(await observe(input));
}
const htmlCalls = [];
await htmlMethod.call({
	send: async (...args) => {
		htmlCalls.push(args); return { text: async () => 'html' };
	}
}, 'https://remote.test', undefined, { Accept: 'override', 'X-Test': 'yes' }, true);
const delivery = method('queue/processors/DeliverProcessorService.ts', 'DeliverProcessorService', 'process');
const callerCases = [];
for (const input of [
	{ stats: true, finalStats: true, instance: true, update: 'pending' },
	{ stats: true, finalStats: true, instance: true, update: 'rejected' },
	{ stats: true, finalStats: false, instance: true },
	{ stats: false, finalStats: true, instance: true },
	{ stats: false, finalStats: true, instance: false },
]) {
	const events = [];
	const meta = { enableStatsForFederatedInstances: input.stats };
	const instance = input.instance ? { id: 'i', host: 'remote.test', isNotResponding: true } : null;
	const rejected = Promise.reject(Error('update rejected')); void rejected.catch(() => { });
	const context = {
		meta, utilityService: { isFederationAllowedUri: () => true, toPuny: value => value, isDeliverSuspendedSoftware: () => false },
		suspendedHostsCache: { get: () => [] },
		federatedInstanceService: {
			fetch: async () => instance, fetchOrRegister: async () => instance,
			update: () => {
				events.push('responding.start'); return input.update === 'rejected' ? rejected : new Promise(() => { });
			},
		},
		apRequestService: {
			signedPost: async () => {
				events.push('post'); meta.enableStatsForFederatedInstances = input.finalStats;
			}
		},
		apRequestChart: { deliverSucc() { } }, federationChart: { deliverd() { } },
		fetchInstanceMetadataService: {
			fetchInstanceMetadata: () => {
				events.push('metadata.start'); return new Promise(() => { });
			}
		},
	};
	const result = await delivery.call(context, { data: { to: 'https://remote.test/inbox', user: { id: 'author' }, content: '{}', digest: '' } });
	events.push('result.returned');
	while (scheduled.length) {
		await scheduled.shift()();
	}
	callerCases.push({ input, expected: { result, events } });
}
const output = { upstreamCommit: pin, scope: 'actual pinned methods with explicit HTTP/Redis/ledger/logger/clock doubles; real source parser/tinycolor dependencies; not full upstream server', guards, methods, htmlCalls, callerCases, cases: observations };
const path = new URL('./observations.json', import.meta.url);
if (process.argv.includes('--write')) {
	writeFileSync(path, JSON.stringify(output, null, '\t') + '\n');
} else {
	assert.equal(JSON.stringify(output, null, '\t') + '\n', readFileSync(path, 'utf8'));
}
console.log(`instance metadata source: ${observations.length} cases PASS`);
