/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createUrlPreviewApi } from '../http/url-preview-api.js';
import type { RuntimeResources } from './create-runtime.js';

export function createUrlPreviewHttp(resources: Pick<RuntimeResources, 'urlPreview'>) {
	return createUrlPreviewApi(resources.urlPreview);
}
