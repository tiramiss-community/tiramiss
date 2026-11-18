/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DataSource, EntityManager } from 'typeorm';

export async function readFromPrimary<T>(source: DataSource, read: (manager: EntityManager) => Promise<T>): Promise<T> {
	if (!source.driver.isReplicated) {
		return read(source.manager);
	}
	const runner = source.createQueryRunner('master');
	try {
		return await read(runner.manager);
	} finally {
		await runner.release();
	}
}
