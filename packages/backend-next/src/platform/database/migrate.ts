/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { migrationSources } from './migration-sources.js';
import type { DatabaseConfig } from '../../config/types.js';
export async function migrateDatabase(config: DatabaseConfig): Promise<void> {
	const { upstream, internal } = migrationSources(config);
	// 独自スキーマが上流の変更を前提にできるよう、並列化せず上流の成功後に進む。
	try {
		await upstream.initialize();
		await upstream.runMigrations();
	} finally {
		if (upstream.isInitialized) await upstream.destroy();
	}
	try {
		await internal.initialize();
		// 履歴テーブルの作成に先立って必要なので、このスキーマ自身の migration には置けない。
		await internal.query('CREATE SCHEMA IF NOT EXISTS backend_internal');
		await internal.runMigrations();
	} finally {
		if (internal.isInitialized) await internal.destroy();
	}
}
