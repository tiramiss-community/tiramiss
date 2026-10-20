/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { loadConfig } from '../../built/config/load-config.js';
import { connectResources } from '../../built/platform/connect-resources.js';
import { createLogger } from '../../built/platform/logger.js';
import { createRoleHttpApp } from '../../built/composition/role-http.js';
import { listenHttp } from '../../built/processes/http.js';

const config = await loadConfig();
const resources = await connectResources(config, createLogger('test'));
resources.roleMaterials.changes.publish = async () => {
	process.send?.({ type: 'before-publish' });
	await new Promise(() => {});
};
await listenHttp(createRoleHttpApp(resources, config), config.http);
process.send?.({ type: 'ready' });
