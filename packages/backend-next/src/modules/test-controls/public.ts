/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput } from '../access/public.js';

export const validateTestInput = compileInput<Record<string, unknown>>({
	type: 'object',
	properties: {
		required: { type: 'boolean' }, string: { type: 'string' },
		default: { type: 'string', default: 'hello' },
		nullableDefault: { type: 'string', nullable: true, default: 'hello' },
		id: { type: 'string', format: 'misskey:id' },
	},
	required: ['required'],
});

export const validateResetInput = compileInput<Record<string, unknown>>({ type: 'object', properties: {}, required: [] });
