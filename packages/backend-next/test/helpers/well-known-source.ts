/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';

export const wellKnownSource = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/well-known/observations.json', import.meta.url), 'utf8')) as {
	cases: {
		url: string;
		federation: string;
		path: string;
		method: string;
		status: number;
		headers: Record<string, string | null>;
		body: string | null;
		metaReads: number;
	}[];
};
