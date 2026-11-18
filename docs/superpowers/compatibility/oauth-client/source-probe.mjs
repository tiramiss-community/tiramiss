/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const mode = process.argv[2];
assert(['--write', '--check'].includes(mode), 'usage: source-probe.mjs --write|--check');
const upstream = process.env.BACKEND_NEXT_UPSTREAM_PATH;
const dependencies = process.env.OAUTH_CLIENT_PROBE_DEPENDENCIES;
assert(upstream, 'BACKEND_NEXT_UPSTREAM_PATH must name a checkout containing the pinned Git objects');
assert(dependencies, 'OAUTH_CLIENT_PROBE_DEPENDENCIES must name an isolated npm dependency directory');
const require = createRequire(resolve(dependencies, 'package.json'));
const ts = require('typescript');
const dependencyVersions = Object.fromEntries(['typescript', 'node-html-parser', 'http-link-header'].map(name => [name, JSON.parse(readFileSync(resolve(dependencies, 'node_modules', name, 'package.json'))).version]));
assert.deepEqual(dependencyVersions, { typescript: '6.0.2', 'node-html-parser': '9.0.4', 'http-link-header': '1.1.4' });
const pin = '8e07cf085adf7009583d234a208e30436f020e26';
const corpusBytes = readFileSync(new URL('corpus.json', import.meta.url));
const corpus = JSON.parse(corpusBytes);
assert.equal(corpus.upstreamRevision, pin);
const sha = value => createHash('sha256').update(value).digest('hex');
const paths = [
	'packages/backend/src/server/oauth/OAuth2ProviderService.ts',
	'packages/backend/src/server/oauth/errors.ts',
	'packages/backend/src/misc/status-error.ts',
	'packages/backend/test/e2e/oauth.ts',
];
const sources = paths.map(path => ({ path, bytes: execFileSync('git', ['show', `${pin}:${path}`], { cwd: upstream }) }));
const ast = ts.createSourceFile(paths[0], sources[0].bytes.toString(), ts.ScriptTarget.Latest, true);
const names = ['validateClientId', 'parseMicroformats', 'discoverClientInformation'];
const functions = names.map(name => {
	const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name);
	assert(declaration, `pinned function missing: ${name}`);
	return declaration.getText(ast);
});
const exports = {};
const environment = { NODE_ENV: 'production' };
const code = `${sources[1].bytes}\n${sources[2].bytes}\n${functions.join('\n')}\nexports.validateClientId = validateClientId; exports.discoverClientInformation = discoverClientInformation;`;
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
	exports, URL, Error, JSON, process: { env: environment },
	htmlParser: require('node-html-parser'), httpLinkHeader: require('http-link-header'),
});
const errorResult = error => ({ name: error.name, error: error.error, error_description: error.error_description, status: error.status, statusCode: error.statusCode, expose: error.expose, allow_redirect: error.allow_redirect });
const validationCases = corpus.validationCases.map(item => {
	environment.NODE_ENV = item.nodeEnv;
	try {
		return { id: item.id, url: exports.validateClientId(item.url).href };
	} catch (error) {
		return { id: item.id, error: errorResult(error) };
	}
});

let current;
let requests;
let origin;
const materialize = value => value.replaceAll('{{origin}}', origin);
const server = createServer((request, response) => {
	requests.push(request.url);
	if (current.disconnect) {
		request.socket.destroy();
		return;
	}
	if (current.httpRedirect && request.url === '/client') {
		response.writeHead(302, { location: current.httpRedirect });
		response.end();
		return;
	}
	const headers = {};
	if (current.contentType) {
		headers['content-type'] = current.contentType;
	}
	if (current.link) {
		headers.link = materialize(current.link);
	}
	response.writeHead(current.status ?? 200, headers);
	response.end(materialize(current.json ? JSON.stringify(current.json) : current.body ?? ''));
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;
const discoveryCases = [];
try {
	for (const item of corpus.discoveryCases) {
		current = item;
		requests = [];
		let loggedErrors = 0;
		const logger = { error: () => { loggedErrors++; } };
		// This adapter is a controlled acquisition boundary, not upstream HttpRequestService.
		const http = { send: async id => {
			assert.equal(id, `${origin}/client`);
			const response = await fetch(id, { signal: AbortSignal.timeout(2000) });
			if (!response.ok) {
				await response.body.cancel();
				throw new exports.StatusError('fake client status failure', response.status);
			}
			return response;
		} };
		let output;
		try {
			output = { result: await exports.discoverClientInformation(logger, http, `${origin}/client`) };
		} catch (error) {
			output = { error: errorResult(error) };
		}
		discoveryCases.push(JSON.parse(JSON.stringify({ id: item.id, ...output, requests, loggedErrors }).replaceAll(origin, '{{origin}}')));
	}
} finally {
	await new Promise(resolve => server.close(resolve));
}
const output = JSON.stringify({
	upstreamRevision: pin,
	corpusSha256: sha(corpusBytes),
	probeSha256: sha(readFileSync(new URL('source-probe.mjs', import.meta.url))),
	sources: sources.map(({ path, bytes }) => ({ path, sha256: sha(bytes) })),
	dependencyVersions,
	observationKind: 'literal pinned source functions / real listening loopback fake clients / controlled native-fetch acquisition adapter',
	runtimeImplemented: false,
	validationCases, discoveryCases,
}, null, 2) + '\n';
const target = new URL('observations.json', import.meta.url);
if (mode === '--write') {
	writeFileSync(target, output);
} else {
	assert.equal(readFileSync(target, 'utf8'), output, 'OAuth client source observations drift');
}
console.log(`${validationCases.length} URL cases / ${discoveryCases.length} discovery cases ${mode} PASS (${process.version})`);
