/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DataSource, EntityManager } from 'typeorm';
import type { TransactionRunner } from '../../application/transaction.js';

export function createTransactionRunner<Scope>(
	source: DataSource,
	bind: (manager: EntityManager) => Scope,
): TransactionRunner<Scope> {
	// COMMIT 時の通信断では成否を確定できないため、ここでは自動再試行しない。
	return { run: (work) => source.transaction((manager) => work(bind(manager))) };
}
