/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from 'vitest';
import { createApiEndpoints } from '../../../src/http/api-endpoint.js';

test('GET preserves duplicate query value order and keeps arrays local to each request', async () => {
	const app = createApiEndpoints({
		endpoints: [{ name: 'test/query', allowGet: true, access: {}, handle: async (_access, input) => input }],
		authenticate: async () => null,
		logger: { info() {}, error() {} },
	});
	const values = Array.from({ length: 1000 }, (_, index) => `value${index}`);
	const response = await app.request('/api/test/query?single=first&' + values.map(value => `value=${value}`).join('&'));
	expect(await response.json()).toEqual({ single: 'first', value: values });
	const next = await app.request('/api/test/query?value=new&other=middle&value=last');
	expect(await next.json()).toEqual({ value: ['new', 'last'], other: 'middle' });
});
