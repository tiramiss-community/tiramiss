/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type { EvaluationRole, InstanceRoleFacts, RoleAssignment, RolePrivileges, UserRoleFacts } from './model.js';
export { evaluateCondition } from './condition.js';
export { selectApplicableRoles } from './applicable-roles.js';
export { evaluatePolicies, type PolicyInput } from './policies.js';
export { evaluatePrivileges } from './privileges.js';
export { DEFAULT_POLICIES, type RolePolicies } from './policy-defaults.js';
export { createAttemptEvaluation, createRequestEvaluation } from './evaluation.js';
export type { RoleEvaluation, RoleEvaluationSession, RoleFactsChange, RoleFactsReader } from './evaluation.js';
export { EvaluationClosed, EvaluationInvalidated } from './evaluation-memo.js';
export { createUpdateRole } from './update-role.js';
export type { RoleActor, RoleDefinition, RolePatch, RoleAuthorizationFacts, RoleUpdateScope, RoleChanges, RoleDefinitionsChanged } from './update-contract.js';
export { ActorSuspended, ActorNotFound, ModeratorRequired, AdministratorRequired, CredentialScopeDenied, RoleNotFound } from './errors.js';
export { createShowRole, type RoleShowData } from './show-role.js';
export { RoleInputInvalid } from './errors.js';
