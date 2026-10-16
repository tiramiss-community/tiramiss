/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { startManagedProcess } from './lifecycle.js';
import type { RuntimeConfig } from '../config/types.js';
export function startWorker(config: RuntimeConfig) {
	// 実際のジョブの再開・失敗契約が決まる前に汎用キューを固定しないため、今は起動・停止だけ担う。
	return startManagedProcess('worker', config, async () => async () => {});
}
