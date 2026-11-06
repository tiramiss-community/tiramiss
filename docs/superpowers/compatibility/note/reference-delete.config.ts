/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.NOTE_DELETE_UPSTREAM_ROOT;
const git = root && (statSync(resolve(root, '.git')).isDirectory() ? resolve(root, '.git') : readFileSync(resolve(root, '.git'), 'utf8').trim().slice(8));
const head = git && readFileSync(resolve(git, 'HEAD'), 'utf8').trim();
if (!root || head !== '8e07cf085adf7009583d234a208e30436f020e26') {
	throw new Error('NOTE_DELETE_UPSTREAM_ROOT must be the isolated fixed upstream checkout');
}
export default {
	resolve: { alias: { 'backend-upstream/entities': fileURLToPath(new URL('../../../../packages/backend-upstream/built/exports/entities.js', import.meta.url)), '@': resolve(root, 'packages/backend/src'), vitest: fileURLToPath(new URL('../../../../packages/backend-next/node_modules/vitest/dist/index.js', import.meta.url)) } },
	test: { include: ['../../docs/superpowers/compatibility/note/reference-delete.unit.ts'], testTimeout: 30000, fileParallelism: false },
};
