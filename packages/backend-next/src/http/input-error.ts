/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class ApiInputInvalid extends Error {
	constructor(public readonly param: string, public readonly reason: string) {
		super('Invalid param.');
	}
}
