/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';

const counts = new Set(['mentionedUsersCount', 'mentionedLocalUsersCount', 'mentionedRemoteUsersCount', 'attachedUsersCount', 'attachedLocalUsersCount', 'attachedRemoteUsersCount']);

function ranking(item, rows) {
	if (item.endpoint === 'search') {
		return { column: 'mentionedLocalUsersCount', descending: true, candidates: rows.filter(row => row.name.startsWith(item.input.query.toLowerCase())) };
	}
	const column = `${item.input.sort.slice(1)}Count`;
	assert(counts.has(column), 'known list rank');
	return { column, descending: item.input.sort[0] === '+', candidates: rows.filter(row =>
		(!item.input.attachedToUserOnly || row.attachedUsersCount !== 0)
		&& (!item.input.attachedToLocalUserOnly || row.attachedLocalUsersCount !== 0)
		&& (!item.input.attachedToRemoteUserOnly || row.attachedRemoteUsersCount !== 0)) };
}

export function canonicalizeHashtagResult(item, result, rows) {
	if (item.endpoint !== 'list' && item.endpoint !== 'search') {
		return result;
	}
	assert(Array.isArray(result), 'ranked result must be an array');
	const { column, descending, candidates } = ranking(item, rows);
	const ranked = [...candidates].sort((a, b) => (a[column] - b[column]) * (descending ? -1 : 1));
	const start = item.endpoint === 'search' ? item.input.offset ?? 0 : 0;
	const end = Math.min(start + (item.input.limit ?? 10), ranked.length);
	// These fixtures compare exact page membership. Keep each tied rank wholly
	// inside or outside the page, since PostgreSQL may choose any boundary member.
	for (const boundary of [start, end]) {
		if (boundary > 0 && boundary < ranked.length) {
			assert.notEqual(ranked[boundary - 1][column], ranked[boundary][column], 'fixture page boundary splits a tied rank');
		}
	}
	assert.equal(result.length, Math.max(0, end - start), 'page length');
	const byName = new Map(rows.map(row => [row.name, row]));
	const name = row => item.endpoint === 'search' ? row : row.tag;
	const seen = new Set();
	const rank = row => {
		const tag = name(row);
		assert(byName.has(tag), `unknown ${item.endpoint} member`);
		assert(!seen.has(tag), 'duplicate ranked member');
		seen.add(tag);
		const value = item.endpoint === 'search' ? byName.get(tag)[column] : row[column];
		assert(Number.isInteger(value), 'integer rank');
		return value;
	};
	const groups = [];
	let previous;
	for (const row of result) {
		const value = rank(row);
		if (previous !== undefined) {
			assert(descending ? previous >= value : previous <= value, 'rank order');
		}
		if (groups.length === 0 || previous !== value) {
			groups.push([]);
		}
		groups.at(-1).push(row);
		previous = value;
	}
	return groups.flatMap(group => group.sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
}

export function canonicalizeHashtagObservations(output, corpus) {
	assert.equal(output.cases.length, corpus.cases.length, 'source case count');
	return { ...output, cases: output.cases.map((observation, index) => {
		const item = corpus.cases[index];
		assert.equal(observation.id, item.id, 'source case identity');
		return Object.hasOwn(observation, 'result')
			? { ...observation, result: canonicalizeHashtagResult(item, observation.result, corpus.rows) }
			: observation;
	}) };
}
