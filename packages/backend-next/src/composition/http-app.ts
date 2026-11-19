/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Hono } from 'hono';
import { MiUserIp } from 'backend-upstream/entities';
import { apiIpLogging } from '../http/api-ip-log.js';
import { createApiIpLog } from '../platform/api-ip-log.js';
import { createNoteChartsApi, createUsersChartsApi } from '../http/note-charts-api.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { getAvatarImagesPath } from '../http/avatar-images-api.js';
import { createAvatarDecorationAdminHttp } from './avatar-decoration-admin-http.js';
import { createAvatarDecorationsHttp } from './avatar-decorations-http.js';
import { createHashtagCatalogHttp } from './hashtag-catalog-http.js';
import { createAnnouncementsHttp } from './announcements-http.js';
import { createPublicEmojisHttp } from './public-emojis-http.js';
import { createUserRelationHttp } from './user-relation-http.js';
import { createPromoHttp } from './promo-http.js';
import { createNoteTranslateHttp } from './note-translate-http.js';
import { createNotePersonalStateHttp } from './note-personal-state-http.js';
import { createUserMemoHttp } from './user-memo-http.js';
import { createPagesHttp } from './pages-http.js';
import { createDriveFilesHttp } from './drive-files-http.js';
import { createDriveFoldersHttp } from './drive-folders-http.js';
import { registerHttpAppWork } from './http-app-work.js';
import { createInstanceAdminHttp } from './instance-admin-http.js';
import { createUrlPreviewHttp } from './url-preview-http.js';
import { createPublicDocumentsHttp } from './public-documents-http.js';
import { createEmojiImagesHttp } from './emoji-images-http.js';
import { createAvatarImagesHttp } from './avatar-images-http.js';
import { createNodeInfoHttp } from './nodeinfo-http.js';
import { createWebfingerHttp } from './webfinger-http.js';
import { createFollowCollectionsHttp } from './follow-collections-http.js';
import { createOutboxHttp } from './outbox-http.js';
import { createEmojiHttp } from './emoji-http.js';
import { createAdminEmojisHttp } from './admin-emojis-http.js';
import { createFeaturedHttp } from './featured-http.js';
import { createActorHttp } from './actor-http.js';
import { prepareNoteRoutes, registerNoteRoutes } from './note-routes.js';
import { createRoleHttpApp } from './role-http.js';
import { createTestControlsHttp } from './test-controls-http.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig, queueApi?: Hono) {
	const note = prepareNoteRoutes(resources, config);
	const folders = createDriveFoldersHttp(resources, config);
	const pages = createPagesHttp(resources, config);
	const announcements = createAnnouncementsHttp(resources, config);
	const avatarDecorationAdmin = createAvatarDecorationAdminHttp(resources, config);
	const app = new Hono({ getPath: getAvatarImagesPath })
		.use('/api/*', apiIpLogging((userId, ip) => ipLog.record(userId, ip), config.trustProxy))
		.route('/', createUsersChartsApi(resources.noteCharts, { authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), logger: resources.logger }))
		.route('/', createNoteChartsApi(resources.noteCharts, { authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger), logger: resources.logger }))
		.route('/', createRoleHttpApp(resources, config))
		.route('/', createUserMemoHttp(resources, config))
		.route('/', createPromoHttp(resources, config))
		.route('/', createNoteTranslateHttp(resources, config))
		.route('/', createHashtagCatalogHttp(resources))
		.route('/', announcements.app)
		.route('/', createUserRelationHttp(resources))
		.route('/', createDriveFilesHttp(resources, config))
		.route('/', pages.app)
		.route('/', createActorHttp(resources, config))
		.route('/', createInstanceAdminHttp(resources))
		.route('/', createUrlPreviewHttp(resources))
		.route('/', createWebfingerHttp(resources, config))
		.route('/', createNodeInfoHttp(resources, config))
		.route('/', createFeaturedHttp(resources, config))
		.route('/', createFollowCollectionsHttp(resources, config))
		.route('/', createOutboxHttp(resources, config))
		.route('/', createEmojiHttp(resources, config))
		.route('/', createPublicEmojisHttp(resources))
		.route('/', createAdminEmojisHttp(resources, config))
		.route('/', createAvatarDecorationsHttp(resources))
		.route('/', avatarDecorationAdmin.app)
		.route('/', createPublicDocumentsHttp(resources, config))
		.route('/', createEmojiImagesHttp())
		.route('/', createAvatarImagesHttp(resources, config))
		.route('/', createNotePersonalStateHttp(resources, config))
		.route('/', folders.app);
	registerHttpAppWork(app, async () => {
		await Promise.all([folders.idle(), pages.idle(), announcements.idle(), avatarDecorationAdmin.idle(), ipLog.close()]);
	});
	registerNoteRoutes(app, resources, note);
	app.route('/', createTestControlsHttp(resources, config));
	if (queueApi) {
		app.route('/', queueApi);
	}
	const ipLog = createApiIpLog({
		enabled: async () => (await resources.meta.fetch()).enableIpLogging,
		insert: row => resources.dataSource.getRepository(MiUserIp).createQueryBuilder().insert().values(row).orIgnore(true).execute(),
		now: () => new Date(),
		onError: error => resources.logger.error('api.ip-log-failed', { error }),
	});
	return app;
}
