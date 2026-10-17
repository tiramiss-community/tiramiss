/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class ActorSuspended extends Error {}
export class ActorNotFound extends Error {}
export class ModeratorRequired extends Error {}
export class AdministratorRequired extends Error {}
export class CredentialScopeDenied extends Error {}
export class RoleNotFound extends Error {}
