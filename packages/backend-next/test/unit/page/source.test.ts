/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
const directory = new URL('../../../../../docs/superpowers/compatibility/page-read/', import.meta.url);
const bytes = readFileSync(new URL('corpus.json', directory));
const corpus = JSON.parse(bytes.toString()) as { cases: { id: string }[] };
const source = JSON.parse(readFileSync(new URL('observations.json', directory), 'utf8')) as {
	upstreamCommit: string; invalidWhereValuesBehavior: { null: string; undefined: string }; corpusSha256: string; manifest: { path: string; sha256: string }[]; cases: { id: string; expected: { userCalls: { options: unknown }[] } }[];
};
test('source observations bind the exact shared corpus and default UserLite requests', () => {
	expect(source.upstreamCommit).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	expect(source.invalidWhereValuesBehavior).toEqual({ null: 'ignore', undefined: 'ignore' });
	expect(source.corpusSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
	expect(source.cases.map(row => row.id)).toEqual(corpus.cases.map(row => row.id));
	expect(source.manifest.map(row => row.path)).toEqual(expect.arrayContaining([
		'packages/backend/src/core/entities/PageEntityService.ts', 'packages/backend/src/core/entities/DriveFileEntityService.ts',
		'packages/backend/src/core/IdService.ts', 'packages/backend/src/server/api/endpoints/pages/show.ts',
	]));
	for (const c of source.cases) {
		for (const user of c.expected.userCalls) {
			expect(user.options).toBeNull();
		}
	}
});
test.skipIf(!process.env.BACKEND_NEXT_UPSTREAM_PATH)('reexecutes pinned imported source and checks every observation', () => {
	execFileSync(process.execPath, [new URL('source-probe.mjs', directory).pathname, '--check'], {
		env: { ...process.env, UPSTREAM_ROOT: process.env.BACKEND_NEXT_UPSTREAM_PATH }, stdio: 'pipe',
	});
});
