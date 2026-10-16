/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { DataSource } from 'typeorm';
import { entities, MiRole } from 'backend-upstream/entities';

test('loads copied entities without eagerly loading migration dependencies', async () => {
	const output = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
  import 'reflect-metadata';
  import { createRequire } from 'node:module';
  await import('backend-upstream/entities');
  const require = createRequire(import.meta.url);
  console.log(Object.keys(require.cache).some(path => /node_modules\\/(re2|tinycolor2)\\//.test(path)));
 `,
		],
		{ encoding: 'utf8' },
	);
	expect(output.trim()).toBe('false');
	const source = new DataSource({ type: 'postgres', entities });
	// Metadata construction validates cyclic relation targets without opening a DB.
	await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
	expect(source.getMetadata(MiRole).tableName).toBe('role');
	expect(source.entityMetadatas).toHaveLength(9);
});
