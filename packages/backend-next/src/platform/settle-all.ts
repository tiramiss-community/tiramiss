/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// A rejected sibling must not release an accepted operation's resource ownership early.
export async function settleAll<T extends readonly unknown[]>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
	const results = await Promise.allSettled(values);
	const failed = results.find(result => result.status === 'rejected');
	if (failed?.status === 'rejected') {
		throw failed.reason;
	}
	return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}
