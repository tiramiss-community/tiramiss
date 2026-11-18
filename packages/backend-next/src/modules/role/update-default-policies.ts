/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { compileInput, requireCredential } from '../access/public.js';
import type { AccessFacts, AccessRequest } from '../access/public.js';
import type { ModerationLogEntry } from '../audit/public.js';
const parse = compileInput<{
	policies: Record<string, unknown>;
}>({
	type: 'object', properties: { policies: { type: 'object' } }, required: ['policies'],
});
export function createUpdateDefaultPolicies(dependencies: {
	authorizationFacts(actorId: string): Promise<AccessFacts>;
	readPolicies(): Promise<Record<string, unknown>>;
	replacePolicies(policies: Record<string, unknown>): Promise<void>;
	startPolicyNotification(policies: Record<string, unknown>): void;
	startAudit(entry: ModerationLogEntry): void;
	clock(): number;
}) {
	return {
		async updateDefaultPolicies(access: AccessRequest, input: unknown): Promise<void> {
			const actor = requireCredential(access.credential);
			access.authorize(await dependencies.authorizationFacts(actor.userId));
			const { policies } = parse(input);
			const before = await dependencies.readPolicies();
			await dependencies.replacePolicies(policies);
			const after = await dependencies.readPolicies();
			dependencies.startPolicyNotification(after);
			dependencies.startAudit({ actorId: actor.userId, type: 'updateServerSettings', info: { before, after }, occurredAtMs: dependencies.clock() });
		},
	};
}
