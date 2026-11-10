/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { planUserHashtags } from '../modules/federation/public.js';
import { DiagnosticError } from '../platform/diagnostic-error.js';
import type { UserHashtagChange, UserHashtagSnapshot } from '../modules/federation/public.js';
import type { HashtagMention, HashtagRankingSettings } from '../modules/note/public.js';
import type { Logger } from '../platform/logger.js';

export function createUserHashtags(ports: {
	change(input: UserHashtagChange): Promise<void>;
	ranking: { update(input: HashtagMention, settings: HashtagRankingSettings): Promise<void> };
	readSettings(): Promise<HashtagRankingSettings>;
}, logger: Logger) {
	const pending = new Set<Promise<void>>();

	async function run(changes: UserHashtagChange[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		const failures: { step: string; tag: string; error: unknown }[] = [];
		let settings: Promise<HashtagRankingSettings>;
		try {
			settings = ports.readSettings();
		} catch (error) {
			settings = Promise.reject(error);
		}
		const rankings: Promise<void>[] = [];
		for (const change of changes) {
			// Meta is an asynchronous read here; neither it nor Redis may gate the ordered DB writes.
			rankings.push(settings.then(value => ports.ranking.update(change, value)).catch(error => {
				failures.push({ step: 'ranking', tag: change.tag, error });
			}));
			try {
				await ports.change(change);
			} catch (error) {
				failures.push({ step: 'attachment', tag: change.tag, error });
				break;
			}
		}
		await Promise.all(rankings);
		if (failures.length > 0) {
			throw new DiagnosticError('USER_HASHTAGS_FAILED', { failures });
		}
	}

	async function idle(): Promise<void> {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	}

	return {
		start(user: UserHashtagSnapshot, tags: readonly string[]): void {
			// Plan now, before the first await: callers can replace either tag array after launch.
			const work = run(planUserHashtags(user, tags)).catch(error => {
				logger.error('user-hashtags.failed', { error, userId: user.id, host: user.host });
			});
			pending.add(work);
			void work.then(() => pending.delete(work));
		},
		idle,
		close: idle,
	};
}
