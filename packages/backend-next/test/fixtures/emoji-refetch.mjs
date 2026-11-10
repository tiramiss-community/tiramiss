/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner.js';

const name = process.env.BACKEND_NEXT_TEST_EMOJI_REFETCH;
const query = PostgresQueryRunner.prototype.query;
PostgresQueryRunner.prototype.query = async function (sql, parameters, structured) {
	const result = await query.call(this, sql, parameters, structured);
	// The initial snapshot uses IN; the post-UPDATE lookup uses name equality.
	if (sql.startsWith('SELECT ') && sql.includes('FROM "emoji" "MiEmoji"') &&
		sql.includes('"MiEmoji"."name" = ') && parameters?.includes(name)) {
		await new Promise(resolve => {
			function release(message) {
				if (message?.type === 'release-emoji-refetch') {
					process.off('message', release);
					resolve();
				}
			}

			process.on('message', release);
			process.send({ type: 'emoji-refetch-result', publicUrl: result.records[0]?.MiEmoji_publicUrl });
		});
	}
	return result;
};
