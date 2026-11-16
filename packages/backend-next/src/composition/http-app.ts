/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { getAvatarImagesPath } from '../http/avatar-images-api.js';
import { createPublicEmojisHttp } from './public-emojis-http.js';
import { createDriveFilesHttp } from './drive-files-http.js';
import { createDriveFoldersHttp } from './drive-folders-http.js';
import { registerHttpAppWork } from './http-app-work.js';
import { createInstanceAdminHttp } from './instance-admin-http.js';
import { createUrlPreviewHttp } from './url-preview-http.js';
import { createPublicDocumentsHttp } from './public-documents-http.js';
import { createEmojiImagesHttp } from './emoji-images-http.js';
import { createAvatarImagesHttp } from './avatar-images-http.js';
import { createWebfingerHttp } from './webfinger-http.js';
import { createFollowCollectionsHttp } from './follow-collections-http.js';
import { createOutboxHttp } from './outbox-http.js';
import { createEmojiHttp } from './emoji-http.js';
import { createFeaturedHttp } from './featured-http.js';
import { createActorHttp } from './actor-http.js';
import { prepareNoteRoutes, registerNoteRoutes } from './note-routes.js';
import { createRoleHttpApp } from './role-http.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig, queueApi?: Hono) {
	const note = prepareNoteRoutes(resources, config);
	const folders = createDriveFoldersHttp(resources, config);
	const app = new Hono({ getPath: getAvatarImagesPath })
		.route('/', createRoleHttpApp(resources, config))
		.route('/', createDriveFilesHttp(resources, config))
		.route('/', createActorHttp(resources, config))
		.route('/', createInstanceAdminHttp(resources))
		.route('/', createUrlPreviewHttp(resources))
		.route('/', createWebfingerHttp(resources, config))
		.route('/', createFeaturedHttp(resources, config))
		.route('/', createFollowCollectionsHttp(resources, config))
		.route('/', createOutboxHttp(resources, config))
		.route('/', createEmojiHttp(resources, config))
		.route('/', createPublicEmojisHttp(resources))
		.route('/', createPublicDocumentsHttp(resources, config))
		.route('/', createEmojiImagesHttp())
		.route('/', createAvatarImagesHttp(resources, config))
		.route('/', folders.app);
	registerHttpAppWork(app, folders.idle);
	registerNoteRoutes(app, resources, note);
	if (queueApi) {
		app.route('/', queueApi);
	}
	return app;
}
