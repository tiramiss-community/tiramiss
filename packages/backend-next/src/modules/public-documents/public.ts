/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface PublicDocumentSettings {
	name: string | null;
	shortName: string | null;
	themeColor: string | null;
	app192IconUrl: string | null;
	app512IconUrl: string | null;
	manifestJsonOverride: string;
	ugcVisibilityForVisitor: 'all' | 'local' | 'none';
}

export function renderManifest(meta: PublicDocumentSettings, host: string): Record<string, unknown> {
	// These fallbacks deliberately include empty strings, as in the pinned client server.
	/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
	const manifest = {
		short_name: meta.shortName || meta.name || host,
		name: meta.name || host,
		start_url: '/',
		display: 'standalone',
		background_color: '#313a42',
		theme_color: meta.themeColor || '#86b300',
		icons: [{
			src: meta.app192IconUrl || '/static-assets/icons/192.png',
			sizes: '192x192',
			type: 'image/png',
			purpose: 'maskable',
		}, {
			src: meta.app512IconUrl || '/static-assets/icons/512.png',
			sizes: '512x512',
			type: 'image/png',
			purpose: 'maskable',
		}, {
			src: '/static-assets/splash.png',
			sizes: '300x300',
			type: 'image/png',
			purpose: 'any',
		}],
		share_target: {
			action: '/share/',
			method: 'GET',
			enctype: 'application/x-www-form-urlencoded',
			params: { title: 'title', text: 'text', url: 'url' },
		},
		shortcuts: [{ name: 'Safemode', url: '/?safemode=true' }],
	};
	/* eslint-enable @typescript-eslint/prefer-nullish-coalescing */
	// Source accepts every JSON value and merges only its enumerable top-level properties.
	return { ...manifest, ...JSON.parse(meta.manifestJsonOverride === '' ? '{}' : meta.manifestJsonOverride) };
}

export function renderRobots(meta: Pick<PublicDocumentSettings, 'ugcVisibilityForVisitor'>): string {
	const disallowedPaths = ['/settings', '/admin', '/custom-emojis-manager', '/avatar-decorations', '/share', '/my', '/api', '/inbox', '/oauth', '/proxy', '/url'];
	if (meta.ugcVisibilityForVisitor === 'none') {
		disallowedPaths.push('/@', '/notes');
	}
	return `User-agent: *\n${disallowedPaths.map(path => `Disallow: ${path}`).join('\n')}\nAllow: /\n\n# todo: sitemap\n`;
}

export function renderOpenSearch(meta: Pick<PublicDocumentSettings, 'name'>, url: string): string {
	const name = meta.name ?? 'Misskey';
	// Keep source interpolation, including unescaped XML characters, for compatibility.
	return '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">' +
		`<ShortName>${name}</ShortName><Description>${name} Search</Description>` +
		'<InputEncoding>UTF-8</InputEncoding>' +
		`<Image width="16" height="16" type="image/x-icon">${url}/favicon.ico</Image>` +
		`<Url type="text/html" template="${url}/search?q={searchTerms}"/>` +
		'</OpenSearchDescription>';
}
