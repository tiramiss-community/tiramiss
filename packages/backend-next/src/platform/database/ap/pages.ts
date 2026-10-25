/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { assertPhysicalCapacity, physicalCapacityCondition } from '../work-capacity/gate.js';
import { WorkCapacityExceeded, WorkRequestConflict } from '../../../modules/post-work/public.js';
import { chargedBytes, workCapacity, workHash } from '../../../modules/post-work/prepare.js';
import { withLocalWorkCompletion } from '../post-work/local-execution.js';
import { LocalWorkValidationCache } from '../post-work/local-work-validation.js';
import { pageTarget, parsePagePayload } from './page-payload.js';
import { recipientPage, recipientsMatch, validateApPage } from './page-validation.js';
import type { SavedLocalRequest } from '../post-work/local-work-validation.js';
import type { LocalExecutionClaim } from '../../jobs/local-execution.js';
import type { EntityManager } from 'typeorm';

interface ChildItem {
	work_id: string; request_id: string; kind: string; target_key: string; schema_version: number;
	payload: string; payload_hash: string; charged_bytes: number; next_attempt_at: Date; deadline_at: Date;
}

export class PostApRecipientPages {
	private readonly validation = new LocalWorkValidationCache();

	async complete(manager: EntityManager, claim: LocalExecutionClaim): Promise<{ count: number }> {
		const fixedClaim = { ...claim };
		if (fixedClaim.kind !== 'ap.expand.page') {
			throw new Error('AP page completion requires a page claim');
		}
		let count = 0;
		await withLocalWorkCompletion(manager, fixedClaim, async () => {
			const saved = await manager.createQueryBuilder().select('request.*').from('backend_internal.work_request', 'request')
				.where('request_id=:id', { id: fixedClaim.requestId }).getRawOne<SavedLocalRequest>();
			const item = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
				.where('work_id=:id', { id: fixedClaim.workId }).getRawOne();
			const validated = saved && item && this.validation.validate(item, saved);
			const page = item?.payload && parsePagePayload(item.payload, item.target_key);
			if (!validated || validated.request.kind !== 'ap.expand' || !page
				|| !await validateApPage(manager, item, saved, this.validation)) {
				throw new Error('Invalid AP page payload or fixed recipient coverage');
			}

			const request = validated.request;
			const recipients = await recipientPage(manager, request.requestId, page.after);
			if (!recipientsMatch(recipients, request)) {
				throw new Error('Invalid AP recipient identity');
			}
			count = Math.min(recipients.length, 100);
			const items: ChildItem[] = [];
			const add = (kind: string, target: string, payload: string) => {
				const workId = workHash(JSON.stringify([request.requestId, kind, target]));
				items.push({
					work_id: workId, request_id: request.requestId, kind, target_key: target, schema_version: 1,
					payload, payload_hash: workHash(payload),
					charged_bytes: chargedBytes(1536, workId + request.requestId + kind + target + payload),
					next_attempt_at: new Date(request.notBeforeMs), deadline_at: saved.deadline_at,
				});
			};
			for (const recipient of recipients.slice(0, 100)) {
				add('ap.send', recipient.inbox, JSON.stringify({ inbox: recipient.inbox, shared: recipient.shared }));
			}
			if (recipients.length > 100) {
				const after = recipients[99].inbox;
				add('ap.expand.page', pageTarget(after), JSON.stringify({ after, previous: fixedClaim.workId }));
			}
			// RETURNING must not merge database defaults into the candidates before immutable comparison.
			const inserted = await manager.createQueryBuilder().insert().into('backend_internal.work_item').values(items)
				.orIgnore().returning(['work_id', 'charged_bytes']).updateEntity(false).execute();
			const existing = await manager.createQueryBuilder().select('item.*').from('backend_internal.work_item', 'item')
				.where('work_id IN (:...ids)', { ids: items.map(child => child.work_id) })
				.getRawMany<Omit<ChildItem, 'charged_bytes'> & { charged_bytes: string; capacity_formula_version: number }>();
			const byId = new Map(existing.map(child => [child.work_id, child]));
			for (const expected of items) {
				const actual = byId.get(expected.work_id);
				// Reuse only exact immutable children. Never reset progress, or hide a key collision behind ON CONFLICT.
				if (!actual || actual.request_id !== expected.request_id || actual.kind !== expected.kind
					|| actual.target_key !== expected.target_key || actual.schema_version !== expected.schema_version
					|| actual.payload !== expected.payload || actual.payload_hash !== expected.payload_hash
					|| actual.deadline_at.getTime() !== expected.deadline_at.getTime()
					|| actual.capacity_formula_version !== workCapacity.formulaVersion
					|| Number(actual.charged_bytes) !== expected.charged_bytes) {
					throw new WorkRequestConflict('The immutable AP child identity or content does not match');
				}
			}

			const bytes = inserted.raw.reduce((sum: number, child: { charged_bytes: string }) => sum + Number(child.charged_bytes), 0);
			const reserved = await manager.createQueryBuilder().update('backend_internal.work_capacity')
				.set({ reserved_rows: () => 'reserved_rows+:rows', reserved_bytes: () => 'reserved_bytes+:bytes' })
				.where('capacity_key=\'global\' AND capacity_formula_version=:version')
				.andWhere(physicalCapacityCondition)
			.andWhere('((:rows=0 AND :bytes=0) OR (reserved_rows+:rows <= :rowLimit AND reserved_bytes+:bytes <= :byteLimit))')
				.setParameters({ rows: inserted.raw.length, bytes, version: workCapacity.formulaVersion, rowLimit: workCapacity.rows * 0.9, byteLimit: Math.floor(workCapacity.bytes * 0.9) }).execute();
			if (reserved.affected !== 1) {
				throw new WorkCapacityExceeded('The durable work capacity is full or requires reconciliation');
			}
			await assertPhysicalCapacity(manager);
			await manager.createQueryBuilder().update('backend_internal.note_work_state').set({ last_dependency_at: () => 'clock_timestamp()' })
				.where('note_id=:id', { id: request.noteId }).execute();
			return { status: 'succeeded' };
		});
		return { count };
	}
}
