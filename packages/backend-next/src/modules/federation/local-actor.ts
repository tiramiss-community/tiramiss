/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as mfm from 'mfm-js';
import { publicFileUrl } from '../drive/public.js';
import type { PublicFileFacts } from '../drive/public.js';
import { toHtml } from '../mfm/public.js';
import { apContext } from './ap-context.js';
import type { LocalActorTag } from './ap-tags.js';
export interface LocalActorFacts {
	id: string;
	avatarId: string | null;
	bannerId: string | null;
	username: string;
	name: string | null;
	isBot: boolean;
	isCat: boolean;
	requireSigninToViewContents: boolean;
	makeNotesFollowersOnlyBefore: number | null;
	makeNotesHiddenBefore: number | null;
	movedToUri: string | null;
	alsoKnownAs: readonly string[] | null;
	isLocked: boolean;
	isExplorable: boolean;
	emojis: readonly string[];
	tags: readonly string[];
}
export interface LocalActorProfileFacts {
	description: string | null;
	followedMessage: string | null;
	fields: readonly { name: string; value: string; }[];
	birthday: string | null;
	location: string | null;
}

export interface ActorFileFacts extends PublicFileFacts {
	isSensitive: boolean;
	comment: string | null;
}
export interface LocalActorMediaFacts {
	avatar: ActorFileFacts | null;
	banner: ActorFileFacts | null;
	iconUrl: string | null;
	bannerUrl: string | null;
	proxyRemoteFiles: boolean;
	mediaProxy: string;
	externalMediaProxyEnabled: boolean;
}
export interface LocalActorMaterials {
	profile: LocalActorProfileFacts;
	media: LocalActorMediaFacts;
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

export function renderLocalActor(facts: LocalActorFacts, profile: LocalActorProfileFacts, selfUrl: string, publicKeyPem: string, tag: readonly LocalActorTag[], media: LocalActorMediaFacts): Record<string, unknown> {
	const id = `${selfUrl}/users/${facts.id}`;
	const isSystem = facts.username.includes('.');
	const fallback = (url: string) => ({ type: 'Image', url, sensitive: false, name: null });
	const image = (file: ActorFileFacts) => ({ type: 'Image',
		url: publicFileUrl(file, media.proxyRemoteFiles, { url: selfUrl, mediaProxy: media.mediaProxy, externalMediaProxyEnabled: media.externalMediaProxyEnabled }),
		sensitive: file.isSensitive, name: file.comment });
	const attachment = profile.fields.map(field => ({ type: 'PropertyValue', name: field.name,
		value: field.value.startsWith('http://') || field.value.startsWith('https://') ? rewriteFieldUrl(field.value) : field.value }));
	return {
		'@context': apContext, type: isSystem ? 'Application' : facts.isBot ? 'Service' : 'Person',
		id, inbox: `${id}/inbox`, outbox: `${id}/outbox`, followers: `${id}/followers`, following: `${id}/following`,
		featured: `${id}/collections/featured`,
		sharedInbox: `${selfUrl}/inbox`, endpoints: { sharedInbox: `${selfUrl}/inbox` }, url: `${selfUrl}/@${facts.username}`,
		preferredUsername: facts.username, name: facts.name, manuallyApprovesFollowers: facts.isLocked, discoverable: facts.isExplorable,
		summary: profile.description ? toHtml(mfm.parse(profile.description), { selfUrl, mentionedRemoteUsers: [] }) : null,
		icon: media.avatar ? image(media.avatar) : fallback(isSystem && media.iconUrl != null ? media.iconUrl : `${selfUrl}/identicon/${facts.username.toLowerCase()}@${new URL(selfUrl).host}`),
		image: media.banner ? image(media.banner) : isSystem && media.bannerUrl != null ? fallback(media.bannerUrl) : null,
		tag,
		_misskey_summary: profile.description, _misskey_followedMessage: profile.followedMessage,
		isCat: facts.isCat,
		_misskey_requireSigninToViewContents: facts.requireSigninToViewContents,
		_misskey_makeNotesFollowersOnlyBefore: facts.makeNotesFollowersOnlyBefore,
		_misskey_makeNotesHiddenBefore: facts.makeNotesHiddenBefore,
		...(facts.movedToUri ? { movedTo: facts.movedToUri } : {}),
		...(facts.alsoKnownAs ? { alsoKnownAs: facts.alsoKnownAs } : {}),
		attachment: attachment.length ? attachment : undefined,
		...(profile.birthday ? { 'vcard:bday': profile.birthday } : {}),
		...(profile.location ? { 'vcard:Address': profile.location } : {}),
		publicKey: { id: `${id}#main-key`, type: 'Key', owner: id, publicKeyPem },
	};
}
