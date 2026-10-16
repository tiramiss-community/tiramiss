/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { startHttp } from '../processes/http.js';
import { runChild } from './run-child.js';
await runChild('http', startHttp);
