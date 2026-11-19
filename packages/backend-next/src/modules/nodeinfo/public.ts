/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { DEFAULT_POLICIES } from '../role/public.js';

export interface NodeInfoSettings {
	name: string | null;
	description: string | null;
	maintainerName: string | null;
	maintainerEmail: string | null;
	langs: string[];
	termsOfServiceUrl: string | null;
	privacyPolicyUrl: string | null;
	inquiryUrl: string | null;
	impressumUrl: string | null;
	repositoryUrl: string | null;
	feedbackUrl: string | null;
	disableRegistration: boolean;
	emailRequiredForSignup: boolean;
	enableHcaptcha: boolean;
	enableRecaptcha: boolean;
	enableMcaptcha: boolean;
	enableTurnstile: boolean;
	enableEmail: boolean;
	enableServiceWorker: boolean;
	themeColor: string | null;
	policies: Record<string, unknown>;
}

export function renderNodeInfo(input: {
	settings: NodeInfoSettings;
	version: '2.0' | '2.1';
	softwareVersion: string;
	localPosts: number;
	users: number;
	proxyAccountName: string;
}) {
	const meta = input.settings;
	const policies = { ...DEFAULT_POLICIES, ...meta.policies };
	return {
		software: {
			name: 'misskey', version: input.softwareVersion,
			homepage: input.version === '2.1' ? meta.repositoryUrl : 'https://misskey-hub.net',
			repository: meta.repositoryUrl,
		} as { name: string; version: string; homepage: string | null; repository?: string | null },
		protocols: ['activitypub'],
		services: { inbound: [] as string[], outbound: ['atom1.0', 'rss2.0'] },
		openRegistrations: !meta.disableRegistration,
		usage: { users: { total: input.users, activeHalfyear: null, activeMonth: null }, localPosts: input.localPosts, localComments: 0 },
		metadata: {
			nodeName: meta.name, nodeDescription: meta.description,
			nodeAdmins: [{ name: meta.maintainerName, email: meta.maintainerEmail }],
			maintainer: { name: meta.maintainerName, email: meta.maintainerEmail },
			langs: meta.langs, tosUrl: meta.termsOfServiceUrl, privacyPolicyUrl: meta.privacyPolicyUrl,
			inquiryUrl: meta.inquiryUrl, impressumUrl: meta.impressumUrl, repositoryUrl: meta.repositoryUrl, feedbackUrl: meta.feedbackUrl,
			disableRegistration: meta.disableRegistration,
			disableLocalTimeline: !policies.ltlAvailable, disableGlobalTimeline: !policies.gtlAvailable,
			emailRequiredForSignup: meta.emailRequiredForSignup,
			enableHcaptcha: meta.enableHcaptcha, enableRecaptcha: meta.enableRecaptcha,
			enableMcaptcha: meta.enableMcaptcha, enableTurnstile: meta.enableTurnstile,
			maxNoteTextLength: 3000, enableEmail: meta.enableEmail, enableServiceWorker: meta.enableServiceWorker,
			proxyAccountName: input.proxyAccountName, themeColor: meta.themeColor ?? '#86b300',
		},
	};
}

export function nodeInfoLinks(selfUrl: string) {
	return ['2.1', '2.0'].map(version => ({ rel: `http://nodeinfo.diaspora.software/ns/schema/${version}`, href: `${selfUrl}/nodeinfo/${version}` }));
}
