/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { apContext } from './ap-context.js';
export interface LocalActorFacts {
	id: string;
	username: string;
	name: string | null;
	isBot: boolean;
	isLocked: boolean;
	isExplorable: boolean;
}
export function renderLocalActor(facts: LocalActorFacts, selfUrl: string, publicKeyPem: string): Record<string, unknown> {
	const id = `${selfUrl}/users/${facts.id}`;
	return {
		'@context': apContext, type: facts.username.includes('.') ? 'Application' : facts.isBot ? 'Service' : 'Person',
		id, inbox: `${id}/inbox`, outbox: `${id}/outbox`, followers: `${id}/followers`, following: `${id}/following`,
		sharedInbox: `${selfUrl}/inbox`, endpoints: { sharedInbox: `${selfUrl}/inbox` }, url: `${selfUrl}/@${facts.username}`,
		preferredUsername: facts.username, name: facts.name, manuallyApprovesFollowers: facts.isLocked, discoverable: facts.isExplorable,
		publicKey: { id: `${id}#main-key`, type: 'Key', owner: id, publicKeyPem },
	};
}
