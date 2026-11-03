/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import { NoteCreateError } from './create-contract.js';
import type { NoteInput, NoteReactionAcceptance, NoteVisibility } from './create-contract.js';

// INVALID_PARAM の info.param に schemaPath が出るため、本家 notes/create の paramDef を形ごと保つ。
const paramDef = {
	type: 'object',
	properties: {
		visibility: { type: 'string', enum: ['public', 'home', 'followers', 'specified'], default: 'public' },
		visibleUserIds: { type: 'array', uniqueItems: true, items: {
			type: 'string', format: 'misskey:id',
		} },
		cw: { type: 'string', nullable: true, minLength: 1, maxLength: 100 },
		localOnly: { type: 'boolean', default: false },
		reactionAcceptance: { type: 'string', nullable: true, enum: [null, 'likeOnly', 'likeOnlyForRemote', 'nonSensitiveOnly', 'nonSensitiveOnlyForLocalLikeOnlyForRemote'], default: null },
		noExtractMentions: { type: 'boolean', default: false },
		noExtractHashtags: { type: 'boolean', default: false },
		noExtractEmojis: { type: 'boolean', default: false },
		replyId: { type: 'string', format: 'misskey:id', nullable: true },
		renoteId: { type: 'string', format: 'misskey:id', nullable: true },
		channelId: { type: 'string', format: 'misskey:id', nullable: true },

		// anyOf内にバリデーションを書いても最初の一つしかチェックされない
		// See https://github.com/misskey-dev/misskey/pull/10082
		text: {
			type: 'string',
			minLength: 1,
			maxLength: 3000,
			nullable: true,
		},
		fileIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 1,
			maxItems: 16,
			items: { type: 'string', format: 'misskey:id' },
		},
		mediaIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 1,
			maxItems: 16,
			items: { type: 'string', format: 'misskey:id' },
		},
		poll: {
			type: 'object',
			nullable: true,
			properties: {
				choices: {
					type: 'array',
					uniqueItems: true,
					minItems: 2,
					maxItems: 10,
					items: { type: 'string', minLength: 1, maxLength: 50 },
				},
				multiple: { type: 'boolean' },
				expiresAt: { type: 'integer', nullable: true },
				expiredAfter: { type: 'integer', nullable: true, minimum: 1 },
			},
			required: ['choices'],
		},
	},
	// (re)note with text, files and poll are optional
	if: {
		properties: {
			renoteId: {
				type: 'null',
			},
			fileIds: {
				type: 'null',
			},
			mediaIds: {
				type: 'null',
			},
			poll: {
				type: 'null',
			},
		},
	},
	then: {
		properties: {
			text: {
				type: 'string',
				minLength: 1,
				maxLength: 3000,
				pattern: '[^\\s]+',
			},
		},
		required: ['text'],
	},
} as const;

const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const validate = ajv.compile(paramDef);

interface ValidatedInput {
	text?: string | null;
	cw?: string | null;
	visibility: NoteVisibility;
	localOnly: boolean;
	reactionAcceptance: NoteReactionAcceptance;
	visibleUserIds?: string[];
	noExtractMentions: boolean;
	noExtractHashtags: boolean;
	noExtractEmojis: boolean;
	replyId?: string | null;
	renoteId?: string | null;
	channelId?: string | null;
	fileIds?: string[];
	mediaIds?: string[];
	poll?: { choices: string[]; multiple?: boolean; expiresAt?: number | null; expiredAfter?: number | null } | null;
}

export function parseNoteInput(input: unknown, now: number): NoteInput {
	const value = structuredClone(input);
	if (!validate(value)) {
		const error = validate.errors![0];
		throw new NoteCreateError('INVALID_PARAM', { param: error.schemaPath, reason: error.message! });
	}
	const data = value as ValidatedInput;
	// 本家は expiresAt: 0 も期限なしとして扱うため、?? ではなく真偽で選ぶ。
	const poll = data.poll ? {
		choices: data.poll.choices,
		multiple: data.poll.multiple ?? false,
		expiresAtMs: data.poll.expiredAfter ? now + data.poll.expiredAfter : data.poll.expiresAt ? data.poll.expiresAt : null,
	} : null;
	return {
		text: data.text ?? null,
		cw: data.cw ?? null,
		visibility: data.visibility,
		localOnly: data.localOnly,
		reactionAcceptance: data.reactionAcceptance,
		fileIds: data.fileIds ?? data.mediaIds ?? [],
		poll,
		replyId: data.replyId ?? null,
		renoteId: data.renoteId ?? null,
		channelId: data.channelId ?? null,
		visibleUserIds: data.visibleUserIds ?? [],
		noExtractMentions: data.noExtractMentions,
		noExtractHashtags: data.noExtractHashtags,
		noExtractEmojis: data.noExtractEmojis,
	};
}
