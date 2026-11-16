/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createPublicDocumentsApi } from '../http/public-documents-api.js';
import type { RuntimeConfig } from '../config/types.js';
import type { RuntimeResources } from './create-runtime.js';

export function createPublicDocumentsHttp(resources: Pick<RuntimeResources, 'meta'>, config: Pick<RuntimeConfig, 'url'>) {
	return createPublicDocumentsApi({ readSettings: resources.meta.fetch, url: config.url });
}
