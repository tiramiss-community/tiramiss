/*
 * SPDX-FileCopyrightText: tiramiss-community
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const statuses = new Set(['未評価', '要対応', '対応済み', '影響なし', '見送り']);
const unresolved = new Set(['未評価', '要対応']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.length > 0;
const sameSet = (left, right) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

export function checkLedger(ledger, extraction) {
	const errors = [];
	const items = ledger.items ?? [];
	const ids = new Set(items.map(item => item.id));
	if (ids.size !== items.length) {
		errors.push('duplicate item id');
	}
	for (const field of ['from', 'to']) {
		if (!/^[a-f0-9]{40}$/.test(ledger[field]) || ledger[field] !== extraction[field]) {
			errors.push(`invalid or mismatched ${field}`);
		}
	}
	if (!Array.isArray(ledger.carryIn)) {
		errors.push('carryIn must explicitly list prior unresolved items (or [])');
	}
	for (const prior of ledger.carryIn ?? []) {
		if (!unresolved.has(prior.status) || !nonempty(prior.source)) {
			errors.push(`${prior.id}: invalid carryIn`);
		}
		if (!items.some(item => item.id === prior.id && item.carriedFrom === prior.source)) {
			errors.push(`${prior.id}: missing carry-in item or source`);
		}
	}
	const mapped = new Map();
	for (const commit of extraction.history ?? []) {
		for (const entry of commit.paths ?? []) {
			if (!list(entry.items)) {
				errors.push(`${entry.path}: missing item mapping`);
			}
			for (const id of entry.items ?? []) {
				if (!ids.has(id)) {
					errors.push(`${entry.path}: unknown item ${id}`);
				}
				const commits = mapped.get(id) ?? [];
				commits.push(commit.commit);
				mapped.set(id, commits);
			}
		}
	}
	const historyPaths = new Set((extraction.history ?? []).flatMap(commit => commit.paths.map(entry => entry.path)));
	for (const path of extraction.finalPaths ?? []) {
		if (!historyPaths.has(path)) {
			errors.push(`${path}: final diff has no history mapping`);
		}
	}
	if (extraction.review?.result !== 'PASS' || !nonempty(extraction.review?.evidence)) {
		errors.push('extraction review evidence must PASS separately from item verification');
	}
	for (const item of items) {
		for (const field of ['id', 'contract', 'impact', 'owner']) {
			if (!nonempty(item[field])) {
				errors.push(`${item.id}: missing ${field}`);
			}
		}
		if (!statuses.has(item.status)) {
			errors.push(`${item.id}: unknown status`);
		}
		if (!Array.isArray(item.commits) || !sameSet(item.commits, mapped.get(item.id) ?? [])) {
			errors.push(`${item.id}: commits differ from extraction mapping`);
		}
		if (!mapped.has(item.id) && !(ledger.carryIn ?? []).some(prior => prior.id === item.id)) {
			errors.push(`${item.id}: neither extracted nor carried`);
		}
		if (item.status === '対応済み') {
			for (const field of ['acceptance', 'implementation', 'verification']) {
				if (!list(item[field])) {
					errors.push(`${item.id}: missing ${field}`);
				}
			}
			for (const field of ['acceptance', 'implementation']) {
				if (!(item[field] ?? []).every(nonempty)) {
					errors.push(`${item.id}: ${field} must contain meaningful strings`);
				}
			}
			if (!(item.verification ?? []).every(result => result?.result === 'PASS' && nonempty(result?.evidence))) {
				errors.push(`${item.id}: verification must PASS with evidence`);
			}
		}
		if (['影響なし', '見送り'].includes(item.status) || item.intentionalDifference) {
			for (const field of ['reason', 'evidence', 'approvedBy', 'approvedAt']) {
				if (!nonempty(item.decision?.[field])) {
					errors.push(`${item.id}: missing decision.${field}`);
				}
			}
		}
		if (unresolved.has(item.status) && !nonempty(item.next)) {
			errors.push(`${item.id}: missing next action`);
		}
	}
	const blockers = items.filter(item => unresolved.has(item.status)).map(item => item.id);
	return { errors, blockers, productReleaseApproved: false };
}

export function checkGitExtraction(extraction, cwd) {
	const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' });
	const nulPaths = output => output.split('\0').filter(Boolean);
	const errors = [];
	git(['merge-base', '--is-ancestor', extraction.from, extraction.to]);
	const commits = git(['rev-list', '--reverse', '--topo-order', `${extraction.from}..${extraction.to}`]).trim().split('\n').filter(Boolean);
	if (!sameSet(commits, extraction.history.map(commit => commit.commit))) {
		errors.push('Git commit list differs from extraction');
	}
	for (const commit of extraction.history) {
		const paths = nulPaths(git(['diff', '--no-renames', '--name-only', '-z', `${commit.commit}^`, commit.commit]));
		if (!sameSet(paths, commit.paths.map(entry => entry.path))) {
			errors.push(`${commit.commit}: Git intermediate paths differ`);
		}
	}
	const finalPaths = nulPaths(git(['diff', '--no-renames', '--name-only', '-z', extraction.from, extraction.to]));
	if (!sameSet(finalPaths, extraction.finalPaths)) {
		errors.push('Git final paths differ');
	}
	return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const ledger = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8'));
		const extraction = JSON.parse(readFileSync(new URL('./extraction.json', import.meta.url), 'utf8'));
		const result = checkLedger(ledger, extraction);
		result.errors.push(...checkGitExtraction(extraction, fileURLToPath(new URL('../../..', import.meta.url))));
		if (ledger.releaseDecision.target !== ledger.to || ledger.releaseDecision.result !== (result.blockers.length ? 'BLOCKED' : 'DELTA_PASS') || !sameSet(ledger.releaseDecision.blockers, result.blockers) || ledger.releaseDecision.productReleaseApproved !== false) {
			result.errors.push('stored releaseDecision differs from computed delta decision');
		}
		console.log(JSON.stringify({ record: result.errors.length ? 'INVALID' : 'PASS', delta: result.blockers.length ? 'BLOCKED' : 'PASS', ...result }, null, 2));
		process.exitCode = result.errors.length ? 1 : (process.argv.includes('--release') && result.blockers.length ? 2 : 0);
	} catch (error) {
		console.error(`ledger check failed: ${error.message}`);
		process.exitCode = 1;
	}
}
