/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export { allowsPermission, type AccessCredential } from './credential.js';
export { AccessDenied, AuthenticationFailed, InputInvalid, type AccessDeniedReason } from './errors.js';
export { authorizeAccess, createAccessRequest, requireCredential, requiresCredential } from './authorize.js';
export type { AccessFacts, AccessRequest, AccessRequirement } from './authorize.js';
export { compileInput } from './input.js';
