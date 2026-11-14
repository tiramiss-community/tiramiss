/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createInstanceAdminHttp } from './instance-admin-http.js';
import { createWebfingerHttp } from './webfinger-http.js';
import { createFollowCollectionsHttp } from './follow-collections-http.js';
import { createOutboxHttp } from './outbox-http.js';
import { createFeaturedHttp } from './featured-http.js';
import { createActorHttp } from './actor-http.js';
import { prepareNoteRoutes, registerNoteRoutes } from './note-routes.js';
import { createRoleHttpApp } from './role-http.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';
import type { Hono } from 'hono';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig, queueApi?: Hono) {
	const note = prepareNoteRoutes(resources, config);
	const app = createRoleHttpApp(resources, config)
		.route('/', createActorHttp(resources, config))
		.route('/', createInstanceAdminHttp(resources))
		.route('/', createWebfingerHttp(resources, config))
		.route('/', createFeaturedHttp(resources, config))
		.route('/', createFollowCollectionsHttp(resources, config))
		.route('/', createOutboxHttp(resources, config));
	registerNoteRoutes(app, resources, note);
	if (queueApi) {
		app.route('/', queueApi);
	}
	return app;
}
