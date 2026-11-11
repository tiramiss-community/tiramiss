/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import type { LocalWebfingerDocument, LocalWebfingerFacts, LocalWebfingerQuery } from '../../src/modules/federation/public.js';
type SourceRow = LocalWebfingerFacts & { host: string | null; isSuspended: boolean; isDeleted?: boolean };
interface SourceCase {
	id: string;
	resource: string | null;
	queryString?: string;
	method?: 'GET' | 'HEAD' | 'OPTIONS';
	federation?: string;
	accept?: string;
	fail?: boolean;
	metaFail?: boolean;
	row?: Partial<SourceRow>;
	expected: { status: number; query: LocalWebfingerQuery | null; format: 'jrd' | 'xrd' | null; body?: string };
}
export const webfingerCorpus = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/remote-user/local-webfinger-corpus.json', import.meta.url), 'utf8')) as {
	defaults: { selfUrl: string; row: SourceRow; jrd: LocalWebfingerDocument; xrd: string };
	cases: SourceCase[];
};
export const webfingerSource = JSON.parse(readFileSync(new URL('../../../../docs/superpowers/compatibility/remote-user/local-webfinger-observations.json', import.meta.url), 'utf8')) as {
	cases: { id: string; status: number; lookups: LocalWebfingerQuery[]; headers: Record<string, string | null>; body: unknown }[];
};
