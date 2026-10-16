/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type ProcessRole = 'http' | 'worker';
export interface ReadyMessage {
	type: 'ready';
	role: ProcessRole;
}
export function isReadyMessage(value: unknown, role: ProcessRole): value is ReadyMessage {
	return (
		!!value &&
		typeof value === 'object' &&
		'type' in value &&
		value.type === 'ready' &&
		'role' in value &&
		value.role === role
	);
}
