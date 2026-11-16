/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { runChild } from '../../built/entrypoints/run-child.js';
import { startManagedProcess } from '../../built/processes/lifecycle.js';

// Explicit startup consumer: the normal HTTP entrypoint deliberately reads Meta lazily.
await runChild('http', config => startManagedProcess('http', config, async resources => {
	await resources.meta.fetch();
	return async () => {};
}));
