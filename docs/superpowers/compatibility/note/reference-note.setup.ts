/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { init } from 'slacc';
import { setup as upstreamSetup, teardown as upstreamTeardown } from '../built-test/entry.js';
import type { TestProject } from 'vitest/node';

// The HTTP server lives in Vitest's main process, separately from the test worker.
export async function setup(project: TestProject) {
	init(1);
	await upstreamSetup(project);
}

export async function teardown() {
	await upstreamTeardown();
}
