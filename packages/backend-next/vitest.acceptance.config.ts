/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { defineConfig } from 'vitest/config';
import integration from './vitest.integration.config.js';

export default defineConfig({
	test: { ...integration.test, exclude: [], include: ['test/integration/role-acceptance.test.ts', 'test/integration/role-http.test.ts'] },
});
