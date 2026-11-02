/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import * as mfm from 'mfm-js';
import { NoteCreateError } from './create-contract.js';
import type { TextNoteInput } from './create-contract.js';

// Keep the pinned endpoint schema/error paths while related inputs are implemented in #170.
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

export function parseTextNoteInput(input: unknown): TextNoteInput {
	const value = structuredClone(input);
	if (!validate(value)) {
		const error = validate.errors![0];
		throw new NoteCreateError('INVALID_PARAM', { param: error.schemaPath, reason: error.message! });
	}
	const data = value as TextNoteInput & Record<string, unknown>;
	const related = ['replyId', 'renoteId', 'channelId', 'poll', 'fileIds', 'mediaIds'];
	if (related.some(key => data[key] != null) || data.visibleUserIds?.length) {
		throw new NoteCreateError('NOT_IMPLEMENTED');
	}
	const tokens = [...mfm.parse(data.text.trim()), ...mfm.parse(data.cw ?? '')];
	const extracted = mfm.extract(tokens, node =>
		(node.type === 'mention' && !data.noExtractMentions) ||
		(node.type === 'hashtag' && !data.noExtractHashtags) ||
		(node.type === 'emojiCode' && !data.noExtractEmojis));
	if (extracted.length > 0) {
		throw new NoteCreateError('NOT_IMPLEMENTED');
	}
	return data;
}
