/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../docs/superpowers/compatibility/oauth-client/', import.meta.url);
const corpusBytes = readFileSync(new URL('corpus.json', directory));
const corpus = JSON.parse(corpusBytes);
const observations = JSON.parse(readFileSync(new URL('observations.json', directory)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('OAuth finite source observations bind every input and the acquisition harness', () => {
	assert.equal(observations.upstreamRevision, corpus.upstreamRevision);
	assert.equal(observations.corpusSha256, sha(corpusBytes));
	assert.equal(observations.probeSha256, sha(readFileSync(new URL('source-probe.mjs', directory))));
	for (const [inputs, outputs] of [[corpus.validationCases, observations.validationCases], [corpus.discoveryCases, observations.discoveryCases]]) {
		assert.equal(new Set(inputs.map(item => item.id)).size, inputs.length);
		assert.deepEqual(outputs.map(item => item.id), inputs.map(item => item.id));
	}
	assert.equal(observations.runtimeImplemented, false);
});

test('OAuth client fixtures preserve JSON, HTML, redirect and failure distinctions', () => {
	const discovery = suffix => observations.discoveryCases.find(item => item.id === `oauth-client-discovery-${suffix}`);
	const validation = suffix => observations.validationCases.find(item => item.id === `oauth-client-url-${suffix}`);
	assert.equal(validation('http-production').error.error, 'invalid_request');
	assert.equal(validation('http-test').url, 'http://client.example/');
	assert.equal(discovery('json-basic').result.name, 'Fake client');
	assert.equal(discovery('html-basic').result.name, 'Fake client');
	assert.deepEqual(discovery('json-header-merge').result.redirectUris, ['{{origin}}/header', '{{origin}}/callback', '{{origin}}/callback', '{{origin}}/callback']);
	assert.equal(discovery('http-redirect').result.logo, '{{origin}}/moved/logo.png');
	assert.deepEqual(discovery('http-redirect').requests, ['/client', '/moved/document']);
	assert.equal(discovery('json-wrong-id').error.error_description, 'client_id in the document does not match the client_id URL');
	assert.equal(discovery('http-not-found').error.error_description, 'Failed to fetch client information');
	assert.equal(discovery('json-invalid').error.error_description, 'Failed to parse client information');
	assert.equal(discovery('json-invalid').error.statusCode, 500);
	assert.equal(discovery('http-disconnect').error.statusCode, 500);
	assert.equal(discovery('json-no-redirect').result.redirectUris.length, 0);
});
