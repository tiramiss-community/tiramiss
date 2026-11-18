/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type LocalWebfingerQuery = { id: string } | { usernameLower: string };
export type LocalWebfingerFacts = { id: string; username: string };
export type LocalWebfingerDocument = {
	subject: string;
	links: [
		{ rel: 'self'; type: 'application/activity+json'; href: string },
		{ rel: 'http://webfinger.net/rel/profile-page'; type: 'text/html'; href: string },
		{ rel: 'http://ostatus.org/schema/1.0/subscribe'; template: string },
	];
};

export function localWebfingerQuery(resource: string, selfUrl: string): LocalWebfingerQuery | null {
	const lower = resource.toLowerCase();
	if (lower.startsWith(`${selfUrl.toLowerCase()}/users/`)) {
		return { id: lower.split('/').pop()! };
	}
	let acct = lower.startsWith(`${selfUrl.toLowerCase()}/@`) ? lower.split('/').pop()! : lower.startsWith('acct:') ? lower.slice(5) : lower;
	if (acct.startsWith('@')) {
		acct = acct.substring(1);
	}
	const [username, host] = acct.split('@', 2);
	return !host || host === new URL(selfUrl).host.toLowerCase() ? { usernameLower: username.toLowerCase() } : null;
}

export function renderLocalWebfinger(user: LocalWebfingerFacts, selfUrl: string): LocalWebfingerDocument {
	return {
		subject: `acct:${user.username}@${new URL(selfUrl).host}`,
		links: [
			{ rel: 'self', type: 'application/activity+json', href: `${selfUrl}/users/${user.id}` },
			{ rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `${selfUrl}/@${user.username}` },
			{ rel: 'http://ostatus.org/schema/1.0/subscribe', template: `${selfUrl}/authorize-follow?acct={uri}` },
		],
	};
}

const xmlMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' };

// Preserve pinned misc/prelude/xml quirks: attributes replace the first occurrence,
// while values escape every map character and skip the end-of-CDATA token.
function escapeAttribute(value: string): string {
	return Object.entries(xmlMap).reduce((result, [key, replacement]) => result.replace(key, replacement), value);
}

function escapeValue(value: string): string {
	let result = '';
	for (let i = 0; i < value.length;) {
		if (value.slice(i, i + 3) === ']]>') {
			i += 3;
		} else {
			const character = value[i++];
			result += xmlMap[character] || character;
		}
	}
	return result;
}

export function renderWebfingerXrd(document: LocalWebfingerDocument): string {
	const links = document.links.map(link => `<Link${Object.entries(link).map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('')}/>`).join('');
	return `<?xml version="1.0" encoding="UTF-8"?><XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Subject>${escapeValue(document.subject)}</Subject>${links}</XRD>`;
}
