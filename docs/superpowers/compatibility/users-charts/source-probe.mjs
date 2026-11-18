/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../../packages/backend-next/package.json', import.meta.url));
const ts = require('typescript');
const { EntitySchema, Between, LessThan } = require('typeorm');
const commit = '8e07cf085adf7009583d234a208e30436f020e26';
const inputs = [];
function source(path) {
	const text = execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
	inputs.push({ path, sha256: createHash('sha256').update(text).digest('hex') });
	return text;
}
function compile(text) {
	return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
const updates = [];
const usersText = source('packages/backend/src/core/chart/charts/users.ts');
const methods = usersText.slice(usersText.indexOf('protected async tickMajor'), usersText.lastIndexOf('\n}')).replaceAll('@bindThis', '');
const Producer = new Function('IsNull', 'Not', compile(`class Producer { userEntityService = { isLocalUser: user => user.host === null }; diff; commit(diff) { this.diff = diff; } ${methods} }; return Producer;`))(() => null, x => ({ not: x }));
for (const host of [null, 'remote.test']) {
	for (const additional of [false, true]) {
		const instance = new Producer();
		await instance.update({ id: 'alice', host }, additional);
		updates.push({ host, additional, diff: instance.diff });
	}
}
const resyncs = [];
for (const counts of [[0, 0], [7, 9]]) {
	const instance = new Producer();
	const queries = [];
	instance.usersRepository = { async countBy(query) { queries.push(query); return counts[queries.length - 1]; } };
	resyncs.push({ counts, expected: await instance.tickMajor(), queries });
}
let core = source('packages/backend/src/core/chart/core.ts');
core = core.replace(/^import .*;\n/gm, '').replaceAll('@bindThis', '').replace('export default abstract class Chart', 'abstract class Chart').replace(/export /g, '');
const time = source('packages/backend/src/misc/prelude/time.ts');
const literalDateUTC = time.slice(time.indexOf('export function dateUTC'), time.indexOf('export function isTimeSame')).replace('export ', '');
const dateUTC = new Function(compile(literalDateUTC) + '\nreturn dateUTC;')();
const interval = span => span === 'day' ? 86400000 : span === 'hour' ? 3600000 : 1;
const shifted = (date, value, span = 'ms') => new Date(date.getTime() + value * interval(span));
const now = Date.UTC(2026, 10, 18, 12, 30);
const ClockDate = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } };
const Chart = new Function('EntitySchema', 'LessThan', 'Between', 'dateUTC', 'isTimeSame', 'isTimeBefore', 'addTime', 'subtractTime', 'nestedProperty', 'miRepository', 'Date', compile(core) + '\nreturn Chart;')(
	EntitySchema, LessThan, Between, dateUTC, (a, b) => a.getTime() === b.getTime(), (a, b) => a < b, shifted, (date, value, span) => shifted(date, -value, span), { set(target, key, value) { const parts = key.split('.'); let node = target; for (const part of parts.slice(0, -1)) { node = node[part] ??= {}; } node[parts.at(-1)] = value; } }, {}, ClockDate,
);
const metrics = ['local', 'remote'].flatMap(prefix => ['total', 'inc', 'dec'].map(key => `${prefix}.${key}`));
const schema = Object.fromEntries(metrics.map(key => [key, key.endsWith('total') ? { accumulate: true } : { range: 'small' }]));
const reads = [];
for (const span of ['hour', 'day']) {
	const step = interval(span);
	const aligned = Math.floor(now / step) * step;
	for (const offset of [null, -1, aligned, aligned + step / 2, aligned - step * 6, aligned + step * 6]) {
		for (const limit of [1, 4]) {
			const rows = [-3, -1, 0].map((diff, i) => ({ date: (aligned + diff * step) / 1000, ...Object.fromEntries(metrics.map(key => ['___' + key.replaceAll('.', '_'), key.endsWith('total') ? 10 + i : key.endsWith('inc') ? i + 1 : 0])) }));
			const repo = {
				extend() { return this; },
				async find({ where = {} } = {}) { return rows.filter(row => !where.date || (where.date._type === 'between' ? row.date >= where.date._value[0] && row.date <= where.date._value[1] : row.date < where.date._value)).sort((a, b) => b.date - a.date); },
				async findOne(options) { return (await this.find(options))[0] ?? null; },
			};
			const instance = new Chart({ getRepository: () => repo }, async () => () => {}, {}, 'users', schema, true);
			let observed;
			try {
				observed = { expected: await instance.getChart(span, limit, offset === null ? null : new Date(offset), null) };
			} catch (error) {
				observed = { expectedError: error.message };
			}
			reads.push({ span, offset, limit, now, rows: rows.map(row => ({ date: row.date, values: Object.fromEntries(metrics.map(key => [key, row['___' + key.replaceAll('.', '_')]])) })), ...observed });
		}
	}
}
const result = { upstreamCommit: commit, method: 'literal producer update methods and Chart.getChart with in-memory Repository read doubles; not a full upstream HTTP/PG comparison', inputs, updates, resyncs, reads };
const output = JSON.stringify(result, null, 2) + '\n';
const target = new URL('source-observations.json', import.meta.url);
if (process.argv.includes('--write')) {
	writeFileSync(target, output);
} else if (readFileSync(target, 'utf8') !== output) {
	throw new Error('Users chart source observations drift');
}
console.log(`users-chart source: ${updates.length} updates + ${reads.length} reads PASS (${fileURLToPath(target)})`);
