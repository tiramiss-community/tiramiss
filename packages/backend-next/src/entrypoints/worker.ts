/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { startWorker } from '../processes/worker.js';
import { runChild } from './run-child.js';
await runChild('worker', startWorker);
