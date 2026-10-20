/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Ajv } from 'ajv';
import { RoleInputInvalid } from './errors.js';
import type { RolePatch } from './update-contract.js';

const properties = {
	roleId: { type: 'string', format: 'misskey:id' },
	name: { type: 'string' }, description: { type: 'string' },
	color: { type: 'string', nullable: true }, iconUrl: { type: 'string', nullable: true },
	target: { type: 'string', enum: ['manual', 'conditional'] }, condFormula: { type: 'object' },
	isPublic: { type: 'boolean' }, isModerator: { type: 'boolean' }, isAdministrator: { type: 'boolean' },
	isExplorable: { type: 'boolean' }, asBadge: { type: 'boolean' },
	preserveAssignmentOnMoveAccount: { type: 'boolean' }, canEditMembersByModerator: { type: 'boolean' },
	displayOrder: { type: 'number' }, policies: { type: 'object' },
};
const ajv = new Ajv({ useDefaults: true });
ajv.addFormat('misskey:id', /^[a-zA-Z0-9]+$/);
const schema = (fields: object) => ({ type: 'object', properties: fields, required: ['roleId'] });
const validators = { show: ajv.compile(schema({ roleId: properties.roleId })), update: ajv.compile(schema(properties)) };

export function parseRoleInput(input: unknown, operation: 'show' | 'update'): { roleId: string; patch: RolePatch } {
	const validate = validators[operation];
	if (!validate(input)) {
		const error = validate.errors![0];
		throw new RoleInputInvalid(error.schemaPath, error.message!);
	}

	const data = input as Record<string, unknown> & { roleId: string };
	const patch = Object.fromEntries(Object.keys(properties)
		.filter(key => key !== 'roleId' && Object.hasOwn(data, key) && data[key] !== undefined)
		.map(key => [key, data[key]])) as RolePatch;
	return { roleId: data.roleId, patch };
}

export function prepareRoleInput(input: unknown, operation: 'show' | 'update'): () => { roleId: string; patch: RolePatch } {
 const fields = operation === 'show' ? ['roleId'] : Object.keys(properties);
 const selected = input !== null && typeof input === 'object' && !Array.isArray(input)
  ? Object.fromEntries(fields.filter(key => Object.hasOwn(input, key))
   .map(key => [key, (input as Record<string, unknown>)[key]]))
  : input;
 try {
  // 未知の入力は無視する。コピーの失敗も、サスペンド・資格・scopeの拒否より先に返さない。
  const snapshot = structuredClone(selected);
  return () => parseRoleInput(snapshot, operation);
 } catch (error) {
  return () => {
   parseRoleInput(selected, operation);
   throw error;
  };
 }
}
