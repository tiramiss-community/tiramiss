/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { workHash } from '../../../modules/post-work/prepare.js';

export type ApPagePayload = { after: null } | { after: string; previous: string };

export function pageTarget(after: string | null): string {
	return after === null ? 'start' : 'after:' + workHash(after);
}

export function parsePagePayload(payload: string, target: string): ApPagePayload | null {
	try {
		const value = JSON.parse(payload);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return null;
		}
		if (value.after === null) {
			return payload === '{"after":null}' && target === 'start' ? { after: null } : null;
		}
		if (typeof value.after !== 'string' || Buffer.byteLength(value.after) < 1 || Buffer.byteLength(value.after) > 2048
			|| value.after.includes('\u0000') || Buffer.from(value.after).toString('utf8') !== value.after
			|| typeof value.previous !== 'string' || !/^[a-f0-9]{64}$/.test(value.previous)
			|| target !== pageTarget(value.after)
			|| payload !== JSON.stringify({ after: value.after, previous: value.previous })) {
			return null;
		}
		return { after: value.after, previous: value.previous };
	} catch {
		return null;
	}
}
