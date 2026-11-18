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

const pin = '8e07cf085adf7009583d234a208e30436f020e26';
assert(['--write', '--check'].includes(process.argv[2]));
const upstream = process.env.UPSTREAM_ROOT;
assert(upstream, 'UPSTREAM_ROOT required');
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const dependencies = createRequire(`${process.env.UPSTREAM_DEPENDENCIES_ROOT ?? upstream}/packages/backend/package.json`);
const ts = require('typescript');
const Fastify = dependencies('fastify');
const sources = [
	['packages/backend/src/server/WellKnownServerService.ts', 'a95eae39e0a03afa7ace1c9902394923f753ee4ba578783b15bc2ddc40a38d02'],
	['packages/backend/src/misc/prelude/xml.ts', '43e37baa00eb7c9d3a84d1484c0b5be84a33a5fe70bbdeaada27bb868e45eb9c'],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, hash] of sources) {
	const bytes = readFileSync(`${upstream}/${path}`);
	assert.equal(sha(bytes), hash);
	assert.deepEqual(bytes, execFileSync('git', ['-C', upstream, 'show', `${pin}:${path}`]));
}

const xml = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(`${upstream}/${sources[1][0]}`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, xml);
const sf = ts.createSourceFile('well-known.ts', readFileSync(`${upstream}/${sources[0][0]}`, 'utf8'), ts.ScriptTarget.Latest, true);
const method = sf.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'WellKnownServerService').members.find(n => n.name?.getText() === 'createServer');
const createServer = vm.runInNewContext(ts.transpileModule(`(function(${method.parameters.map(p => p.getText()).join(',')})${method.body.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { ...xml.exports, fastifyAccepts: dependencies('@fastify/accepts'), IsNull: dependencies('typeorm').IsNull, vary: dependencies('vary'), URL });

const cases = [];
for (const url of ['https://local.test:8443', `https://local.test/a&&<<>>""''`]) {
	for (const federation of ['all', 'none', 'fault']) {
		const app = Fastify();
		let reads = 0;
		const receiver = {
			config: { url },
			get meta() {
				reads++;
				if (federation === 'fault') {
					throw new Error('injected Meta failure');
				}
				return { federation };
			},
			oauth2ProviderService: { generateRFC8414() { return { issuer: url }; } },
		};
		app.register(createServer.bind(receiver));
		await app.listen({ host: '127.0.0.1', port: 0 });
		try {
			for (const path of ['/.well-known/host-meta', '/.well-known/host-meta.json', '/.well-known/missing', '/.well-known/', '/.well-known', '/.well-known/missing/nested', '/.well-known/oauth-authorization-server', '/.well-known/change-password']) {
				for (const method of ['GET', 'HEAD', 'OPTIONS']) {
					reads = 0;
					const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method, redirect: 'manual' });
					const body = await response.text();
					if (response.status === 500) {
						if (method === 'HEAD') {
							assert.equal(body, '');
						} else {
							assert.deepEqual(JSON.parse(body), { statusCode: 500, error: 'Internal Server Error', message: 'injected Meta failure' });
						}
						assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
					}
					cases.push({ url, federation, path, method, status: response.status, headers: Object.fromEntries(['access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'access-control-expose-headers', 'cache-control', 'vary', 'content-type', 'location'].map(key => [key, response.headers.get(key)])), body: response.status === 200 ? body : null, injectedFailureBody: response.status === 500 ? body : null, metaReads: reads });
				}
			}
		} finally {
			await app.close();
		}
	}
}

const output = JSON.stringify({ upstreamCommit: pin, sources, dependencies: Object.fromEntries(['fastify', '@fastify/accepts', 'vary'].map(name => [name, dependencies(`${name}/package.json`).version])), method: 'Literal pinned createServer and XML source, listening Fastify; injected Meta and OAuth; no upstream PG/full server', cases }, null, 2) + '\n';
const target = new URL('./observations.json', import.meta.url);
if (process.argv[2] === '--write') {
	writeFileSync(target, output);
} else {
	assert.equal(readFileSync(target, 'utf8'), output);
}
console.log(`well-known source: ${cases.length} listening HTTP cases PASS`);
