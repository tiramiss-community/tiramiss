/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 固定本家のendpoint metaから、共通gateが判定する認可要件を抜き出す。
// 使い方: node reference-endpoint-access.mjs <固定SHAを含むupstream checkout> [endpoint名...]
// endpoint名を省略すると、既存のendpoint-access.jsonに載っている名前を読み直す。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UPSTREAM_COMMIT = '8e07cf085adf7009583d234a208e30436f020e26';
const output = fileURLToPath(new URL('./endpoint-access.json', import.meta.url));
const [upstream, ...requested] = process.argv.slice(2);
if (!upstream) {
	console.error('usage: node reference-endpoint-access.mjs <upstream-checkout> [endpoint...]');
	process.exit(2);
}

const names = requested.length > 0 ? requested : JSON.parse(readFileSync(output, 'utf8')).endpoints.map(endpoint => endpoint.name);

function readMeta(name) {
	const source = execFileSync('git', ['-C', upstream, 'show', `${UPSTREAM_COMMIT}:packages/backend/src/server/api/endpoints/${name}.ts`], { encoding: 'utf8' });
	const start = source.indexOf('export const meta = {');
	if (start < 0) {
		throw new Error(`meta not found: ${name}`);
	}

	// metaの最上位の項目だけを読む。errors・resなど入れ子の中の同名キーを拾わない。
	let depth = 0;
	let topLevel = '';
	for (const char of source.slice(start + 'export const meta = '.length)) {
		if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				break;
			}
		} else if (depth === 1) {
			topLevel += char;
		}
	}

	const flag = key => new RegExp(`\\b${key}:\\s*true\\b`).test(topLevel) || undefined;
	const kind = /\bkind:\s*'([^']+)'/.exec(topLevel)?.[1];
	return {
		name,
		access: Object.fromEntries(Object.entries({
			requireCredential: flag('requireCredential'),
			requireModerator: flag('requireModerator'),
			requireAdmin: flag('requireAdmin'),
			kind,
		}).filter(([, value]) => value !== undefined)),
	};
}

const endpoints = names.sort().map(readMeta);
writeFileSync(output, JSON.stringify({ upstreamCommit: UPSTREAM_COMMIT, endpoints }, null, '\t') + '\n');
console.log(`${endpoints.length} endpoints -> ${output}`);
