/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = new URL('./compatibility-inputs/', import.meta.url);
const paths = new Map();
for (const filename of readdirSync(directory).sort()) {
	const descriptor = JSON.parse(readFileSync(new URL(filename, directory)));
	const record = readFileSync(new URL('../' + descriptor.path, import.meta.url));
	assert.equal(digest(record), descriptor.sha256, filename);
	for (const [path, binding] of Object.entries(JSON.parse(record).files)) {
		const entries = paths.get(path) ?? [];
		entries.push(normalize(binding));
		paths.set(path, entries);
	}
}

function normalize(binding) {
	let delta = 0;
	const patches = binding.patches.map(patch => {
		const insert = Buffer.from(patch.insert);
		const previous = Buffer.from(patch.previous);
		const offset = patch.offset - delta;
		delta += insert.length - previous.length;
		return { offset, insert, previous };
	});
	return { ...binding, patches };
}

// Independent PRs record offsets in their own result. Convert to the common
// parent coordinates, then account for insertions from the other selected PRs.
function reverse(actual, bindings) {
	const pieces = [];
	let previousEnd = 0;
	let position = 0;
	for (const { offset, insert, previous } of bindings.flatMap(entry => entry.patches).sort((a, b) => a.offset - b.offset || a.previous.length - b.previous.length)) {
		if (offset < previousEnd) return;
		const start = position + offset - previousEnd;
		if (start + insert.length > actual.length || !actual.subarray(start, start + insert.length).equals(insert)) return;
		pieces.push(actual.subarray(position, start), previous);
		position = start + insert.length;
		previousEnd = offset + previous.length;
	}
	pieces.push(actual.subarray(position));
	const before = Buffer.concat(pieces);
	if (digest(before) === bindings[0].previousSha256) return before;
}

// A shared historical input can contain a subset of landed changes. Accept
// only exact predecessors and exact component patches, including on partial merges.
function predecessor(actual, entries, identity) {
	const candidates = entries.filter(entry => entry.previousSha256 !== identity);
	for (const entry of candidates) {
		if (entry.currentSha256 === identity) {
			const before = reverse(actual, [entry]);
			assert.ok(before, 'invalid recorded predecessor');
			return { before, selected: [entry] };
		}
	}
	for (const parent of new Set(candidates.map(entry => entry.previousSha256))) {
		const group = candidates.filter(entry => entry.previousSha256 === parent);
		if (group.length < 2) continue;
		const subsets = [[]];
		for (const entry of group) {
			for (const prior of [...subsets]) {
				const selected = [...prior, entry];
				subsets.push(selected);
				if (selected.length > 1) {
					const before = reverse(actual, selected);
					if (before) return { before, selected };
				}
			}
		}
	}
}

function restoreComponent(before, entry) {
	const pieces = [];
	let position = 0;
	for (const { offset, insert, previous } of entry.patches) {
		assert.ok(before.subarray(offset, offset + previous.length).equals(previous));
		pieces.push(before.subarray(position, offset), insert);
		position = offset + previous.length;
	}
	const component = Buffer.concat([...pieces, before.subarray(position)]);
	assert.equal(digest(component), entry.currentSha256);
	return component;
}

function project(entries, actual, expectedSha256) {
	let current = actual;
	// Each step consumes a recorded transition, e.g. features then formatting.
	for (let i = 0; i < entries.length; i++) {
		const identity = digest(current);
		if (identity === expectedSha256) return current;
		const step = predecessor(current, entries, identity);
		if (!step) break;
		const component = step.selected.find(entry => entry.currentSha256 === expectedSha256);
		if (component) return restoreComponent(step.before, component);
		current = step.before;
	}
	return expectedSha256 && digest(current) !== expectedSha256 ? actual : current;
}

export function projectParallelInput(path, actual, expectedSha256) {
	const entries = paths.get(path);
	return entries ? project(entries, actual, expectedSha256) : actual;
}

export function projectRecordedChanges(bindings, actual, expectedSha256) {
	return project(bindings.map(normalize), actual, expectedSha256);
}
