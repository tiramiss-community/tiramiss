/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type AccessDeniedReason =
	| 'CREDENTIAL_REQUIRED'
	| 'YOUR_ACCOUNT_SUSPENDED'
	| 'MODERATOR_REQUIRED'
	| 'ADMINISTRATOR_REQUIRED'
	| 'PERMISSION_DENIED';

export class AccessDenied extends Error {
	constructor(readonly reason: AccessDeniedReason) {
		super(reason);
	}
}

export class AuthenticationFailed extends Error {}

export class InputInvalid extends Error {
	constructor(readonly param: string, readonly reason: string) {
		super('Invalid param.');
	}
}
