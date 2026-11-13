/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { LocalActorFacts, LocalActorMediaFacts } from '../../src/modules/federation/public.js';
export const emptyActorFields: Pick<LocalActorFacts, 'isCat' | 'requireSigninToViewContents' | 'makeNotesFollowersOnlyBefore' | 'makeNotesHiddenBefore' | 'movedToUri' | 'alsoKnownAs'> = {
	isCat: false, requireSigninToViewContents: false,
	makeNotesFollowersOnlyBefore: null, makeNotesHiddenBefore: null, movedToUri: null, alsoKnownAs: null,
};
export const emptyActorMedia: LocalActorMediaFacts = {
	avatar: null, banner: null, iconUrl: null, bannerUrl: null,
	proxyRemoteFiles: false, mediaProxy: 'https://local.test/proxy', externalMediaProxyEnabled: false,
};
