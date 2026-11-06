/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { collectInboxes, NoteDeliveryError } from './deliver-recipients.js';
import { renderNoteActivity } from './note-activity.js';
import type { DeliverBatch } from './deliver-job.js';
import type { DeliverRecipe, FollowerInbox } from './deliver-recipients.js';
import type { NoteActivityMaterials } from './note-activity.js';

/** 保存済みの投稿の列のうち、配送するかどうかと direct の宛先を決めるもの。 */
export interface NoteDeliveryFacts {
	userHost: string | null;
	localOnly: boolean;
	/** 本家の作成時の mentionedUsers と同じ順。返信先の作者と specified の宛先を含む。 */
	mentions: string[];
	replyUserId: string | null;
	replyUserHost: string | null;
	renoteUserId: string | null;
	renoteUserHost: string | null;
}

export type NoteDeliveryMaterials = NoteActivityMaterials & { delivery: NoteDeliveryFacts };

export interface DeliveryUser {
	id: string;
	host: string | null;
	inbox: string | null;
	sharedInbox: string | null;
}

const followersAudience = new Set(['public', 'home', 'followers']);

/**
 * 本家 NoteCreateService.postNoteCreated の AP 配送の区画。保存済みの投稿を読み直し、表現・宛先の選定・投入までを行う。
 */
export function createDeliverCreatedNote(ports: {
	readNote(noteId: string): Promise<NoteDeliveryMaterials | null>;
	readUsers(ids: readonly string[]): Promise<DeliveryUser[]>;
	readFollowerInboxes(followeeId: string): Promise<FollowerInbox[]>;
	deliverToRelays(author: { id: string }, activity: Record<string, unknown>): Promise<void>;
	enqueue(batch: DeliverBatch): Promise<void>;
	/** 末尾の `/` を持たない origin。 */
	selfUrl: string;
	currentTime(): number;
}) {
	return async (noteId: string): Promise<void> => {
		const materials = await ports.readNote(noteId);
		// 後続処理の前に消えた投稿は、削除の配送（#172）だけが扱う。
		if (materials === null) {
			return;
		}
		const { note, delivery } = materials;
		if (delivery.localOnly || delivery.userHost !== null) {
			return;
		}

		let activity: Record<string, unknown>;
		try {
			activity = renderNoteActivity(materials, { selfUrl: ports.selfUrl, now: ports.currentTime() });
		} catch (error) {
			// 本家は待たない Promise の中で失敗し、何も配送しない（specified の pure Renote、MFM の ruby など）。
			throw new NoteDeliveryError('RENDER_FAILED', 'the note activity could not be rendered', { cause: error });
		}

		const recipes = await directRecipes(delivery, ports.readUsers);
		const relay = async () => {
			if (note.visibility === 'public') {
				await ports.deliverToRelays({ id: note.userId }, activity);
			}
		};
		const ordinary = async () => {
			if (followersAudience.has(note.visibility)) {
				recipes.push({ type: 'Followers' });
			}
			const inboxes = await collectInboxes(recipes, () => ports.readFollowerInboxes(note.userId));
			await ports.enqueue({ user: { id: note.userId }, activity, inboxes });
		};
		const results = await Promise.allSettled([relay(), ordinary()]);
		const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
		if (failures.length === 1) {
			throw failures[0];
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, 'note deliveries failed');
		}
	};
}

/** 本家の追加の順（メンション → 返信先の作者 → Renote 先の作者）。作者は保存時の host がリモートのときだけ読み直す。 */
async function directRecipes(delivery: NoteDeliveryFacts, readUsers: (ids: readonly string[]) => Promise<DeliveryUser[]>): Promise<DeliverRecipe[]> {
	const authorIds = [
		...(delivery.replyUserId !== null && delivery.replyUserHost !== null ? [delivery.replyUserId] : []),
		...(delivery.renoteUserId !== null && delivery.renoteUserHost !== null ? [delivery.renoteUserId] : []),
	];
	const candidates = [...delivery.mentions, ...authorIds];
	if (candidates.length === 0) {
		return [];
	}

	const users = new Map((await readUsers([...new Set(candidates)])).map(user => [user.id, user]));
	return candidates.flatMap(id => {
		const user = users.get(id);
		if (user === undefined || user.host === null) {
			return [];
		}
		return [{ type: 'Direct' as const, to: { inbox: user.inbox, sharedInbox: user.sharedInbox } }];
	});
}
