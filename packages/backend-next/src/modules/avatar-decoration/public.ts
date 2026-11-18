/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export interface AvatarDecoration {
	id: string;
	name: string;
	description: string;
	url: string;
	category: string | null;
	roleIdsThatCanBeUsedThisDecoration: string[];
}

export function createPublicAvatarDecorations(ports: {
	getAll(noCache?: boolean): Promise<AvatarDecoration[]>;
	readRoles(): Promise<readonly { id: string; isPublic?: boolean }[]>;
}) {
	return async (authenticated: boolean) => {
		// The pinned public endpoint explicitly refreshes the shared cache.
		const decorations = await ports.getAll(true);
		const roles = await ports.readRoles();
		const visible = new Set(roles.filter(role => authenticated || role.isPublic).map(role => role.id));
		return decorations.map(decoration => ({
			id: decoration.id,
			name: decoration.name,
			description: decoration.description,
			url: decoration.url,
			roleIdsThatCanBeUsedThisDecoration: decoration.roleIdsThatCanBeUsedThisDecoration.filter(id => visible.has(id)),
			category: decoration.category,
		}));
	};
}
