/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';
import { toHtml } from '../mfm/public.js';
import { apContext } from './ap-context.js';
export interface LocalActorFacts {
	id: string;
	username: string;
	name: string | null;
	isBot: boolean;
	isLocked: boolean;
	isExplorable: boolean;
}
export interface LocalActorProfileFacts {
	description: string | null;
	followedMessage: string | null;
	fields: readonly { name: string; value: string; }[];
	birthday: string | null;
	location: string | null;
}

// Preserve the fixed source's leading URL match, raw label and suffix serialization.
function rewriteFieldUrl(value: string): string {
	const urlSafeRegex = /^(?:http[s]?:\/\/.)?(?:www\.)?[-a-zA-Z0-9@%._\+~#=]{2,256}\.[a-z]{2,6}\b(?:[-a-zA-Z0-9@:%_\+.~#?&\/\/=]*)/;
	try {
		const match = value.match(urlSafeRegex);
		if (!match) {
			return value;
		}
		const url = new URL(match[0]);
		return `<a href="${url.href}" rel="me nofollow noopener" target="_blank">${match[0]}</a>${value.slice(match[0].length)}`;
	} catch {
		return value;
	}
}

export function renderLocalActor(facts: LocalActorFacts, profile: LocalActorProfileFacts, selfUrl: string, publicKeyPem: string): Record<string, unknown> {
	const id = `${selfUrl}/users/${facts.id}`;
	const attachment = profile.fields.map(field => ({ type: 'PropertyValue', name: field.name,
		value: field.value.startsWith('http://') || field.value.startsWith('https://') ? rewriteFieldUrl(field.value) : field.value }));
	return {
		'@context': apContext, type: facts.username.includes('.') ? 'Application' : facts.isBot ? 'Service' : 'Person',
		id, inbox: `${id}/inbox`, outbox: `${id}/outbox`, followers: `${id}/followers`, following: `${id}/following`,
		sharedInbox: `${selfUrl}/inbox`, endpoints: { sharedInbox: `${selfUrl}/inbox` }, url: `${selfUrl}/@${facts.username}`,
		preferredUsername: facts.username, name: facts.name, manuallyApprovesFollowers: facts.isLocked, discoverable: facts.isExplorable,
		summary: profile.description ? toHtml(mfm.parse(profile.description), { selfUrl, mentionedRemoteUsers: [] }) : null,
		_misskey_summary: profile.description, _misskey_followedMessage: profile.followedMessage,
		attachment: attachment.length ? attachment : undefined,
		...(profile.birthday ? { 'vcard:bday': profile.birthday } : {}),
		...(profile.location ? { 'vcard:Address': profile.location } : {}),
		publicKey: { id: `${id}#main-key`, type: 'Key', owner: id, publicKeyPem },
	};
}
