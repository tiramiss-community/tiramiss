/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createAnnouncements } from '../modules/announcement/public.js';
import { createAnnouncementEndpoints } from '../http/announcements-api.js';
import { createApiEndpoints } from '../http/api-endpoint.js';
import { createTokenAuthenticator } from '../platform/database/authenticate.js';
import { createAnnouncementStore } from '../platform/database/announcements.js';
import { createAnnouncementPublisher } from '../platform/announcement-publisher.js';
import { createIdCodec } from '../platform/id-codec.js';
import type { RuntimeResources } from './create-runtime.js';
import type { RuntimeConfig } from '../config/types.js';

export function createAnnouncementsHttp(resources: Pick<RuntimeResources, 'dataSource' | 'logger' | 'postingStream'>, config: RuntimeConfig) {
	const ids = createIdCodec(config.id);
	const publisher = createAnnouncementPublisher(userId => resources.postingStream.main(userId, 'readAllAnnouncements'), resources.logger);
	const application = createAnnouncements({
		...createAnnouncementStore(resources.dataSource.manager),
		newId: () => ids.newId(Date.now()), createdAtFromId: ids.createdAtFromId, idFromDate: ids.newId, now: () => new Date(),
		readAll: publisher.publish,
	});
	const app = createApiEndpoints({
		authenticate: createTokenAuthenticator(resources.dataSource.manager, resources.logger),
		endpoints: createAnnouncementEndpoints(application), logger: resources.logger,
	});
	return { app, idle: publisher.idle };
}
