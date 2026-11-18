/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { createUpdateDefaultPolicies } from '../../../src/modules/role/public.js';
import { createAccessRequest } from '../../../src/modules/access/public.js';
const source = readFileSync(new URL('../../fixtures/default-role-policies/update-default-policies.ts.txt', import.meta.url), 'utf8');
const javascript = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const declarations = source.slice(source.indexOf('export const meta ='), source.indexOf('@Injectable()')).replaceAll('export const', 'const');
const { meta, paramDef } = new Function(`${javascript(declarations)}; return { meta, paramDef };`)();
const validate = new Ajv({ useDefaults: true }).compile(paramDef);
const callback = source.slice(source.indexOf('async (ps, me) => {'), source.lastIndexOf('\n\t\t});'));
const makeSource = new Function(`${javascript(`const handler = ${callback};`)}; return handler;`);
const access = () => createAccessRequest({ requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' }, { userId: 'actor', native: true });
test('default-policy source and access contract are fixed to the upstream Git object', () => {
	expect(createHash('sha256').update(source).digest('hex')).toBe('fdd0403672d5f516064a4bbfc207541677dc81626f2d0d04b43a2c190d4c1ff1');
	expect(meta).toMatchObject({ requireCredential: true, requireAdmin: true, kind: 'write:admin:roles' });
});
test.each([
	{ policies: {} }, { policies: { canInvite: true } },
	{ policies: { canInvite: null, driveCapacityMb: '7', maxFileSizeMb: -1, unknown: ['x', 3] } },
	{ policies: { uploadableFileTypes: [null], chatAvailability: 'invalid' } },
	{}, { policies: null }, { policies: [] }, { policies: 'bad' },
])('input %j matches the literal endpoint validation, replacement and audit snapshots', async (input) => {
	let expected: Record<string, unknown> = { canInvite: false, driveCapacityMb: 55 };
	const sourceEffects: unknown[] = [];
	const pinned = makeSource.call({
		metaService: {
			fetch: async (fresh: boolean) => {
				expect(fresh).toBe(true);
				return { policies: structuredClone(expected) };
			},
			update: async (data: {
				policies: Record<string, unknown>;
			}) => {
				expected = structuredClone(data.policies);
			},
		},
		globalEventService: { publishInternalEvent: (type: string, body: object) => sourceEffects.push([type, body]) },
		moderationLogService: { log: (actor: object, type: string, info: object) => sourceEffects.push([actor, type, info]) },
	});
	let actual: Record<string, unknown> = structuredClone(expected);
	const effects: unknown[] = [];
	const application = createUpdateDefaultPolicies({
		authorizationFacts: async () => ({ isAdministrator: true, isModerator: true, isSuspended: false }),
		readPolicies: async () => structuredClone(actual), replacePolicies: async (value) => {
			actual = structuredClone(value);
		},
		startPolicyNotification: value => {
			effects.push(['policiesUpdated', value]);
		},
		startAudit: entry => {
			effects.push([{ id: entry.actorId }, entry.type, entry.info]);
		}, clock: () => 123,
	});
	if (!validate(input)) {
		await expect(application.updateDefaultPolicies(access(), input)).rejects.toMatchObject({ param: validate.errors![0].schemaPath, reason: validate.errors![0].message });
	} else {
		expect(await application.updateDefaultPolicies(access(), input)).toBe(await pinned(input, { id: 'actor' }));
	}
	expect(actual).toEqual(expected);
	expect(effects).toEqual(sourceEffects);
});
