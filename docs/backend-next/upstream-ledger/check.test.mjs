/*
 * SPDX-FileCopyrightText: tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLedger, checkGitExtraction } from './check.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8'));
const extraction = () => JSON.parse(readFileSync(new URL('./extraction.json', import.meta.url), 'utf8'));

test('the real fixed range is complete as a record but blocked for release', () => {
	const result = checkLedger(fixture(), extraction());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.blockers, ['UL-002', 'UL-003', 'BASE-138']);
});

test('an omitted intermediate path is rejected even when absent from the final diff', () => {
	const source = extraction();
	source.history[0].paths.push({ path: 'reverted.ts', items: [] });
	assert.match(checkLedger(fixture(), source).errors.join('\n'), /reverted.ts/);
});

test('a final diff path without a mapped history entry is rejected', () => {
	const source = extraction();
	source.finalPaths.push('unrecorded.json');
	assert.match(checkLedger(fixture(), source).errors.join('\n'), /unrecorded.json/);
});

test('unresolved carry-in cannot disappear from a later batch', () => {
	const ledger = fixture();
	ledger.items = ledger.items.filter(item => item.id !== 'BASE-138');
	assert.match(checkLedger(ledger, extraction()).errors.join('\n'), /BASE-138/);
});

test('implemented requires acceptance, implementation and passing verification', () => {
	for (const field of ['acceptance', 'implementation', 'verification']) {
		const ledger = fixture();
		ledger.items[0][field] = [];
		assert.match(checkLedger(ledger, extraction()).errors.join('\n'), new RegExp(field));
	}
	const ledger = fixture();
	ledger.items[0].verification[0].result = '未実行';
	assert.match(checkLedger(ledger, extraction()).errors.join('\n'), /PASS/);
});

test('no-impact, deferred and intentional differences require a decision basis', () => {
	for (const status of ['影響なし', '見送り']) {
		const ledger = fixture();
		ledger.items[1].status = status;
		assert.match(checkLedger(ledger, extraction()).errors.join('\n'), /decision/);
	}
	const ledger = fixture();
	ledger.items[0].intentionalDifference = true;
	assert.match(checkLedger(ledger, extraction()).errors.join('\n'), /decision/);
});

test('unknown status is invalid and a closed delta is only a delta pass', () => {
	const ledger = fixture();
	ledger.items[1].status = '済';
	assert.match(checkLedger(ledger, extraction()).errors.join('\n'), /status/);
	for (const item of ledger.items.slice(1)) {
		item.status = '影響なし';
		item.decision = { reason: 'test fixture only', evidence: 'test source', approvedBy: 'test', approvedAt: '2026-11-18' };
	}
	const result = checkLedger(ledger, extraction());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.blockers, []);
	assert.equal(result.productReleaseApproved, false);
});

test('stored extraction matches all commits and final paths of the real Git range', () => {
	assert.deepEqual(checkGitExtraction(extraction(), fileURLToPath(new URL('../../..', import.meta.url))), []);
});

test('Git detects an omitted change that was reverted before the final tree', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'upstream-ledger-test-'));
	const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const commit = message => {
		git(['add', '.']);
		git(['-c', 'user.name=Ledger Test', '-c', 'user.email=ledger@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
		return git(['rev-parse', 'HEAD']);
	};
	try {
		git(['init']);
		writeFileSync(join(cwd, 'base.txt'), 'base');
		const from = commit('base');
		writeFileSync(join(cwd, 'transient.txt'), 'added and later reverted');
		const added = commit('add transient');
		rmSync(join(cwd, 'transient.txt'));
		const to = commit('revert transient');
		const source = { from, to, finalPaths: [], history: [
			{ commit: added, paths: [{ path: 'transient.txt', items: ['TRANSIENT'] }] },
			{ commit: to, paths: [{ path: 'transient.txt', items: ['TRANSIENT'] }] },
		] };
		assert.deepEqual(checkGitExtraction(source, cwd), []);
		source.history[0].paths = [];
		assert.match(checkGitExtraction(source, cwd).join('\n'), /intermediate paths differ/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test('implemented acceptance and implementation reject blank or non-string evidence', () => {
	for (const field of ['acceptance', 'implementation']) {
		for (const invalid of ['', '   ', null, 1, {}]) {
			const ledger = fixture();
			ledger.items[0][field] = [invalid];
			assert.match(checkLedger(ledger, extraction()).errors.join('\n'), new RegExp(field));
		}
	}
});
