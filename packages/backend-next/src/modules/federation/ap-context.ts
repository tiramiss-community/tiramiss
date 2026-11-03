/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** 本家 core/activitypub/misc/contexts.ts の CONTEXT。受け手の JSON-LD 解釈と本文のキー順が本家と一致するよう、値と順をそのまま保つ。 */
export const apContext = [
	'https://www.w3.org/ns/activitystreams',
	'https://w3id.org/security/v1',
	{
		Key: 'sec:Key',
		manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
		sensitive: 'as:sensitive',
		Hashtag: 'as:Hashtag',
		quoteUrl: 'as:quoteUrl',
		toot: 'http://joinmastodon.org/ns#',
		Emoji: 'toot:Emoji',
		featured: 'toot:featured',
		discoverable: 'toot:discoverable',
		schema: 'http://schema.org#',
		PropertyValue: 'schema:PropertyValue',
		value: 'schema:value',
		misskey: 'https://misskey-hub.net/ns#',
		_misskey_content: 'misskey:_misskey_content',
		_misskey_quote: 'misskey:_misskey_quote',
		_misskey_reaction: 'misskey:_misskey_reaction',
		_misskey_votes: 'misskey:_misskey_votes',
		_misskey_summary: 'misskey:_misskey_summary',
		_misskey_followedMessage: 'misskey:_misskey_followedMessage',
		_misskey_requireSigninToViewContents: 'misskey:_misskey_requireSigninToViewContents',
		_misskey_makeNotesFollowersOnlyBefore: 'misskey:_misskey_makeNotesFollowersOnlyBefore',
		_misskey_makeNotesHiddenBefore: 'misskey:_misskey_makeNotesHiddenBefore',
		_misskey_license: 'misskey:_misskey_license',
		freeText: {
			'@id': 'misskey:freeText',
			'@type': 'schema:text',
		},
		isCat: 'misskey:isCat',
		vcard: 'http://www.w3.org/2006/vcard/ns#',
	},
] as const;
