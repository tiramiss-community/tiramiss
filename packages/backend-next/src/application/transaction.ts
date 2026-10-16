/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface TransactionRunner<Scope> {
	run<T>(work: (scope: Scope) => Promise<T>): Promise<T>;
}
