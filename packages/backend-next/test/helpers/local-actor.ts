/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { LocalActorMediaFacts } from '../../src/modules/federation/public.js';
export const emptyActorMedia: LocalActorMediaFacts = {
	avatar: null, banner: null, iconUrl: null, bannerUrl: null,
	proxyRemoteFiles: false, mediaProxy: 'https://local.test/proxy', externalMediaProxyEnabled: false,
};
