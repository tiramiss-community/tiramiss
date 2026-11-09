/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { DataSource, EntityManager } from 'typeorm';
import type { TransactionRunner } from '../../application/transaction.js';

export interface TransactionLifetime {
	assertActive(): void;
}

export function createTransactionRunner<Scope>(
	source: DataSource,
	bind: (manager: EntityManager, lifetime: TransactionLifetime) => Scope,
): TransactionRunner<Scope> {
	// COMMIT 時の通信断では成否を確定できないため、ここでは自動再試行しない。
	return { run: (work) => source.transaction(async (manager) => {
		let active = true;
		const lifetime: TransactionLifetime = {
			assertActive: () => {
				if (!active) {
					throw new Error('The transaction has ended');
				}
			},
		};
		try {
			return await work(bind(manager, lifetime));
		} finally {
			active = false;
		}
	}) };
}
