/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MiUser } from 'backend-upstream/entities';
import { WorkCapacityExceeded } from '../../../modules/post-work/public.js';
import { chargedBytes, workCapacity, workHash } from '../../../modules/post-work/prepare.js';
import { withLocalWorkCompletion } from '../post-work/local-execution.js';
import { LocalWorkValidationCache } from '../post-work/local-work-validation.js';
import type { SavedLocalRequest } from '../post-work/local-work-validation.js';
import type { ApWorkRequest } from '../../../modules/post-work/public.js';
import type { LocalExecutionClaim } from '../../jobs/local-execution.js';
import type { EntityManager } from 'typeorm';

export type ApSnapshotDecision = { status: 'deliver' } | { status: 'suppress'; reason: string };

// One statement snapshot is required: separate ORM reads can mix follower/relay/direct generations.
const snapshotSql = `WITH followers AS MATERIALIZED (
 SELECT COALESCE("followerSharedInbox","followerInbox") AS inbox, "followerSharedInbox" IS NOT NULL AS shared
 FROM public.following WHERE "followeeId"=$1 AND "followerHost" IS NOT NULL AND $2::boolean
), direct_users AS MATERIALIZED (
 SELECT id, host, inbox, "sharedInbox" FROM public."user" WHERE id=ANY($3::varchar[])
), recipes AS (
 SELECT inbox,shared FROM followers
 UNION ALL
 SELECT u.inbox,false FROM direct_users u WHERE u.host IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM followers f WHERE f.inbox=u."sharedInbox")
 UNION ALL
 SELECT inbox,false FROM public.relay WHERE status='accepted' AND $4::boolean
), targets AS MATERIALIZED (
 SELECT inbox,bool_and(shared) AS shared FROM recipes WHERE inbox IS NOT NULL GROUP BY inbox LIMIT 200001
), stats AS (
 SELECT (SELECT count(*) FROM targets) AS count,
 ((SELECT count(*) FROM direct_users)<>cardinality($3::varchar[])
 OR EXISTS (SELECT 1 FROM direct_users WHERE host IS NOT NULL AND inbox IS NULL)
 OR EXISTS (SELECT 1 FROM followers WHERE inbox IS NULL)) AS invalid
), inserted AS (
 INSERT INTO backend_internal.delivery_recipient
 (create_event_id,inbox,request_id,note_id,actor_id,activity_id,shared,fixed_at,retain_until,charged_bytes)
 SELECT $5::varchar,t.inbox,$6::varchar,$7::varchar,$1::varchar,$8::varchar,t.shared,statement_timestamp(),statement_timestamp()+interval '90 days',
 1024*ceil(4::numeric*(512+octet_length($5::varchar||t.inbox||$6::varchar||$7::varchar||$1::varchar||$8::varchar))/1024)
 FROM targets t CROSS JOIN stats s WHERE s.count<=200000 AND NOT s.invalid
 RETURNING charged_bytes
)
SELECT stats.count,stats.invalid,(SELECT COALESCE(sum(charged_bytes),0) FROM inserted) AS bytes FROM stats`;

export class PostApRecipientSnapshot {
	private readonly validation = new LocalWorkValidationCache();

	async complete(
		manager: EntityManager,
		claim: LocalExecutionClaim,
		recheck: (request: ApWorkRequest) => Promise<ApSnapshotDecision>,
	): Promise<{ count: number }> {
		const fixedClaim = { ...claim };
		if (fixedClaim.kind !== 'ap.expand' || typeof recheck !== 'function') {
			throw new Error('AP snapshot requires an expansion claim and federation recheck');
		}
		let count = 0;
		await withLocalWorkCompletion(manager, fixedClaim, async () => {
			const saved = await manager.createQueryBuilder().select('request.*').from('backend_internal.work_request', 'request')
				.where('request_id=:id', { id: fixedClaim.requestId }).getRawOne<SavedLocalRequest>();
			const item = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
				.where('work_id=:id', { id: fixedClaim.workId }).getRawOne();
			const validated = saved && item && this.validation.validate(item, saved);
			if (!validated || validated.request.kind !== 'ap.expand' || validated.request.noteGeneration !== 1) {
				throw new Error('Invalid or unsupported AP snapshot payload');
			}
			const request = validated.request;
			const note = await manager.createQueryBuilder().select('note.recipient_coverage', 'coverage')
				.from('backend_internal.note_work_state', 'note').where('note_id=:id', { id: request.noteId }).getRawOne<{ coverage: string }>();
			if (note?.coverage !== 'not_started') {
				throw new Error('AP recipient coverage is already fixed or unavailable');
			}
			const actor = await manager.getRepository(MiUser).findOneBy({ id: request.actorId });
			if (!actor || actor.host !== null) {
				throw new Error('AP snapshot requires a current local actor');
			}
			const decision = await recheck(request);
			if (!decision || !['deliver', 'suppress'].includes(decision.status)
				|| (decision.status === 'suppress' && !/^[a-z][a-z0-9_]{0,63}$/.test(decision.reason))) {
				throw new Error('Invalid AP snapshot decision');
			}
			let bytes = 0;
			if (!request.note.localOnly && request.note.channelId === null && decision.status === 'deliver') {
				const [previous] = await manager.query('SELECT current_setting(\'statement_timeout\') AS timeout');
				// Respect a tighter caller timeout, and restore the transaction setting after a successful snapshot.
				await manager.query('SELECT set_config(\'statement_timeout\', CASE WHEN current_setting(\'statement_timeout\')::interval > interval \'0\' AND current_setting(\'statement_timeout\')::interval < interval \'20 seconds\' THEN current_setting(\'statement_timeout\') ELSE \'20s\' END, true)');
				const [result] = await manager.query(snapshotSql, [
					request.actorId, request.note.visibility !== 'specified', request.payload.directActorIds,
					request.note.visibility === 'public', request.eventId, request.requestId, request.noteId, request.payload.activity.id,
				]);
				await manager.query('SELECT set_config(\'statement_timeout\',$1,true)', [previous.timeout]);
				if (result.invalid) {
					throw new Error('Unresolved AP recipient material');
				}
				count = Number(result.count);
				if (count > 200000) {
					await manager.createQueryBuilder().update('backend_internal.note_work_state').set({ recipient_coverage: 'unavailable' })
						.where('note_id=:id', { id: request.noteId }).execute();
					return { status: 'failed_permanent', reason: 'recipient_limit' };
				}
				bytes = Number(result.bytes);
			}
			let rows = count;
			if (count > 0) {
				const kind = 'ap.expand.page';
				const target = 'start';
				const payload = '{"after":null}';
				const workId = workHash(JSON.stringify([request.requestId, kind, target]));
				const charge = chargedBytes(1536, workId + request.requestId + kind + target + payload);
				await manager.createQueryBuilder().insert().into('backend_internal.work_item').values({
					work_id: workId, request_id: request.requestId, kind, target_key: target, schema_version: 1,
					payload, payload_hash: workHash(payload), charged_bytes: charge,
					next_attempt_at: new Date(request.notBeforeMs), deadline_at: saved.deadline_at,
				}).execute();
				rows++;
				bytes += charge;
			}
			await manager.createQueryBuilder().update('backend_internal.note_work_state').set({
				recipient_coverage: 'fixed', recipients_fixed_at: () => 'clock_timestamp()', last_dependency_at: () => 'clock_timestamp()',
			}).where('note_id=:id', { id: request.noteId }).execute();
			const reserved = await manager.createQueryBuilder().update('backend_internal.work_capacity')
				.set({ reserved_rows: () => 'reserved_rows+:rows', reserved_bytes: () => 'reserved_bytes+:bytes' })
				.where('capacity_key=\'global\' AND capacity_formula_version=:version')
				.andWhere('((:rows=0 AND :bytes=0) OR (reserved_rows+:rows <= :rowLimit AND reserved_bytes+:bytes <= :byteLimit))')
				.setParameters({ rows, bytes, version: workCapacity.formulaVersion, rowLimit: workCapacity.rows * 0.9, byteLimit: Math.floor(workCapacity.bytes * 0.9) }).execute();
			if (reserved.affected !== 1) {
				throw new WorkCapacityExceeded('The durable work capacity is full or requires reconciliation');
			}
			return decision.status === 'suppress' ? { status: 'skipped', reason: decision.reason } : { status: 'succeeded' };
		});
		return { count };
	}
}
