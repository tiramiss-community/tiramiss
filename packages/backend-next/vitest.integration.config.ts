/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: {
		include: ['test/integration/**/*.test.ts'],
		testTimeout: 120000,
		hookTimeout: 120000,
		fileParallelism: false,
	},
});
