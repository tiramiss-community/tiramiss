/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Antenna } from '@/server/api/endpoints/i/import-antennas.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiNote } from '@/models/Note.js';
import type { SystemWebhookEventType } from '@/models/SystemWebhook.js';
import type { MiUser } from '@/models/User.js';
import type { MiWebhook, WebhookEventTypes } from '@/models/Webhook.js';
import type { IActivity } from '@/core/activitypub/type.js';
import type { SystemWebhookPayload } from '@/core/SystemWebhookService.js';
import type { UserWebhookPayload } from '@/core/UserWebhookService.js';
import type httpSignature from '@peertube/http-signature';

export type DeliverJobData = {
	/** Actor */
	user: ThinUser;
	/** Activity */
	content: string;
	/** Digest header */
	digest: string;
	/** inbox URL to deliver */
	to: string;
	/** whether it is sharedInbox */
	isSharedInbox: boolean;
};

export type InboxJobData = {
	activity: IActivity;
	signature: httpSignature.IParsedSignature;
};

export type RelationshipJobData = {
	from: ThinUser;
	to: ThinUser;
	silent?: boolean;
	requestId?: string;
	withReplies?: boolean;
};

export type DbJobData<T extends keyof DbJobMap> = DbJobMap[T];

export type DbJobMap = {
	deleteDriveFiles: DbJobDataWithUser;
	exportCustomEmojis: DbJobDataWithUser;
	exportAntennas: DBExportAntennasData;
	exportNotes: DbJobDataWithUser;
	exportFavorites: DbJobDataWithUser;
	exportFollowing: DbExportFollowingData;
	exportMuting: DbJobDataWithUser;
	exportBlocking: DbJobDataWithUser;
	exportUserLists: DbJobDataWithUser;
	importAntennas: DBAntennaImportJobData;
	importFollowing: DbUserImportJobData;
	importFollowingToDb: DbUserImportToDbJobData;
	importMuting: DbUserImportJobData;
	importBlocking: DbUserImportJobData;
	importBlockingToDb: DbUserImportToDbJobData;
	importUserLists: DbUserImportJobData;
	importCustomEmojis: DbUserImportJobData;
	deleteAccount: DbUserDeleteJobData;
};

export type DbJobDataWithUser = {
	user: ThinUser;
};

export type DbExportFollowingData = {
	user: ThinUser;
	excludeMuting: boolean;
	excludeInactive: boolean;
};

export type DBExportAntennasData = {
	user: ThinUser
};

export type DbUserDeleteJobData = {
	user: ThinUser;
	soft?: boolean;
};

export type DbUserImportJobData = {
	user: ThinUser;
	fileId: MiDriveFile['id'];
	withReplies?: boolean;
};

export type DBAntennaImportJobData = {
	user: ThinUser,
	antenna: Antenna
};

export type DbUserImportToDbJobData = {
	user: ThinUser;
	target: string;
	withReplies?: boolean;
};

export type ObjectStorageJobData = ObjectStorageFileJobData | Record<string, unknown>;

export type ObjectStorageFileJobData = {
	key: string;
};

export type EndedPollNotificationJobData = {
	noteId: MiNote['id'];
};

export type PostScheduledNoteJobData = {
	noteDraftId: string;
};

export type NotePostJobData = {
	noteId: MiNote['id'];
	silent: boolean;
};

export type NoteDeleteJobData = {
	noteId: string;
	quiet: boolean;
	userSnapshot: { id: string; uri: string | null; host: string | null; isBot: boolean };
	noteSnapshot: Pick<MiNote, 'id' | 'userId' | 'userHost' | 'visibility' | 'localOnly' | 'channelId' | 'replyId' | 'renoteId' | 'fileIds'>;
	apContent: any | null;
	apRecipientIds: string[];
	isRemote: boolean;
};

export type ReactionDeliverJobData = {
	noteId: string;
	userSnapshot: { id: string };
	apContent: any | null;
	apRecipientIds: string[];
	isUndo: boolean;
	/** addFollowersRecipe を呼ぶかどうか (HTTP 側で visibility / undo から判定して渡す) */
	deliverToFollowers: boolean;
};

export type NotePiningDeliverJobData = {
	noteId: string;
	userSnapshot: { id: string };
	apContent: any | null;
	isAddition: boolean;
};

/**
 * リモートインスタンスの follow/follower カウンタおよび instance chart を更新するジョブのペイロード。
 *
 * - direction: 'following' を指定すると `instances.followingCount` を、'followers' を指定すると `followersCount` を更新する。
 * - isAdditional: true で increment / false で decrement。
 * - updateChart: enqueue 時点で `meta.enableChartsForFederatedInstances` を判定して保持する。
 */
export type InstanceFollowStatsUpdateJobData = {
	host: string;
	direction: 'following' | 'followers';
	isAdditional: boolean;
	updateChart: boolean;
};

export type UpdateUserNotesCountJobData = {
	userId: string;
};

export type SystemWebhookDeliverJobData<T extends SystemWebhookEventType = SystemWebhookEventType> = {
	type: T;
	content: SystemWebhookPayload<T>;
	webhookId: MiWebhook['id'];
	to: string;
	secret: string;
	createdAt: number;
	eventId: string;
};

export type UserWebhookDeliverJobData<T extends WebhookEventTypes = WebhookEventTypes> = {
	type: T;
	content: UserWebhookPayload<T>;
	webhookId: MiWebhook['id'];
	userId: MiUser['id'];
	to: string;
	secret: string;
	createdAt: number;
	eventId: string;
};

export type ThinUser = {
	id: MiUser['id'];
};
