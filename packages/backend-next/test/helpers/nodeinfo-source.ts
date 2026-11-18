/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import type { NodeInfoSettings } from '../../src/modules/nodeinfo/public.js';

export const nodeInfoSource = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/nodeinfo/observations.json', import.meta.url), 'utf8')) as {
	discovery: { federation: string; method: string; status: number; metaReads: number; headers: Record<string, string | null>; body: string }[];
	observations: {
		scenario: string;
		step: { path: string; method?: string; advance?: number; changed?: boolean; fault?: string };
		meta: Omit<NodeInfoSettings, 'policies'> & { federation: string; policies: { ltlAvailable?: boolean; gtlAvailable?: boolean } };
		status: number;
		headers: Record<string, string | null>;
		body: unknown;
		calls: unknown[][];
	}[];
};
