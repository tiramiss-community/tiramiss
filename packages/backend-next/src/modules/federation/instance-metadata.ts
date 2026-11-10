/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import tinycolor from 'tinycolor2';
import type { InstancePatch } from './instance.js';

export interface InstanceMetadataTarget { id: string; host: string; }
export interface HtmlMetadata {
	links: { rel?: string; href?: string }[];
	themeColor?: string;
	name?: string;
	description?: string;
	ogDescription?: string;
}

// Remote values deliberately remain unvalidated: source forwards them to persistence.
interface NodeInfo {
	software?: { name?: unknown; version?: unknown };
	openRegistrations?: unknown;
	metadata?: { nodeName?: unknown; name?: unknown; nodeDescription?: unknown; description?: unknown; themeColor?: tinycolor.ColorInput; maintainer?: { name?: unknown; email?: unknown } };
}
interface Manifest { name?: unknown; short_name?: unknown; theme_color?: tinycolor.ColorInput; icons?: { src?: string }[]; }

export function selectNodeInfoUrl(wellknown: unknown): string {
	const links = (wellknown as { links?: { rel: string; href: string }[] }).links;
	if (!Array.isArray(links)) {
		throw new Error('No wellknown links');
	}
	const link1 = links.find(link => link.rel === 'http://nodeinfo.diaspora.software/ns/schema/1.0');
	const link2 = links.find(link => link.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.0');
	const link21 = links.find(link => link.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1');
	const link = link21 ?? link2 ?? link1;
	if (link == null) {
		throw new Error('No nodeinfo link provided');
	}
	return link.href;
}

export function metadataName(raw: unknown, html: HtmlMetadata | null, rawManifest: unknown): unknown {
	const info = raw as NodeInfo | null;
	if (info && info.metadata) {
		if (typeof info.metadata.nodeName === 'string') {
			return info.metadata.nodeName;
		} else if (typeof info.metadata.name === 'string') {
			return info.metadata.name;
		}
	}
	if (html?.name) {
		return html.name;
	}
	const manifest = rawManifest as Manifest | null;
	return manifest ? manifest.name ?? manifest.short_name : null;
}

export function metadataDescription(raw: unknown, html: HtmlMetadata | null, rawManifest: unknown): unknown {
	const info = raw as NodeInfo | null;
	if (info && info.metadata) {
		if (typeof info.metadata.nodeDescription === 'string') {
			return info.metadata.nodeDescription;
		} else if (typeof info.metadata.description === 'string') {
			return info.metadata.description;
		}
	}
	if (html?.description) {
		return html.description;
	}
	if (html?.ogDescription) {
		return html.ogDescription;
	}
	const manifest = rawManifest as Manifest | null;
	return manifest ? manifest.name ?? manifest.short_name : null;
}

export function metadataColor(raw: unknown, html: HtmlMetadata | null, rawManifest: unknown): string | null {
	const info = raw as NodeInfo | null;
	const manifest = rawManifest as Manifest | null;
	const value = info?.metadata?.themeColor ?? html?.themeColor ?? manifest?.theme_color;
	if (value) {
		const color = tinycolor(value);
		if (color.isValid()) {
			return color.toHexString();
		}
	}
	return null;
}

export function metadataFavicon(host: string, html: HtmlMetadata | null): string | null {
	const href = html ? [...html.links].reverse().find(link => link.rel === 'icon')?.href : undefined;
	return href ? new URL(href, `https://${host}`).href : null;
}

export function metadataIcon(host: string, html: HtmlMetadata | null, rawManifest: unknown): string | null {
	const manifest = rawManifest as Manifest | null;
	if (manifest && manifest.icons && manifest.icons.length > 0 && manifest.icons[0].src) {
		return new URL(manifest.icons[0].src, `https://${host}`).href;
	}
	if (html) {
		const links = [...html.links].reverse();
		const href = ['apple-touch-icon-precomposed', 'apple-touch-icon', 'icon'].map(rel => links.find(link => link.rel?.split(/\s+/).includes(rel))?.href).find(value => value);
		if (href) {
			return new URL(href, `https://${host}`).href;
		}
	}
	return null;
}

export function metadataPatch(raw: unknown, derived: { name: unknown; description: unknown; themeColor: string | null; icon: string | null; favicon: string | null }, nowMs: number): InstancePatch {
	const info = raw as NodeInfo | null;
	const patch: InstancePatch = { infoUpdatedAtMs: nowMs };
	if (info) {
		patch.softwareName = typeof info.software?.name === 'string' ? info.software.name.toLowerCase() : '?';
		patch.softwareVersion = info.software?.version;
		patch.openRegistrations = info.openRegistrations;
		patch.maintainerName = info.metadata?.maintainer?.name ?? null;
		patch.maintainerEmail = info.metadata?.maintainer?.email ?? null;
	}
	if (derived.name) {
		patch.name = derived.name;
	}
	if (derived.description) {
		patch.description = derived.description;
	}
	if (derived.icon ?? derived.favicon) {
		patch.iconUrl = derived.icon && !derived.icon.includes('data:image/png;base64') ? derived.icon : derived.favicon;
	}
	if (derived.favicon) {
		patch.faviconUrl = derived.favicon;
	}
	if (derived.themeColor) {
		patch.themeColor = derived.themeColor;
	}
	return patch;
}
