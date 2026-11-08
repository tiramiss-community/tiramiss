/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createQueueEndpoints } from '../../../src/http/queue-api.js';
import { createRoleEndpoints } from '../../../src/http/role-api.js';
import type { ApiEndpoint } from '../../../src/http/api-endpoint.js';
import type { createQueueAdmin } from '../../../src/modules/queue/public.js';

// 固定本家のendpoint metaから抜き出した認可要件。gateへ登録する全endpointをここで照合する。
const upstream = JSON.parse(readFileSync(new URL('../../../../../docs/superpowers/compatibility/api-common/endpoint-access.json', import.meta.url), 'utf8')) as {
	upstreamCommit: string;
	endpoints: { name: string; access: object }[];
};

const unused = async () => {
	throw new Error('not called');
};
const registered: ApiEndpoint[] = [
	...createRoleEndpoints({ showRole: unused, updateRole: unused }),
	...createQueueEndpoints({ execute: unused, idle: unused } as unknown as ReturnType<typeof createQueueAdmin>),
];

test('every gate endpoint declares exactly the pinned upstream access requirement', () => {
	expect(upstream.upstreamCommit).toBe('8e07cf085adf7009583d234a208e30436f020e26');
	const actual = registered.map(endpoint => ({ name: endpoint.name, access: endpoint.access })).sort((a, b) => a.name.localeCompare(b.name));
	expect(actual).toEqual(upstream.endpoints);
});
