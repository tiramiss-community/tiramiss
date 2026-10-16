/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/** Diagnostics created by our own adapters, with explicitly selected safe fields. */
export class DiagnosticError extends Error {
	readonly name = 'DiagnosticError';
	constructor(
		readonly code: string,
		readonly details: Record<string, unknown>,
	) {
		super(code);
	}
}
