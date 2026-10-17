/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { EvaluationRole } from './model.js';
import { DEFAULT_POLICIES, type RolePolicies } from './policy-defaults.js';

export interface PolicyInput {
	userId: string | null;
	roles: readonly EvaluationRole[];
	basePolicies: Record<string, unknown>;
	uploadLimitBytes: number;
}

export function evaluatePolicies(input: PolicyInput): RolePolicies {
	const base = { ...DEFAULT_POLICIES, ...input.basePolicies };
	if (input.userId === null) {
		return structuredClone(base);
	}

	function calc<K extends keyof RolePolicies>(key: K, aggregate: (values: unknown[]) => RolePolicies[K]): RolePolicies[K] {
		if (input.roles.length === 0) {
			return aggregate([base[key]]);
		}
		const policies = input.roles.map(role => member(role.policies, key) ?? { priority: 0, useDefault: true });
		const priorityTwo = policies.filter(policy => member(policy, 'priority') === 2);
		const priorityOne = policies.filter(policy => member(policy, 'priority') === 1);
		const selected = priorityTwo.length > 0 ? priorityTwo : priorityOne.length > 0 ? priorityOne : policies;
		return aggregate(selected.map(policy => member(policy, 'useDefault') ? base[key] : member(policy, 'value')));
	}

	const boolean = (values: unknown[]) => values.some(value => value === true);
	const maximum = (values: unknown[]) => Math.max(...values.map(value => Number(value)));
	return {
		gtlAvailable: calc('gtlAvailable', boolean),
		ltlAvailable: calc('ltlAvailable', boolean),
		canPublicNote: calc('canPublicNote', boolean),
		mentionLimit: calc('mentionLimit', maximum),
		canInvite: calc('canInvite', boolean),
		inviteLimit: calc('inviteLimit', maximum),
		inviteLimitCycle: calc('inviteLimitCycle', maximum),
		inviteExpirationTime: calc('inviteExpirationTime', maximum),
		canManageCustomEmojis: calc('canManageCustomEmojis', boolean),
		canManageAvatarDecorations: calc('canManageAvatarDecorations', boolean),
		canSearchNotes: calc('canSearchNotes', boolean),
		canSearchUsers: calc('canSearchUsers', boolean),
		canUseTranslator: calc('canUseTranslator', boolean),
		canHideAds: calc('canHideAds', boolean),
		canCreateChannel: calc('canCreateChannel', boolean),
		driveCapacityMb: calc('driveCapacityMb', maximum),
		maxFileSizeMb: calc('maxFileSizeMb', values => Math.min(Math.floor(input.uploadLimitBytes / (1024 * 1024)), maximum(values))),
		alwaysMarkNsfw: calc('alwaysMarkNsfw', boolean),
		canUpdateBioMedia: calc('canUpdateBioMedia', boolean),
		pinLimit: calc('pinLimit', maximum),
		antennaLimit: calc('antennaLimit', maximum),
		wordMuteLimit: calc('wordMuteLimit', maximum),
		webhookLimit: calc('webhookLimit', maximum),
		clipLimit: calc('clipLimit', maximum),
		noteEachClipsLimit: calc('noteEachClipsLimit', maximum),
		userListLimit: calc('userListLimit', maximum),
		userEachUserListsLimit: calc('userEachUserListsLimit', maximum),
		rateLimitFactor: calc('rateLimitFactor', maximum),
		avatarDecorationLimit: calc('avatarDecorationLimit', maximum),
		canImportAntennas: calc('canImportAntennas', boolean),
		canImportBlocking: calc('canImportBlocking', boolean),
		canImportFollowing: calc('canImportFollowing', boolean),
		canImportMuting: calc('canImportMuting', boolean),
		canImportUserLists: calc('canImportUserLists', boolean),
		chatAvailability: calc('chatAvailability', chatAvailability),
		uploadableFileTypes: calc('uploadableFileTypes', fileTypes),
		noteDraftLimit: calc('noteDraftLimit', maximum),
		scheduledNoteLimit: calc('scheduledNoteLimit', maximum),
		watermarkAvailable: calc('watermarkAvailable', boolean),
	};
}

// JSONの不正な保存値も、本家と同じプロパティ参照・例外の対象にする。
function member(value: unknown, key: string): unknown {
	if (value === null || value === undefined) {
		throw new TypeError('Cannot read a policy from null or undefined');
	}
	return Object(value)[key];
}

function chatAvailability(values: unknown[]): RolePolicies['chatAvailability'] {
	if (values.includes('available')) {
		return 'available';
	}
	if (values.includes('readonly')) {
		return 'readonly';
	}
	return 'unavailable';
}

function fileTypes(values: unknown[]): string[] {
	const types = new Set<string>();
	for (const value of values) {
		if (!Array.isArray(value) && typeof value !== 'string') {
			throw new TypeError('File types must be iterable');
		}
		for (const type of value) {
			if (typeof type !== 'string') {
				throw new TypeError('A file type must support trim');
			}
			if (type.trim() !== '') {
				types.add(type.trim());
			}
		}
	}
	return [...types];
}
