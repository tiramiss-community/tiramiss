/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type RolePolicies = {
	gtlAvailable: boolean;
	ltlAvailable: boolean;
	canPublicNote: boolean;
	mentionLimit: number;
	canInvite: boolean;
	inviteLimit: number;
	inviteLimitCycle: number;
	inviteExpirationTime: number;
	canManageCustomEmojis: boolean;
	canManageAvatarDecorations: boolean;
	canSearchNotes: boolean;
	canSearchUsers: boolean;
	canUseTranslator: boolean;
	canHideAds: boolean;
	canCreateChannel: boolean;
	driveCapacityMb: number;
	maxFileSizeMb: number;
	alwaysMarkNsfw: boolean;
	canUpdateBioMedia: boolean;
	pinLimit: number;
	antennaLimit: number;
	wordMuteLimit: number;
	webhookLimit: number;
	clipLimit: number;
	noteEachClipsLimit: number;
	userListLimit: number;
	userEachUserListsLimit: number;
	rateLimitFactor: number;
	avatarDecorationLimit: number;
	canImportAntennas: boolean;
	canImportBlocking: boolean;
	canImportFollowing: boolean;
	canImportMuting: boolean;
	canImportUserLists: boolean;
	chatAvailability: 'available' | 'readonly' | 'unavailable';
	uploadableFileTypes: string[];
	noteDraftLimit: number;
	scheduledNoteLimit: number;
	watermarkAvailable: boolean;
};

const defaults: RolePolicies = {
	gtlAvailable: true,
	ltlAvailable: true,
	canPublicNote: true,
	mentionLimit: 20,
	canInvite: false,
	inviteLimit: 0,
	inviteLimitCycle: 60 * 24 * 7,
	inviteExpirationTime: 0,
	canManageCustomEmojis: false,
	canManageAvatarDecorations: false,
	canSearchNotes: false,
	canSearchUsers: true,
	canUseTranslator: true,
	canHideAds: false,
	canCreateChannel: true,
	driveCapacityMb: 100,
	maxFileSizeMb: 30,
	alwaysMarkNsfw: false,
	canUpdateBioMedia: true,
	pinLimit: 5,
	antennaLimit: 5,
	wordMuteLimit: 200,
	webhookLimit: 3,
	clipLimit: 10,
	noteEachClipsLimit: 200,
	userListLimit: 10,
	userEachUserListsLimit: 50,
	rateLimitFactor: 1,
	avatarDecorationLimit: 1,
	canImportAntennas: false,
	canImportBlocking: false,
	canImportFollowing: false,
	canImportMuting: false,
	canImportUserLists: false,
	chatAvailability: 'available',
	uploadableFileTypes: [
		'text/*',
		'application/json',
		'image/*',
		'video/*',
		'audio/*',
	],
	noteDraftLimit: 10,
	scheduledNoteLimit: 1,
	watermarkAvailable: true,
};

Object.freeze(defaults.uploadableFileTypes);
export const DEFAULT_POLICIES: Readonly<RolePolicies> = Object.freeze(defaults);
