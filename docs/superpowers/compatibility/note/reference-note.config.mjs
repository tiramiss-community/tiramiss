/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mergeConfig } from 'vitest/config';
import upstream from './vitest.config.e2e.ts';

export default mergeConfig(upstream, {
	test: { globalSetup: './test/note-setup.ts', include: ['./test/e2e/note-contract.ts'] },
});
